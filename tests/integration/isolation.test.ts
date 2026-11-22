/**
 * Isolation (c): two fully enrolled customers on the assembled system. Customer B presents every resource
 * identifier customer A owns (order, file, grant, message, ticket, notification, invoice, session) to every
 * customer-reachable by-id procedure and route, and must get NOT_FOUND (no existence oracle) — never data.
 * Shared resources have explicit visibility-filter or capability assertions where ownership does not apply.
 * A sweep over the live appRouter fails when a new customer-reachable procedure takes a resource id that
 * this file does not yet probe. See tests/integration/README.md.
 */
import type { AnyTRPCProcedure } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { carts } from "../../server/modules/cart/schema.js";
import type { CartView, CheckoutCartResult } from "../../server/modules/cart/types.js";
import { complianceInvoices } from "../../server/modules/compliance/schema.js";
import { DEFAULT_COMMUNITY_CONFIG } from "../../server/modules/community/settings.js";
import { exampleWav } from "../../server/modules/files/fixtures.test-support.js";
import { knowledgeArticleAttachments, knowledgeArticles, knowledgeCategories } from "../../server/modules/knowledge/schema.js";
import { paymentAttempts } from "../../server/modules/payments/schema.js";
import { isPlatformSettingsStore } from "../../server/modules/platform/settingsStore.js";
import { appRouter } from "../../server/trpc/root.js";
import { adminProcedure, protectedProcedure, staffProcedure } from "../../server/trpc/trpc.js";
import {
  Browser, bootstrapAdmin, createSystem, registerCustomer, seedProduct, stepUp, STRONG_PASSWORD,
  type ReadyAdmin, type ReadyCustomer, type System, type TrpcResult,
} from "./harness.js";

let sys: System;
let admin: ReadyAdmin;
let a: ReadyCustomer;
let b: ReadyCustomer;
let bOrderId = "";

/** Everything customer A owns, by public id. */
const owned = {
  orderId: "", fileId: "", grantId: "", messageId: "", ticketId: "", notificationId: "", invoiceId: "",
  sessionId: "", projectName: "Isolation project alpha-7731",
  ackHash: "", categoryId: "", staffCategoryId: "", topicId: "", postId: "", sharedTopicId: "",
  cartId: "", cartItemId: "", checkedOutCartId: "", paymentInvoiceId: "", attemptId: "", staffArticleId: "", staffAttachmentId: "",
};
let cartVersion = 0;
const transcript = "Synthetic private audio transcript";
const pendingTitle = "Pending isolation discussion";
const pendingText = "Synthetic reviewhold text from A";
const billing = { fullName: "Alice Isolation", email: "alice.isolation@example.test", country: "US", addressLine1: "123 Example Street", city: "Example", postalCode: "12345" };

type Def = { middlewares: unknown[]; type: "query" | "mutation" | "subscription"; inputs: unknown[] };
const defOf = (procedure: { _def: unknown }) => procedure._def as unknown as Def;

/** Top-level keys of a procedure's (possibly optional/wrapped) Zod object input. */
function inputKeys(procedure: AnyTRPCProcedure): string[] {
  const keys: string[] = [];
  for (const schema of defOf(procedure).inputs) {
    let current = schema as { shape?: Record<string, unknown>; unwrap?: () => unknown } | undefined;
    for (let depth = 0; depth < 4 && current && !current.shape && typeof current.unwrap === "function"; depth += 1) {
      current = current.unwrap() as typeof current;
    }
    if (current?.shape) keys.push(...Object.keys(current.shape));
  }
  return keys;
}

/** Customer-reachable = not under `.admin.` and not behind a staff/admin guard. */
function customerProcedures(): [string, AnyTRPCProcedure][] {
  const procedures = appRouter._def.procedures as unknown as Record<string, AnyTRPCProcedure>;
  const base = new Set(defOf(protectedProcedure as never).middlewares);
  const guards = [...defOf(staffProcedure as never).middlewares, ...defOf(adminProcedure as never).middlewares].filter((m) => !base.has(m));
  return Object.entries(procedures).filter(([path, procedure]) =>
    !path.includes(".admin.") && !guards.some((guard) => defOf(procedure).middlewares.includes(guard)));
}

const RESOURCE_KEY = /(Id|PublicId|Ids)$/;
/** Id-shaped keys that do not name another customer's resource (own-scoped or optional cursors). */
const NOT_A_FOREIGN_RESOURCE = new Set(["recoverySetId", "challengeId", "upToMessageId", "productPublicId"]);

/** Every probe customer B runs, keyed by procedure path. Inputs are otherwise valid so only ownership decides. */
type Probe = { kind: "query" | "mutation"; input: () => unknown; denial?: { code: "FORBIDDEN"; reason: string } | { code: "FILTERED" }; alternateInputs?: () => unknown[] };

function probes(): Record<string, Probe> {
  const o = owned;
  const key = (tag: string) => `isolation-${tag}-0000000000`;
  return {
    "orders.get": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.summary": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.update": { kind: "mutation", input: () => ({ orderId: o.orderId, expectedVersion: 1, projectName: "Hijacked" }) },
    "orders.addNote": { kind: "mutation", input: () => ({ orderId: o.orderId, body: "Not my order." }) },
    "orders.transition": { kind: "mutation", input: () => ({ orderId: o.orderId, expectedVersion: 1, toStatus: "cancelled" }) },
    "orders.sharing.list": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.sharing.invite": { kind: "mutation", input: () => ({ orderId: o.orderId, email: "intruder@example.test", role: "viewer" }) },
    "orders.sharing.revoke": { kind: "mutation", input: () => ({ orderId: o.orderId, grantId: o.grantId }) },
    "orders.sharing.respond": { kind: "mutation", input: () => ({ grantId: o.grantId, accept: true }) },
    "orders.requirements.forOrder": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.requirements.acknowledge": { kind: "mutation", input: () => ({ orderId: o.orderId, statusKey: "submitted", ackKey: "terms", textSha256: o.ackHash, typedName: "Bob Isolation" }) },
    "files.list": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "files.issueDownloadTicket": { kind: "mutation", input: () => ({ fileId: o.fileId }) },
    "files.readTranscript": { kind: "mutation", input: () => ({ fileId: o.fileId }) },
    // Community categories are shared. Listing must omit A's pending content; creating in a
    // visible staff-only category must fail its capability check, not hide the category.
    "community.topics.list": { kind: "query", input: () => ({ categoryPublicId: o.categoryId }), denial: { code: "FILTERED" } },
    "community.topics.get": { kind: "query", input: () => ({ topicPublicId: o.topicId }) },
    "community.topics.create": { kind: "mutation", input: () => ({ categoryPublicId: o.staffCategoryId, title: "Not a staff topic", body: "Not permitted.", idempotencyKey: key("topic") }), denial: { code: "FORBIDDEN", reason: "COMMUNITY_STAFF_ONLY_CATEGORY" } },
    "community.posts.reply": {
      kind: "mutation", input: () => ({ topicPublicId: o.topicId, body: "Not my pending topic.", idempotencyKey: key("reply-topic") }),
      alternateInputs: () => [{ topicPublicId: o.sharedTopicId, quotePostPublicId: o.postId, body: "Not my pending post.", idempotencyKey: key("reply-quote") }],
    },
    "community.posts.edit": { kind: "mutation", input: () => ({ postPublicId: o.postId, expectedVersion: 1, body: "Not my pending post." }) },
    "community.posts.delete": { kind: "mutation", input: () => ({ postPublicId: o.postId }) },
    "community.posts.react": { kind: "mutation", input: () => ({ postPublicId: o.postId, helpful: true }) },
    "community.posts.report": { kind: "mutation", input: () => ({ postPublicId: o.postId, reason: "spam" }) },
    "community.subscriptions.set": { kind: "mutation", input: () => ({ topicPublicId: o.topicId, subscribed: true }) },
    "cart.updateItem": { kind: "mutation", input: () => ({ itemPublicId: o.cartItemId, expectedVersion: cartVersion, quantity: 2 }) },
    "cart.removeItem": { kind: "mutation", input: () => ({ itemPublicId: o.cartItemId, expectedVersion: cartVersion }) },
    "cart.checkout": { kind: "mutation", input: () => ({ cartPublicId: o.cartId, expectedVersion: cartVersion, projectName: "Not my checkout", billing, idempotencyKey: key("checkout") }) },
    "cart.checkoutStatus": { kind: "query", input: () => ({ cartPublicId: o.checkedOutCartId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    "cart.restoreCheckout": { kind: "mutation", input: () => ({ cartPublicId: o.checkedOutCartId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    // Knowledge has audience and capability boundaries, not customer-owned articles.
    "knowledge.help.submitFeedback": { kind: "mutation", input: () => ({ articlePublicId: o.staffArticleId, helpful: true }) },
    "knowledge.attachments.issueDownloadTicket": { kind: "mutation", input: () => ({ attachmentPublicId: o.staffAttachmentId }) },
    "knowledge.attachments.remove": { kind: "mutation", input: () => ({ attachmentPublicId: o.staffAttachmentId }), denial: { code: "FORBIDDEN", reason: "CAPABILITY_NOT_GRANTED" } },
    "payments.startInvoiceCheckout": { kind: "mutation", input: () => ({ invoicePublicId: o.paymentInvoiceId, idempotencyKey: key("payment") }) },
    "payments.checkoutStatus": { kind: "query", input: () => ({ invoicePublicId: o.paymentInvoiceId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    "payments.cancelAttempt": { kind: "mutation", input: () => ({ invoicePublicId: o.paymentInvoiceId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    "engagement.messages.listByOrder": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "engagement.messages.unreadSummary": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "engagement.messages.send": { kind: "mutation", input: () => ({ orderId: o.orderId, body: "Intrusion.", idempotencyKey: key("msg") }) },
    "engagement.messages.markOrderRead": { kind: "mutation", input: () => ({ orderId: o.orderId }) },
    "engagement.tickets.get": { kind: "query", input: () => ({ ticketId: o.ticketId }) },
    "engagement.tickets.create": {
      kind: "mutation",
      input: () => ({ subject: "About an order", category: "order", body: "Linking someone else's order.", relatedOrderId: o.orderId, idempotencyKey: key("tkt") }),
    },
    "engagement.tickets.reply": { kind: "mutation", input: () => ({ ticketId: o.ticketId, body: "Intrusion.", idempotencyKey: key("rep") }) },
    "engagement.tickets.close": { kind: "mutation", input: () => ({ ticketId: o.ticketId }) },
    "engagement.tickets.reopen": { kind: "mutation", input: () => ({ ticketId: o.ticketId, reason: "Intrusion." }) },
    "engagement.notifications.markRead": { kind: "mutation", input: () => ({ notificationId: o.notificationId }) },
    "compliance.intake.listForOrder": { kind: "query", input: () => ({ orderPublicId: o.orderId }) },
    "compliance.intake.getSubmission": { kind: "query", input: () => ({ orderPublicId: o.orderId, questionnairePublicId: o.orderId }) },
    "compliance.intake.saveDraft": { kind: "mutation", input: () => ({ orderPublicId: o.orderId, questionnairePublicId: o.orderId, answers: {} }) },
    "compliance.intake.submit": { kind: "mutation", input: () => ({ orderPublicId: o.orderId, questionnairePublicId: o.orderId, answers: {} }) },
    "compliance.invoices.listForOrder": { kind: "query", input: () => ({ orderPublicId: o.orderId }) },
    "compliance.invoices.get": { kind: "query", input: () => ({ invoicePublicId: o.invoiceId }) },
    "identity.sessions.revoke": { kind: "mutation", input: () => ({ sessionId: o.sessionId }) },
    // Unknown-id probes (README: a cross-account passkey / published-policy fixture is it.todo).
    "assurance.renamePasskey": { kind: "mutation", input: () => ({ publicId: o.orderId, name: "Intruder key" }) },
    "assurance.removePasskey": { kind: "mutation", input: () => ({ publicId: o.orderId }) },
    "compliance.policies.accept": {
      kind: "mutation", input: () => ({ versionPublicId: o.invoiceId, contentHash: "0".repeat(64), orderPublicId: o.orderId }),
    },
  };
}

const call = (browser: Browser, kind: "query" | "mutation", path: string, input: unknown): Promise<TrpcResult> =>
  kind === "query" ? browser.query(path, input) : browser.mutate(path, input);

async function installRequirementsWorkflow() {
  const workflow = "orders.admin.workflows.drafts";
  const name = "Isolation workflow";
  const { publicId } = Browser.ok(await admin.browser.mutate<{ publicId: string }>(`${workflow}.create`, { from: "blank", workflowKey: "isolation_flow", name }));
  Browser.ok(await admin.browser.mutate(`${workflow}.save`, {
    draftId: publicId, expectedVersion: 1, name,
    definition: {
      phases: [{ key: "intake", label: "Intake" }],
      states: [
        {
          key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info", phase: "intake",
          requirements: {
            uploads: [{ key: "voice_evidence", label: "Voice evidence", kind: "audio", minCount: 1, maxCount: 2, allowedTypes: ["wav"], uploadedBy: ["customer"] }],
            acknowledgements: [{ key: "terms", title: "Project terms", body: "I confirm the brief is complete.", acceptedBy: "customer", requireTypedName: true }],
          },
        },
        { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success", phase: "intake" },
        { key: "canceled", label: "Canceled", customerLabel: "Canceled", kind: "terminal", tone: "neutral" },
      ],
      transitions: [
        { from: "submitted", to: "completed", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
        { from: "submitted", to: "canceled", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
      ],
    },
  }));
  Browser.ok(await admin.browser.mutate(`${workflow}.publish`, { draftId: publicId, expectedVersion: 2, makeDefault: true }));
}

async function seedCommunity() {
  const addCategory = async (slug: string, name: string, staffOnlyPosting: boolean) => Browser.ok(
    await admin.browser.mutate<{ publicId: string }>("community.admin.categories.create", { slug, name, staffOnlyPosting }),
  ).publicId;
  owned.categoryId = await addCategory("isolation", "Isolation forum", false);
  owned.staffCategoryId = await addCategory("staff-announcements", "Staff announcements", true);
  Browser.ok(await a.browser.mutate("community.profile.save", { displayName: "Alice Isolation" }));
  Browser.ok(await b.browser.mutate("community.profile.save", { displayName: "Bob Isolation" }));
  const makeTopic = async (title: string, body: string, idempotencyKey: string) => Browser.ok(
    await a.browser.mutate<{ topicPublicId: string; postPublicId: string; state: string }>("community.topics.create", { categoryPublicId: owned.categoryId, title, body, idempotencyKey }),
  );
  const pending = await makeTopic(pendingTitle, pendingText, "isolation-pending-topic");
  expect(pending.state).toBe("pending");
  owned.topicId = pending.topicPublicId;
  owned.postId = pending.postPublicId;
  const shared = await makeTopic("Shared isolation discussion", "Synthetic text meant for all members.", "isolation-shared-topic");
  expect(shared.state).toBe("published");
  owned.sharedTopicId = shared.topicPublicId;
}

async function seedCartAndAttempt(productId: string, userId: number) {
  const add = async () => Browser.ok(await a.browser.mutate<CartView>("cart.addItems", { items: [{ productPublicId: productId, quantity: 1 }] }));
  const original = await add();
  const checkedOut = Browser.ok(await a.browser.mutate<CheckoutCartResult>("cart.checkout", {
    cartPublicId: original.cartPublicId, expectedVersion: original.version, projectName: "Owned checkout A", billing, idempotencyKey: "isolation-cart-checkout-a",
  }));
  expect(checkedOut.mode).toBe("invoice");
  owned.checkedOutCartId = checkedOut.cartPublicId;
  owned.paymentInvoiceId = checkedOut.invoicePublicId;
  const current = await add();
  owned.cartId = current.cartPublicId ?? "";
  owned.cartItemId = current.items[0]?.itemPublicId ?? "";
  cartVersion = current.version;

  // Insert an attempt for A's real issued invoice. The assembled app must not call a live provider.
  const [invoice] = await sys.t.db.select().from(complianceInvoices).where(eq(complianceInvoices.publicId, checkedOut.invoicePublicId));
  const idempotencyKey = "isolation-hosted-attempt";
  await sys.t.db.insert(paymentAttempts).values({
    invoiceId: invoice!.id, invoicePublicId: checkedOut.invoicePublicId, cartPublicId: checkedOut.cartPublicId,
    orderPublicId: checkedOut.orderPublicId, customerUserId: userId, provider: "stripe", environment: "test",
    amountMinor: checkedOut.totalMinor, currency: checkedOut.currency, idempotencyKey, status: "created",
    successPath: "/checkout/return", cancelPath: "/cart",
  });
  const [attempt] = await sys.t.db.select().from(paymentAttempts).where(eq(paymentAttempts.idempotencyKey, idempotencyKey));
  owned.attemptId = attempt!.publicId;
  await sys.t.db.update(carts).set({ paymentAttemptPublicId: owned.attemptId }).where(eq(carts.publicId, owned.checkedOutCartId));
}

async function seedKnowledge(adminUserId: number) {
  const category = Browser.ok(await admin.browser.mutate<{ publicId: string }>("knowledge.admin.categories.create", { slug: "isolation-help", title: "Isolation help" }));
  const [row] = await sys.t.db.select().from(knowledgeCategories).where(eq(knowledgeCategories.publicId, category.publicId));
  const slug = "isolation-staff-article";
  await sys.t.db.insert(knowledgeArticles).values({
    categoryId: row!.id, slug, title: "Staff-only material", summary: "Internal use", bodyHtml: "<p>Staff only.</p>", bodyText: "Staff only.",
    tagsJson: "[]", audience: "staff", state: "published", publishedAt: sys.clock.now(), authorUserId: adminUserId, updatedByUserId: adminUserId,
  });
  const [article] = await sys.t.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.slug, slug));
  owned.staffArticleId = article!.publicId;
  const storageKey = `files/${"2".repeat(32)}`;
  await sys.t.db.insert(knowledgeArticleAttachments).values({
    articleId: article!.id, uploadedByUserId: adminUserId, storageKey, displayNameEnc: "unused-by-ticket-issuance",
    byteSize: 20, sha256: "a".repeat(64), contentType: "application/pdf", extension: "pdf",
  });
  const [attachment] = await sys.t.db.select().from(knowledgeArticleAttachments).where(eq(knowledgeArticleAttachments.storageKey, storageKey));
  owned.staffAttachmentId = attachment!.publicId;
}

beforeAll(async () => {
  sys = await createSystem();
  admin = await bootstrapAdmin(sys);
  const { settings } = sys.container.services;
  if (!isPlatformSettingsStore(settings)) throw new Error("Expected the assembled settings store");
  await settings.set("orders.workflow_rules.enabled", true);
  await settings.set("files.audio_conversion", { enabled: true, maxMinutes: 1, bitrateKbps: 48, keepOriginal: true });
  await settings.set("community.config", { ...DEFAULT_COMMUNITY_CONFIG, newMemberReviewPosts: 0, heldWords: ["reviewhold"] });
  for (const feature of ["community", "cart", "knowledge"]) await settings.setFeature(feature, true);
  Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
  await installRequirementsWorkflow();
  const productId = await seedProduct(admin);
  a = await registerCustomer(sys, "alice.isolation@example.test", "Alice Isolation");
  b = await registerCustomer(sys, "bob.isolation@example.test", "Bob Isolation");

  const order = Browser.ok(await a.browser.mutate<{ publicId: string }>("orders.create", {
    projectName: owned.projectName, items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: "isolation-order-a-0001",
  }));
  owned.orderId = order.publicId;
  Browser.ok(await a.browser.mutate("orders.addNote", { orderId: owned.orderId, body: "Private note of A." }));
  bOrderId = Browser.ok(await b.browser.mutate<{ publicId: string }>("orders.create", {
    projectName: "Isolation project bravo", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: "isolation-order-b-0001",
  })).publicId;

  const upload = await a.browser.raw("post", `/api/files/upload/${owned.orderId}?statusKey=submitted&slotKey=voice_evidence`)
    .field("transcript", transcript).attach("files", exampleWav(8000), "private.wav");
  expect(upload.status).toBe(200);
  owned.fileId = upload.body.results[0].file.publicId as string;
  const { acknowledgements } = Browser.ok(await a.browser.query<{ acknowledgements: { key: string; textSha256: string; canAccept: boolean }[] }>("orders.requirements.forOrder", { orderId: owned.orderId }));
  expect(acknowledgements).toEqual([expect.objectContaining({ key: "terms", canAccept: true })]);
  owned.ackHash = acknowledgements[0]!.textSha256;

  Browser.ok(await a.browser.mutate("orders.sharing.invite", { orderId: owned.orderId, email: "carol.collab@example.test", role: "viewer" }));
  const grants = Browser.ok(await a.browser.query<unknown>("orders.sharing.list", { orderId: owned.orderId }));
  owned.grantId = JSON.stringify(grants).match(/"(?:grantId|publicId)":"([0-9A-HJKMNP-TV-Z]{26})"/)?.[1] ?? "";

  owned.messageId = Browser.ok(await a.browser.mutate<{ publicId: string }>("engagement.messages.send", {
    orderId: owned.orderId, body: "Private message of A.", idempotencyKey: "isolation-msg-a-0001",
  })).publicId;
  owned.ticketId = Browser.ok(await a.browser.mutate<{ ticket: { publicId: string } }>("engagement.tickets.create", {
    subject: "Private ticket of A", category: "general", body: "Only A and staff may read this.", idempotencyKey: "isolation-tkt-a-0001",
  })).ticket.publicId;

  // A notification for A, emitted the way every module does (service-internal notify, in its own tx).
  const aUser = await sys.container.services.identity.findUserIdByEmail(a.email);
  await sys.t.db.transaction((tx) => sys.container.services.engagement.notify({
    userId: aUser!.userId, kind: "order.status_changed", title: "Your order was updated", body: "Synthetic isolation notice.", link: `/orders/${owned.orderId}`,
  }, tx));
  const notes = Browser.ok(await a.browser.query<{ items: { publicId: string }[] }>("engagement.notifications.list", {}));
  owned.notificationId = notes.items[0]?.publicId ?? "";

  Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
  owned.invoiceId = Browser.ok(await admin.browser.mutate<{ invoicePublicId: string }>("compliance.invoices.admin.createDraft", {
    orderPublicId: owned.orderId, currency: "USD", lines: [{ description: "Synthetic line", quantity: 1, unitAmountMinor: 1500 }],
  })).invoicePublicId;
  Browser.ok(await admin.browser.mutate("compliance.invoices.admin.issue", { invoicePublicId: owned.invoiceId }));

  const sessions = Browser.ok(await a.browser.query<{ items: { sessionId: string; current: boolean }[] }>("identity.sessions.list"));
  owned.sessionId = sessions.items.find((s) => s.current)?.sessionId ?? "";

  await seedCommunity();
  await seedCartAndAttempt(productId, aUser!.userId);
  const adminUser = await sys.container.services.identity.findUserIdByEmail(admin.email);
  await seedKnowledge(adminUser!.userId);

  for (const [name, value] of Object.entries(owned)) expect(value, name).not.toBe("");
}, 120_000);

afterAll(async () => sys?.close());

describe("cross-customer isolation (assembled system)", () => {
  it("customer A can read every one of its own resources (the probes below are meaningful)", async () => {
    Browser.ok(await a.browser.query("orders.get", { orderId: owned.orderId }));
    Browser.ok(await a.browser.query("engagement.tickets.get", { ticketId: owned.ticketId }));
    Browser.ok(await a.browser.query("compliance.invoices.get", { invoicePublicId: owned.invoiceId }));
    Browser.ok(await a.browser.mutate("files.issueDownloadTicket", { fileId: owned.fileId }));
    expect(Browser.ok(await a.browser.mutate("files.readTranscript", { fileId: owned.fileId }))).toEqual({ transcript });
    expect(Browser.ok(await a.browser.query("community.topics.get", { topicPublicId: owned.topicId }))).toEqual(expect.objectContaining({
      topic: expect.objectContaining({ publicId: owned.topicId, title: pendingTitle }),
      posts: expect.arrayContaining([expect.objectContaining({ publicId: owned.postId })]),
    }));
    expect(Browser.ok(await a.browser.query<CartView>("cart.get")).items).toEqual([expect.objectContaining({ itemPublicId: owned.cartItemId, quantity: 1 })]);
    Browser.ok(await a.browser.query("cart.checkoutStatus", { attemptPublicId: owned.attemptId }));
    Browser.ok(await a.browser.query("payments.checkoutStatus", { attemptPublicId: owned.attemptId }));
    Browser.ok(await a.browser.mutate("payments.startInvoiceCheckout", { invoicePublicId: owned.paymentInvoiceId }));
    Browser.ok(await admin.browser.mutate("knowledge.attachments.issueDownloadTicket", { attachmentPublicId: owned.staffAttachmentId }));
  });

  it("customer B cannot read or mutate protected resources through any by-id procedure", async () => {
    // B is fully stepped-up, so a freshness gate can never mask a missing ownership check.
    Browser.ok(await stepUp(sys, b.browser, STRONG_PASSWORD, b.secret));
    const failures: string[] = [];
    for (const [path, probe] of Object.entries(probes())) {
      const inputs = [probe.input(), ...(probe.alternateInputs?.() ?? [])];
      for (const [index, input] of inputs.entries()) {
        const result = await call(b.browser, probe.kind, path, input);
        const code = result.error?.safe.domainCode;
        const reason = result.error?.safe.reasonCode;
        const label = `${path}${inputs.length > 1 ? ` #${index + 1}` : ""}`;
        if (probe.denial?.code === "FILTERED") {
          const visible = JSON.stringify(Browser.ok(result));
          for (const privateValue of [owned.topicId, owned.postId, pendingTitle, pendingText]) {
            if (visible.includes(privateValue)) failures.push(`${label}: returned private community content`);
          }
          if (!visible.includes(owned.sharedTopicId)) failures.push(`${label}: did not return the shared topic`);
        } else if (probe.denial?.code === "FORBIDDEN") {
          if (result.status !== 403 || code !== "FORBIDDEN" || reason !== probe.denial.reason) failures.push(`${label}: ${result.status} ${code ?? ""} ${reason ?? ""}`);
        } else if (result.status !== 404 || code !== "NOT_FOUND") {
          failures.push(`${label}: ${result.status} ${code ?? ""} ${reason ?? ""}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("B's own-scoped lists and search never surface A's resources", async () => {
    const leaks: string[] = [];
    const ids = [owned.orderId, owned.fileId, owned.messageId, owned.ticketId, owned.notificationId, owned.invoiceId];
    const views: [string, unknown][] = [
      ["orders.list", {}], ["engagement.messages.threads", {}], ["engagement.tickets.list", {}],
      ["engagement.notifications.list", {}], ["compliance.invoices.listMine", {}], ["orders.sharing.myInvitations", undefined],
      ["files.list", { orderId: bOrderId }], ["engagement.search.query", { query: "alpha-7731" }],
    ];
    for (const [path, input] of views) {
      const body = JSON.stringify(Browser.ok(await b.browser.query(path, input)));
      for (const id of ids) if (body.includes(id)) leaks.push(`${path} leaks ${id}`);
      if (body.includes(owned.projectName)) leaks.push(`${path} leaks A's project name`);
    }
    expect(leaks).toEqual([]);
  });

  it("B cannot attach A's file to B's own message", async () => {
    const result = await b.browser.mutate("engagement.messages.send", {
      orderId: bOrderId, body: "Look at this.", attachmentFileIds: [owned.fileId], idempotencyKey: "isolation-attach-b-0001",
    });
    expect(result.error?.safe.domainCode).toBe("NOT_FOUND");
  });

  it("HTTP routes: B cannot upload into A's order or redeem A's download ticket", async () => {
    const upload = await b.browser.raw("post", `/api/files/upload/${owned.orderId}`).attach("files", exampleWav(), "intrusion.wav");
    expect(upload.status).toBe(404);
    const { ticket } = Browser.ok(await a.browser.mutate<{ ticket: string }>("files.issueDownloadTicket", { fileId: owned.fileId }));
    const stolen = await b.browser.raw("post", "/api/files/download").send({ ticket });
    expect(stolen.status).toBe(404);
  });

  it("A's resources are unchanged after B's attempts", async () => {
    const detail = JSON.stringify(Browser.ok(await a.browser.query("orders.get", { orderId: owned.orderId })));
    expect(detail).toContain(owned.projectName);
    expect(detail).not.toContain("Hijacked");
    expect(detail).not.toContain("Not my order.");
    const sessions = Browser.ok(await a.browser.query<{ items: { sessionId: string }[] }>("identity.sessions.list"));
    expect(sessions.items.map((s) => s.sessionId)).toContain(owned.sessionId);
    const messages = JSON.stringify(Browser.ok(await a.browser.query("engagement.messages.listByOrder", { orderId: owned.orderId })));
    expect(messages).not.toContain("Intrusion.");
    const cart = Browser.ok(await a.browser.query<CartView>("cart.get"));
    expect(cart).toMatchObject({ cartPublicId: owned.cartId, version: cartVersion, items: [{ itemPublicId: owned.cartItemId, quantity: 1 }] });
    const [attempt] = await sys.t.db.select().from(paymentAttempts).where(eq(paymentAttempts.publicId, owned.attemptId));
    expect(attempt).toMatchObject({ status: "created", cancelledAt: null });
    const [attachment] = await sys.t.db.select().from(knowledgeArticleAttachments).where(eq(knowledgeArticleAttachments.publicId, owned.staffAttachmentId));
    expect(attachment?.deletedAt).toBeNull();
    const [article] = await sys.t.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.publicId, owned.staffArticleId));
    expect(article).toMatchObject({ helpfulYesCount: 0, helpfulNoCount: 0 });
    Browser.ok(await a.browser.mutate("orders.requirements.acknowledge", { orderId: owned.orderId, statusKey: "submitted", ackKey: "terms", textSha256: owned.ackHash, typedName: "Alice Isolation" }));
  });

  it.todo("B cannot remove or rename A's passkey (needs a virtual WebAuthn authenticator fixture for A)");
  it.todo("B cannot accept a published policy against A's order (needs an admin-published policy version fixture)");

  it("every customer-reachable procedure that takes a resource id is probed here", () => {
    const covered = probes();
    const missing = customerProcedures()
      .filter(([path, procedure]) => inputKeys(procedure).some((k) => RESOURCE_KEY.test(k) && !NOT_A_FOREIGN_RESOURCE.has(k)) && !covered[path])
      .map(([path, procedure]) => `${path} (${inputKeys(procedure).join(", ")})`);
    expect(missing).toEqual([]);
  });
});
