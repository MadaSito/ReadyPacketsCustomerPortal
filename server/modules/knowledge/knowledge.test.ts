import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { UserRole } from "../../../shared/domain.js";
import { conflict } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Db, SessionPrincipal } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import { createEngagementModule, type EngagementModule } from "../engagement/index.js";
import * as engagementTables from "../engagement/schema.js";
import type { StagedUpload } from "../files/index.js";
import { users, type UserStatus } from "../identity/schema.js";
import * as orderTables from "../orders/schema.js";
import { platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import type { ApiCaller, PublicApiProviders } from "../publicApi/ports.js";
import { createTrashRegistry, unfencedPurgeRunForTests, type TrashRegistry } from "../trash/ports.js";
import {
  createKnowledgeModule,
  KNOWLEDGE_RETENTION_JOB,
  knowledgeRouter,
  type KnowledgeModule,
} from "./index.js";
import * as knowledgeTables from "./schema.js";

const testSchema = {
  users,
  platformSettings,
  ...orderTables,
  ...engagementTables,
  ...knowledgeTables,
};

const appTestRouter = router({ knowledge: knowledgeRouter });
const createCaller = createCallerFactory(appTestRouter);

interface SyntheticUser {
  id: number;
  publicId: string;
  email: string;
  role: UserRole;
  principal: SessionPrincipal;
}

let userSeq = 0;

async function insertSyntheticUser(
  h: TestHarness,
  db: Db,
  opts: {
    role?: UserRole;
    status?: UserStatus;
    stepUp?: boolean;
  } = {},
): Promise<SyntheticUser> {
  userSeq += 1;
  const publicId = ulid(h.clock.now().getTime() + userSeq);
  const role = opts.role ?? "customer";
  const email = `kb.user.${userSeq}@synthetic.test`;
  const name = `KB Person ${userSeq}`;

  await db.insert(users).values({
    publicId,
    customerRef: role === "customer" ? `CUST-KB-${String(userSeq).padStart(4, "0")}` : null,
    role,
    status: opts.status ?? "active",
    emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
    emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
    emailVerifiedAt: h.clock.now(),
    nameEnc: h.deps.crypto.encrypt(name, `users.name:${publicId}`),
  });
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, publicId));

  const principal = fakePrincipal({
    userId: row!.id,
    userPublicId: publicId,
    role,
    stepUpAt: opts.stepUp ? h.clock.now() : null,
  });

  return { id: row!.id, publicId, email, role, principal };
}

async function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("knowledge module (Package F) + Public API v1 providers (knowledge & tickets)", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let knowledge: KnowledgeModule;
  let engagement: EngagementModule;
  let registeredProviders: Partial<PublicApiProviders>;
  let trashRegistry: TrashRegistry;

  let adminStepUp: SyntheticUser;
  let adminNoStepUp: SyntheticUser;
  let staff: SyntheticUser;
  let aliceCustomer: SyntheticUser;
  let bobCustomer: SyntheticUser;

  const callerFor = (session: SessionPrincipal | null) =>
    createCaller({
      services: h.services,
      session,
      request: newRequestContext("test"),
      transport: { issue() {}, clear() {} },
    } satisfies TrpcContext);

  beforeAll(async () => {
    tdb = await createTestDb({ schema: testSchema });
    h = createTestDeps({ db: tdb.db });
    h.deps.settings = createSettingsStore({
      db: tdb.db,
      clock: h.clock,
      logger: h.deps.logger,
      crypto: h.deps.crypto,
      audit: h.deps.audit,
    });
    registeredProviders = {};
    trashRegistry = createTrashRegistry();
    (h.services as unknown as { trash: TrashRegistry }).trash = trashRegistry;

    (
      h.services as unknown as {
        publicApi: {
          registerProvider: <K extends keyof PublicApiProviders>(
            key: K,
            provider: PublicApiProviders[K],
          ) => void;
        };
      }
    ).publicApi = {
      registerProvider(key, provider) {
        registeredProviders[key] = provider;
      },
    };

    knowledge = createKnowledgeModule(h.deps);
    (h.services as unknown as { knowledge: KnowledgeModule }).knowledge = knowledge;
    knowledge.init?.();

    engagement = createEngagementModule(h.deps);
    h.services.engagement = engagement;
    engagement.init?.();

    adminStepUp = await insertSyntheticUser(h, tdb.db, { role: "admin", stepUp: true });
    adminNoStepUp = await insertSyntheticUser(h, tdb.db, { role: "admin", stepUp: false });
    staff = await insertSyntheticUser(h, tdb.db, { role: "staff" });
    aliceCustomer = await insertSyntheticUser(h, tdb.db, { role: "customer" });
    bobCustomer = await insertSyntheticUser(h, tdb.db, { role: "customer" });
  });

  afterAll(async () => {
    await tdb?.cleanup();
  });

  it("ships disabled by default (`feature.knowledge = false`) and refuses customer & publicApi reads while allowing staff authoring", async () => {
    expect(await knowledge.enabled()).toBe(false);

    const custStatus = await callerFor(aliceCustomer.principal).knowledge.status();
    expect(custStatus).toEqual({
      enabled: false,
      canManage: false,
      canConfigure: false,
    });

    await expect(callerFor(aliceCustomer.principal).knowledge.help.home()).rejects.toThrow();
    await expect(
      callerFor(aliceCustomer.principal).knowledge.help.search({ q: "packet" }),
    ).rejects.toThrow();

    const apiCaller: ApiCaller = {
      kind: "api_key",
      keyPublicId: ulid(),
      scopes: ["knowledge:read"],
      requestId: ulid(),
      replay: false,
    };
    await expect(
      registeredProviders.knowledge!.list({ cursor: null, limit: 10, filter: {} }, apiCaller),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", reasonCode: "KNOWLEDGE_DISABLED" });

    // Contextual ticket widget degrades gracefully to empty list when disabled
    const rel = await callerFor(aliceCustomer.principal).knowledge.help.relatedForTicket({
      query: "preparing exhibits",
    });
    expect(rel.items).toEqual([]);
  });

  it("enforces role + capability + MFA step-up matrix across console procedures", async () => {
    // Unauthenticated & remediation sessions refused
    await expect(callerFor(null).knowledge.status()).rejects.toThrow();
    const remPrincipal = fakePrincipal({
      userId: aliceCustomer.id,
      userPublicId: aliceCustomer.publicId,
      role: "customer",
      state: "remediation",
      pendingSteps: ["mfa_challenge"],
    });
    await expect(callerFor(remPrincipal).knowledge.status()).rejects.toThrow();

    // Customer refused from admin endpoints
    await expect(callerFor(aliceCustomer.principal).knowledge.admin.categories.list()).rejects.toThrow();

    // Staff allowed `knowledge.manage` reads, refused `platform.settings.manage`
    const settingsBefore = await callerFor(staff.principal).knowledge.admin.settings.get();
    expect(settingsBefore.enabled).toBe(false);
    await expect(
      callerFor(staff.principal).knowledge.admin.settings.update({ enabled: true }),
    ).rejects.toThrow();

    // Admin WITHOUT fresh step-up refused `platform.settings.manage`
    await expect(
      callerFor(adminNoStepUp.principal).knowledge.admin.settings.update({ enabled: true }),
    ).rejects.toThrow();

    // Admin WITH fresh step-up enables `feature.knowledge`
    const updated = await callerFor(adminStepUp.principal).knowledge.admin.settings.update({
      enabled: true,
      searchLogRetentionDays: 30,
      allowFeedbackComments: true,
    });
    expect(updated.enabled).toBe(true);
    expect(await knowledge.enabled()).toBe(true);
  });

  it("enforces category 1-level nesting cap and supports deterministic non-drag keyboard reorder", async () => {
    const staffCaller = callerFor(staff.principal);

    const rootA = await staffCaller.knowledge.admin.categories.create({
      slug: "getting-started",
      title: "Getting Started",
      description: "First steps for your packet.",
    });
    const rootB = await staffCaller.knowledge.admin.categories.create({
      slug: "billing-guides",
      title: "Billing Guides",
      description: "Invoices and receipts.",
    });
    const childA1 = await staffCaller.knowledge.admin.categories.create({
      parentPublicId: rootA.publicId,
      slug: "upload-checklists",
      title: "Upload Checklists",
    });
    expect(childA1.parentPublicId).toBe(rootA.publicId);

    // Grandchild (depth > 1) must be refused
    await expect(
      staffCaller.knowledge.admin.categories.create({
        parentPublicId: childA1.publicId,
        slug: "too-deep",
        title: "Too Deep",
      }),
    ).rejects.toThrow();

    // Reparenting `rootA` (which already has childA1) under `rootB` must also be refused
    await expect(
      staffCaller.knowledge.admin.categories.update({
        publicId: rootA.publicId,
        expectedVersion: rootA.version,
        parentPublicId: rootB.publicId,
      }),
    ).rejects.toThrow();

    // Non-drag reorder puts rootB before rootA
    const reorderRes = await staffCaller.knowledge.admin.categories.reorder({
      parentPublicId: null,
      orderedPublicIds: [rootB.publicId, rootA.publicId],
    });
    expect(reorderRes.updated).toBe(2);

    const tree = await staffCaller.knowledge.admin.categories.list();
    expect(tree.items.map((c) => c.slug)).toEqual(["billing-guides", "getting-started"]);
  });

  it("rejects hostile HTML fail-closed on write, projects safe AST + TOC, tracks versions & restore, and enforces audience/state isolation", async () => {
    const staffCaller = callerFor(staff.principal);
    const cats = await staffCaller.knowledge.admin.categories.list();
    const gettingStarted = cats.items.find((c) => c.slug === "getting-started")!;

    // Hostile XSS payloads are rejected fail-closed with UNSAFE_ARTICLE_HTML
    for (const hostileSnippet of [
      "<h2>Heading <script>window.__xss=1</script></h2>",
      '<p onclick="alert(1)">Event handler</p>',
      '<p><a href="javascript:alert(2)">Javascript scheme</a></p>',
      '<iframe src="https://evil.example"></iframe>',
      '<img src="https://evil.example/x.png" onerror="alert(3)" alt="bad" />',
    ]) {
      await expect(
        staffCaller.knowledge.admin.articles.create({
          categoryPublicId: gettingStarted.publicId,
          slug: "hostile-draft",
          title: "Hostile Payload Check",
          summary: "Should fail closed.",
          bodyHtml: hostileSnippet,
          tags: ["security"],
          audience: "customers",
          state: "draft",
        }),
      ).rejects.toThrow();
    }

    const cleanHtml = [
      "<h2>Preparing Exhibits</h2>",
      '<p>Scan PDFs at <strong>300 DPI</strong> and review our <a href="https://example.com/guide">External guide</a>.</p>',
      "<h3>Naming Files</h3>",
      "<ul><li>Use clear exhibit labels like <code>EX-01.pdf</code></li></ul>",
    ].join("");

    const created = await staffCaller.knowledge.admin.articles.create({
      categoryPublicId: gettingStarted.publicId,
      slug: "preparing-exhibits",
      title: "Preparing Exhibits for Your Packet",
      summary: "How to scan, label, and verify PDF exhibits before uploading.",
      bodyHtml: cleanHtml,
      tags: ["exhibits", "pdf", "scanning"],
      audience: "customers",
      state: "draft",
      reviewedOn: "2026-11-20",
      changeNote: "Initial draft",
    });

    expect(created.bodyHtml).toContain('rel="noopener noreferrer"');
    expect(created.toc.map((t) => t.text)).toEqual(["Preparing Exhibits", "Naming Files"]);
    expect(created.bodyBlocks.some((b) => b.kind === "heading" && b.level === 2)).toBe(true);

    // Draft article is invisible to customers
    await expect(
      callerFor(aliceCustomer.principal).knowledge.help.article({ slug: "preparing-exhibits" }),
    ).rejects.toThrow();

    // Update article (creates version 2), then restore version 1 (creates version 3)
    const v2 = await staffCaller.knowledge.admin.articles.update({
      publicId: created.publicId,
      expectedVersion: created.version,
      title: "Updated Exhibits Title v2",
      bodyHtml: "<h2>Updated Heading</h2><p>Updated body copy for exhibits.</p>",
      changeNote: "Second revision",
    });
    expect(v2.currentVersionNumber).toBe(2);

    const restored = await staffCaller.knowledge.admin.articles.restoreVersion({
      publicId: created.publicId,
      expectedVersion: v2.version,
      versionNumber: 1,
      changeNote: "Revert to original structure",
    });
    expect(restored.currentVersionNumber).toBe(3);
    expect(restored.title).toBe("Preparing Exhibits for Your Packet");

    const versions = await staffCaller.knowledge.admin.articles.versions({
      publicId: created.publicId,
    });
    expect(versions.items.map((v) => v.versionNumber)).toEqual([3, 2, 1]);

    // Publish customer article + create a published STAFF-ONLY article
    await staffCaller.knowledge.admin.articles.setState({
      publicId: created.publicId,
      expectedVersion: restored.version,
      state: "published",
    });

    const staffOnly = await staffCaller.knowledge.admin.articles.create({
      categoryPublicId: gettingStarted.publicId,
      slug: "internal-triage-runbook",
      title: "Internal Triage Runbook",
      summary: "Internal staff procedures for packet review.",
      bodyHtml: "<h2>Staff Triage</h2><p>Confidential internal checklist for exhibits.</p>",
      tags: ["exhibits", "internal"],
      audience: "staff",
      state: "published",
    });

    // Customer sees `preparing-exhibits` and NEVER sees `internal-triage-runbook`
    const aliceView = await callerFor(aliceCustomer.principal).knowledge.help.article({
      slug: "preparing-exhibits",
    });
    expect(aliceView.title).toBe("Preparing Exhibits for Your Packet");

    await expect(
      callerFor(aliceCustomer.principal).knowledge.help.article({
        slug: staffOnly.slug,
      }),
    ).rejects.toThrow();

    // Staff CAN view `internal-triage-runbook` in `/help`
    const staffView = await callerFor(staff.principal).knowledge.help.article({
      slug: staffOnly.slug,
    });
    expect(staffView.audience).toBe("staff");
  });

  it("ranks search results, highlights snippets, returns zero-result suggestions, and scrubs PII from anonymous search logs", async () => {
    const staffCaller = callerFor(staff.principal);

    // Create a second customer article where 'exhibits' appears only in body text
    await staffCaller.knowledge.admin.articles.create({
      slug: "general-shipping-faq",
      title: "General Timeline Overview",
      summary: "Standard turnaround expectations for orders.",
      bodyHtml: "<p>Once your order is submitted with any supporting exhibits, review begins.</p>",
      tags: ["timeline"],
      audience: "customers",
      state: "published",
    });

    // Title + tag match (`preparing-exhibits`) must rank ahead of body-only match (`general-shipping-faq`)
    const searchRes = await callerFor(aliceCustomer.principal).knowledge.help.search({
      q: "exhibits",
    });
    expect(searchRes.items.map((i) => i.slug)).toEqual([
      "preparing-exhibits",
      "general-shipping-faq",
    ]);
    expect(searchRes.items[0]!.titleSegments.some((s) => s.highlight)).toBe(true);
    expect(searchRes.suggestions).toBeNull();

    // Zero-result search returns helpful suggestions and scrubs PII in anonymous search logs
    const zeroRes = await callerFor(aliceCustomer.principal).knowledge.help.search({
      q: "quantumfluxcapacitor alice@example.com",
    });
    expect(zeroRes.items).toEqual([]);
    expect(zeroRes.suggestions).not.toBeNull();
    expect(zeroRes.suggestions!.popularArticles.length).toBeGreaterThan(0);

    // Contextual support ticket related articles widget returns customer published matches only
    const ticketRel = await callerFor(aliceCustomer.principal).knowledge.help.relatedForTicket({
      query: "How do I scan PDF exhibits?",
      category: "order",
    });
    expect(ticketRel.items.some((i) => i.slug === "preparing-exhibits")).toBe(true);
    expect(ticketRel.items.some((i) => i.slug === "internal-triage-runbook")).toBe(false);

    // Verify search logs stripped email PII completely and stored NO user identity
    const insights = await staffCaller.knowledge.admin.insights();
    const loggedTerms = insights.topSearches.map((s) => s.term);
    expect(loggedTerms.some((t) => t.includes("alice"))).toBe(false);
    expect(loggedTerms.some((t) => t.includes("example"))).toBe(false);
    expect(insights.zeroResultSearches.some((z) => z.term === "quantumfluxcapacitor")).toBe(true);
  });

  it("enforces single-use 60s attachment download tickets bound to user + session and audience visibility", async () => {
    const staffCaller = callerFor(staff.principal);
    const list = await staffCaller.knowledge.admin.articles.list({});
    const customerArt = list.items.find((a) => a.slug === "preparing-exhibits")!;
    const staffArt = list.items.find((a) => a.slug === "internal-triage-runbook")!;

    async function attachSyntheticPdf(articlePublicId: string, filename: string, content: string) {
      const plan = await knowledge.beginAttachmentUpload(staff.principal, articlePublicId);
      const stagedKey = h.deps.storage.newKey("staging");
      const info = await h.deps.storage.put(stagedKey, Buffer.from(content, "utf8"));
      const staged: StagedUpload = {
        displayName: filename,
        info,
        classification: {
          extension: "pdf",
          mime: "application/pdf",
        },
      };
      return knowledge.commitAttachmentUpload(staff.principal, plan, staged);
    }

    const custAtt = await attachSyntheticPdf(
      customerArt.publicId,
      "Exhibit-Checklist.pdf",
      "%PDF-1.4 customer checklist payload",
    );
    const staffAtt = await attachSyntheticPdf(
      staffArt.publicId,
      "Staff-Secret-Runbook.pdf",
      "%PDF-1.4 internal staff payload",
    );

    // Customer cannot issue ticket for staff-only article attachment
    await expect(
      callerFor(aliceCustomer.principal).knowledge.attachments.issueDownloadTicket({
        attachmentPublicId: staffAtt.publicId,
      }),
    ).rejects.toThrow();

    // Customer issues ticket for published customer attachment
    const issued = await callerFor(aliceCustomer.principal).knowledge.attachments.issueDownloadTicket({
      attachmentPublicId: custAtt.publicId,
    });

    // Different user (`bobCustomer`) cannot redeem Alice's ticket
    await expect(
      knowledge.redeemAttachmentDownloadTicket(bobCustomer.principal, issued.ticket),
    ).rejects.toThrow();

    // Alice redeems once -> succeeds
    const dl = await knowledge.redeemAttachmentDownloadTicket(
      aliceCustomer.principal,
      issued.ticket,
    );
    expect(dl.attachment.displayName).toBe("Exhibit-Checklist.pdf");
    expect(await readStreamToString(dl.stream)).toBe("%PDF-1.4 customer checklist payload");

    // Replaying the same single-use ticket is refused
    await expect(
      knowledge.redeemAttachmentDownloadTicket(aliceCustomer.principal, issued.ticket),
    ).rejects.toThrow();

    // Expired ticket is refused
    const issued2 = await callerFor(aliceCustomer.principal).knowledge.attachments.issueDownloadTicket({
      attachmentPublicId: custAtt.publicId,
    });
    h.clock.advance(61_000);
    await expect(
      knowledge.redeemAttachmentDownloadTicket(aliceCustomer.principal, issued2.ticket),
    ).rejects.toThrow();
  });

  it("encrypts optional feedback comments at rest, updates helpful counts idempotently per user, and runs retention cleanup", async () => {
    const staffCaller = callerFor(staff.principal);
    const list = await staffCaller.knowledge.admin.articles.list({});
    const customerArt = list.items.find((a) => a.slug === "preparing-exhibits")!;

    const vote1 = await callerFor(aliceCustomer.principal).knowledge.help.submitFeedback({
      articlePublicId: customerArt.publicId,
      helpful: true,
      comment: "Clear DPI instructions saved us a round-trip!",
    });
    expect(vote1).toEqual({ recorded: true, helpfulYesCount: 1, helpfulNoCount: 0 });

    // Verify raw DB column stores AES-256-GCM ciphertext (`rpenc:v1:...`), never plaintext
    const [rawFb] = await tdb.db
      .select()
      .from(knowledgeTables.knowledgeArticleFeedback)
      .where(eq(knowledgeTables.knowledgeArticleFeedback.userId, aliceCustomer.id));
    expect(rawFb?.commentEnc?.startsWith("rpenc:v1:")).toBe(true);
    expect(rawFb?.commentEnc).not.toContain("DPI instructions");

    // Updating vote flips counts cleanly rather than double-counting
    const vote2 = await callerFor(aliceCustomer.principal).knowledge.help.submitFeedback({
      articlePublicId: customerArt.publicId,
      helpful: false,
      comment: "Could add a note on multi-page TIFFs.",
    });
    expect(vote2).toEqual({ recorded: true, helpfulYesCount: 0, helpfulNoCount: 1 });

    const insights = await staffCaller.knowledge.admin.insights();
    expect(insights.recentFeedback[0]?.comment).toBe("Could add a note on multi-page TIFFs.");

    // Advance clock past 30-day search log retention and run `knowledge.retention` job
    h.clock.advance(32 * 86_400_000);
    await h.jobs.enqueue(KNOWLEDGE_RETENTION_JOB, {});
    await h.jobs.runAll();

    const insightsAfterPurge = await staffCaller.knowledge.admin.insights();
    expect(insightsAfterPurge.topSearches).toEqual([]);
  });

  it("serves Public API v1 `knowledge` (published customer articles only) and `tickets` (list/get/create + idempotency + system audit)", async () => {
    const apiCaller: ApiCaller = {
      kind: "api_key",
      keyPublicId: ulid(h.clock.now().getTime()),
      scopes: ["knowledge:read", "tickets:read", "tickets:write"],
      requestId: ulid(h.clock.now().getTime() + 5),
      replay: false,
      idempotencyKey: "idem-public-api-tkt-001",
    };

    // 1. `knowledge` provider returns ONLY published `customers`-audience articles
    const kbPage = await registeredProviders.knowledge!.list(
      { cursor: null, limit: 20, filter: { tag: "exhibits" } },
      apiCaller,
    );
    expect(kbPage.items.map((a) => a.slug)).toEqual(["preparing-exhibits"]);
    expect(kbPage.items[0]!.bodyHtml).not.toContain("<script");

    const singleKb = await registeredProviders.knowledge!.get(kbPage.items[0]!.id, apiCaller);
    expect(singleKb?.slug).toBe("preparing-exhibits");

    // Staff-only article publicId returns `null` via Public API v1
    const adminList = await callerFor(staff.principal).knowledge.admin.articles.list({});
    const staffOnly = adminList.items.find((a) => a.slug === "internal-triage-runbook")!;
    expect(await registeredProviders.knowledge!.get(staffOnly.publicId, apiCaller)).toBeNull();

    // 2. `tickets` provider creates ticket idempotently, lists/gets it, and audits with caller.requestId
    const createdTicket = await registeredProviders.tickets!.create(
      {
        customerId: aliceCustomer.publicId,
        subject: "API integration question on exhibit upload",
        body: "Created via Public API v1 integration key.",
      },
      apiCaller,
    );
    expect(createdTicket.customerId).toBe(aliceCustomer.publicId);
    expect(createdTicket.status).toBe("open");
    expect(createdTicket.subject).toBe("API integration question on exhibit upload");

    // Replay with same idempotencyKey returns identical ticket without duplicating
    const replayedTicket = await registeredProviders.tickets!.create(
      {
        customerId: aliceCustomer.publicId,
        subject: "API integration question on exhibit upload",
        body: "Created via Public API v1 integration key.",
      },
      apiCaller,
    );
    expect(replayedTicket.id).toBe(createdTicket.id);
    expect(replayedTicket.number).toBe(createdTicket.number);

    const listedTickets = await registeredProviders.tickets!.list(
      { cursor: null, limit: 10, filter: { customerId: aliceCustomer.publicId, status: "open" } },
      apiCaller,
    );
    expect(listedTickets.items.some((t) => t.id === createdTicket.id)).toBe(true);

    const fetchedTicket = await registeredProviders.tickets!.get(createdTicket.id, apiCaller);
    expect(fetchedTicket?.number).toBe(createdTicket.number);

    const matchingAudit = h.audit.events.find(
      (e) =>
        e.eventName === "engagement.ticket.created" &&
        e.correlationId === apiCaller.requestId &&
        e.actor?.role === "system",
    );
    expect(matchingAudit).toBeDefined();
  });

  it("hides trashed customers from knowledge feedback/insights and Public API v1 tickets, and purges fail-closed + idempotently", async () => {
    const kbParticipant = trashRegistry.participants().find((p) => p.module === "knowledge");
    expect(kbParticipant).toBeDefined();

    const articleDetail = await callerFor(aliceCustomer.principal).knowledge.help.article({
      slug: "preparing-exhibits",
    });
    const trashedCustomer = await insertSyntheticUser(h, tdb.db, { role: "customer" });
    await callerFor(trashedCustomer.principal).knowledge.help.submitFeedback({
      articlePublicId: articleDetail.publicId,
      helpful: false,
      comment: "Trashed feedback note from synthetic customer.",
    });

    const beforeTrashInsights = await callerFor(staff.principal).knowledge.admin.insights();
    expect(
      beforeTrashInsights.recentFeedback.some(
        (f) => f.comment === "Trashed feedback note from synthetic customer.",
      ),
    ).toBe(true);

    // Move customer to Trash (not yet purgeStartedAt)
    const now = h.clock.now();
    await tdb.db
      .update(users)
      .set({ trashedAt: now })
      .where(eq(users.id, trashedCustomer.id));

    // Trashed customer actor is refused in-tx
    await expect(
      callerFor(trashedCustomer.principal).knowledge.help.home(),
    ).rejects.toThrow();

    // Insights exclude trashed customer's feedback comment
    const afterTrashInsights = await callerFor(staff.principal).knowledge.admin.insights();
    expect(
      afterTrashInsights.recentFeedback.some(
        (f) => f.comment === "Trashed feedback note from synthetic customer.",
      ),
    ).toBe(false);

    // Public API v1 tickets refuses creating for a trashed customer and hides existing tickets if customer is trashed
    const apiCaller: ApiCaller = {
      kind: "api_key",
      keyPublicId: ulid(),
      scopes: ["tickets:read", "tickets:write"],
      requestId: ulid(),
      replay: false,
    };
    await expect(
      registeredProviders.tickets!.create(
        {
          customerId: trashedCustomer.publicId,
          subject: "Should fail for trashed customer",
          body: "Blocked.",
        },
        apiCaller,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", reasonCode: "CUSTOMER_NOT_FOUND" });

    // Purge fails closed before purgeStartedAt is set
    const batchId = ulid();
    const runMeta = unfencedPurgeRunForTests(ulid());
    const lostFenceRun = unfencedPurgeRunForTests(ulid(), {
      assertCurrentInTx: async () => {
        throw conflict("PURGE_FENCE_LOST", "Worker no longer owns purge run.");
      },
    });
    await expect(
      kbParticipant!.purge!(
        { kind: "customer", id: trashedCustomer.id, publicId: trashedCustomer.publicId, batchId },
        runMeta,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "PURGE_NOT_STARTED" });

    // Authorize purgeStartedAt; verify throwing fence leaves feedback unchanged, then execute purge twice (idempotent)
    await tdb.db
      .update(users)
      .set({ purgeStartedAt: now })
      .where(eq(users.id, trashedCustomer.id));

    await expect(
      kbParticipant!.purge!(
        { kind: "customer", id: trashedCustomer.id, publicId: trashedCustomer.publicId, batchId },
        lostFenceRun,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "PURGE_FENCE_LOST" });
    const fbStillPresent = await tdb.db
      .select()
      .from(knowledgeTables.knowledgeArticleFeedback)
      .where(eq(knowledgeTables.knowledgeArticleFeedback.userId, trashedCustomer.id));
    expect(fbStillPresent).toHaveLength(1);

    const firstPurge = await kbParticipant!.purge!(
      { kind: "customer", id: trashedCustomer.id, publicId: trashedCustomer.publicId, batchId },
      runMeta,
    );
    expect(firstPurge.deleted.articleFeedback).toBe(1);

    const secondPurge = await kbParticipant!.purge!(
      { kind: "customer", id: trashedCustomer.id, publicId: trashedCustomer.publicId, batchId },
      runMeta,
    );
    expect(secondPurge.deleted).toEqual({});
  });
});
