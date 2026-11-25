/**
 * Journey (a): a customer registers, verifies, enrols MFA, orders, attaches a file and signs out —
 * through the assembled system exactly as a browser would. See tests/integration/README.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "../../server/core/ids.js";
import { exampleWav } from "../../server/modules/files/fixtures.test-support.js";
import { orders, orderWorkflows, orderWorkflowVersions } from "../../server/modules/orders/schema.js";
import type { StageWorkspace } from "../../server/modules/orders/stages.js";
import { DEFAULT_WORKFLOW, workflowDefinitionSchema } from "../../server/modules/orders/workflowTypes.js";
import {
  Browser, bootstrapAdmin, createSystem, linkToken, seedProduct, STRONG_PASSWORD, totpCode, type System,
  freshProbeAddress, stepUp, type ReadyAdmin,
} from "./harness.js";

const EMAIL = "casey.customer@example.test";
let sys: System;
let productId: string;
let admin: ReadyAdmin;
const browser = () => customer;
let customer: Browser;

beforeAll(async () => {
  sys = await createSystem();
  admin = await bootstrapAdmin(sys);
  productId = await seedProduct(admin);
  customer = sys.browser();
});
afterAll(async () => sys?.close());

/** Every step must leave its audit trail under the request id the browser saw. */
async function expectAudited(requestId: string, ...eventNames: string[]) {
  expect(requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  const events = await sys.audit({ requestId });
  expect(events.map((event) => event.eventName)).toEqual(expect.arrayContaining(eventNames));
  for (const event of events) expect(event.requestId).toBe(requestId);
  return events;
}

/**
 * A mutation without the CSRF header must be refused at the edge, before any procedure runs. Denial notes are
 * de-duplicated per client address per minute, so each probe comes from its own address to prove every one is audited.
 */
async function expectCsrfRequired(path: string, input?: unknown) {
  const refused = await browser().mutate(path, input, { csrf: null, address: freshProbeAddress() });
  expect(refused.status).toBe(403);
  expect(refused.error?.safe.reasonCode).toBe("CSRF_INVALID");
  expect(await sys.audit({ requestId: refused.requestId, eventName: "http.csrf.denied" })).toHaveLength(1);
}

describe("customer journey (assembled system)", () => {
  let orderId: string;
  let secret: string;

  it("registers; the address is verified only via the captured mail link (no preview link outside preview)", async () => {
    await browser().primeCsrf();
    const anonymousCsrf = browser().setCookies.find((line) => line.startsWith(`${sys.config.csrfCookieName}=`))!;
    expect(anonymousCsrf).toMatch(/; Path=\//);
    expect(anonymousCsrf).toMatch(/; Secure/);
    expect(anonymousCsrf).toMatch(/; SameSite=Strict/);
    expect(anonymousCsrf).not.toMatch(/HttpOnly/);
    expect(anonymousCsrf).not.toMatch(/Domain=/i);

    await expectCsrfRequired("identity.register", { email: EMAIL, name: "Casey Customer", password: STRONG_PASSWORD });
    const registered = await browser().mutate("identity.register", { email: EMAIL, name: "Casey Customer", password: STRONG_PASSWORD });
    expect(Browser.ok(registered)).toEqual({ accepted: true });
    await expectAudited(registered.requestId, "auth.register.requested");

    const [mail] = await sys.inbox(EMAIL);
    expect(mail?.text).toContain(`${sys.config.canonicalOrigin}/`);
    const verified = await browser().mutate("identity.verifyEmail", { token: linkToken(mail!.text) });
    expect(Browser.ok(verified)).toEqual({ verified: true });
    await expectAudited(verified.requestId, "auth.email.verified");
  });

  it("signs in to a remediation session whose cookies carry __Host- attributes, then enrols TOTP", async () => {
    await expectCsrfRequired("identity.signIn", { email: EMAIL, password: STRONG_PASSWORD });
    const signIn = await browser().mutate<{ nextStep: string }>("identity.signIn", { email: EMAIL, password: STRONG_PASSWORD });
    expect(Browser.ok(signIn)).toEqual({ nextStep: "enroll_mfa" });
    await expectAudited(signIn.requestId, "auth.login.succeeded");
    expect(JSON.stringify(signIn.res.body)).not.toContain(browser().sessionToken!);
    const sessionCookie = signIn.res.headers["set-cookie"] as unknown as string[];
    const session = sessionCookie.find((line) => line.startsWith("__Host-rp_session="))!;
    expect(session).toMatch(/; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Strict$/);
    expect(sessionCookie.find((line) => line.startsWith("__Host-rp_csrf="))).toMatch(/; Path=\/; Expires=[^;]+; Secure; SameSite=Strict$/);
    expect(signIn.res.headers["cache-control"]).toBe("no-store");

    // A remediation session cannot read customer data.
    const blocked = await browser().query("orders.list", {});
    expect(blocked.error?.safe.domainCode).toBe("REMEDIATION_REQUIRED");

    await expectCsrfRequired("assurance.beginTotpEnrollment");
    const begin = await browser().mutate<{ secret: string }>("assurance.beginTotpEnrollment");
    secret = Browser.ok(begin).secret;
    await expectAudited(begin.requestId, "auth.totp.enrollment_started");
    const before = browser().sessionToken;
    const confirm = await browser().mutate<{ recoveryCodes: string[]; recoverySetId: string }>("assurance.confirmTotpEnrollment", {
      code: totpCode(secret, sys.clock),
    });
    const recovery = Browser.ok(confirm);
    expect(recovery.recoveryCodes.length).toBeGreaterThanOrEqual(8);
    expect(browser().sessionToken).not.toBe(before); // rotated on assurance change
    await expectAudited(confirm.requestId, "auth.totp.enrolled");

    const me = Browser.ok(await browser().query<{ nextStep: string | null }>("identity.me"));
    expect(me.nextStep).toBe("acknowledge_recovery_codes");
    await expectCsrfRequired("assurance.acknowledgeRecoveryCodes", { recoverySetId: recovery.recoverySetId });
    const ack = await browser().mutate("assurance.acknowledgeRecoveryCodes", { recoverySetId: recovery.recoverySetId });
    Browser.ok(ack);
    await expectAudited(ack.requestId, "auth.recovery_codes.acknowledged");
    const full = Browser.ok(await browser().query<{ state: string; nextStep: string | null }>("identity.me"));
    expect(full).toMatchObject({ state: "full", nextStep: null });
  });

  it("lists the catalog, creates an order and adds a note", async () => {
    const catalog = Browser.ok(await browser().query<unknown[]>("orders.catalog.list"));
    expect(JSON.stringify(catalog)).toContain(productId);

    const input = { projectName: "Integration project", items: [{ productPublicId: productId, quantity: 2 }], idempotencyKey: "journey-customer-0001" };
    await expectCsrfRequired("orders.create", input);
    const created = await browser().mutate<{ publicId: string; reference: string }>("orders.create", input);
    const order = Browser.ok(created);
    orderId = order.publicId;
    expect(order.publicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await expectAudited(created.requestId, "order.created");

    await expectCsrfRequired("orders.addNote", { orderId, body: "Please call before delivery." });
    const note = await browser().mutate("orders.addNote", { orderId, body: "Please call before delivery." });
    Browser.ok(note);
    await expectAudited(note.requestId, "order.note.added");
    const detail = Browser.ok(await browser().query("orders.get", { orderId }));
    expect(JSON.stringify(detail)).toContain("Please call before delivery.");
  });

  it("opens intake once the administrator records an offline payment", async () => {
    const before = Browser.ok(await browser().query<StageWorkspace>("orders.stages.workspace", { orderId }));
    expect(before.stages.find((item) => item.key === before.currentStageKey)).toMatchObject({ waitingOn: "payment" });
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    const { invoicePublicId } = Browser.ok(await admin.browser.mutate<{ invoicePublicId: string }>("compliance.invoices.admin.createDraft", {
      orderPublicId: orderId, currency: "USD", lines: [{ description: "Integration Item", quantity: 2, unitAmountMinor: 1500 }],
    }));
    Browser.ok(await admin.browser.mutate("compliance.invoices.admin.issue", { invoicePublicId }));
    Browser.ok(await admin.browser.mutate("compliance.invoices.admin.recordManualPayment", {
      invoicePublicId, method: "check", amountMinor: 3000, currency: "USD",
      reference: "Synthetic journey payment", idempotencyKey: "journey-customer-manual-payment",
    }));
    const after = Browser.ok(await browser().query<StageWorkspace>("orders.stages.workspace", { orderId }));
    expect(after.stages.find((item) => item.key === after.currentStageKey)).toMatchObject({ state: "open", actions: { uploadAudio: true } });
  });

  it("uploads a file to the order and downloads it with a single-use ticket sent in the POST body", async () => {
    const workspace = Browser.ok(await browser().query<StageWorkspace>("orders.stages.workspace", { orderId }));
    expect(workspace.workflowFormat).toBe(3);
    const stage = workspace.stages.find((item) => item.key === workspace.currentStageKey);
    expect(stage).toMatchObject({ state: "open", locked: false, actions: { uploadAudio: true } });
    const bytes = exampleWav();
    const path = `/api/files/upload/${orderId}`;
    const boundPath = `${path}?${new URLSearchParams({ stageKey: stage!.key, intent: "prerecorded_audio" })}`;
    const noCsrf = await browser().raw("post", boundPath, { csrf: null }).attach("files", bytes, "voice-note.wav");
    expect(noCsrf.status).toBe(403);
    const unbound = await browser().raw("post", path).attach("files", bytes, "voice-note.wav");
    expect(unbound.status).toBe(400);
    expect(unbound.body.safe).toMatchObject({ domainCode: "VALIDATION", reasonCode: "STAGE_REQUIRED" });
    const upload = await browser().raw("post", boundPath).attach("files", bytes, "voice-note.wav");
    expect(upload.status).toBe(200);
    expect(upload.body.results).toEqual([expect.objectContaining({ outcome: "completed",
      file: expect.objectContaining({ extension: "wav", stageKey: stage!.key }) })]);
    const fileId = upload.body.results[0].file.publicId as string;
    await expectAudited(String(upload.headers["x-request-id"]), "file.uploaded");

    const listed = Browser.ok(await browser().query<{ items: { publicId: string }[] }>("files.list", { orderId, stageKey: stage!.key }));
    expect(listed.items.map((file) => file.publicId)).toContain(fileId);

    await expectCsrfRequired("files.issueDownloadTicket", { fileId });
    const issued = await browser().mutate<{ ticket: string }>("files.issueDownloadTicket", { fileId });
    const { ticket } = Browser.ok(issued);
    await expectAudited(issued.requestId, "file.download.ticket_issued");

    const noCsrfDownload = await browser().raw("post", "/api/files/download", { csrf: null }).send({ ticket });
    expect(noCsrfDownload.status).toBe(403);
    const download = await browser().raw("post", "/api/files/download").buffer(true)
      .parse((res, done) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => done(null, Buffer.concat(chunks))); })
      .send({ ticket });
    expect(download.status).toBe(200);
    expect(Buffer.compare(download.body as Buffer, bytes)).toBe(0);
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(download.headers["cache-control"]).toContain("no-store");
    await expectAudited(String(download.headers["x-request-id"]), "file.download");

    const replay = await browser().raw("post", "/api/files/download").send({ ticket });
    expect(replay.status).toBe(404);
  });

  it.each([1, 2])("still accepts the unbound Files-tab upload for existing orders pinned to format %i", async (format) => {
    const legacy = workflowDefinitionSchema.parse(format === 1 ? DEFAULT_WORKFLOW : {
      ...DEFAULT_WORKFLOW, phases: [{ key: "intake", label: "Intake" }],
      states: DEFAULT_WORKFLOW.states.map((state) => state.kind === "initial" ? { ...state, phase: "intake" } : state),
    });
    const legacyOrderId = ulid();
    await sys.t.db.transaction(async (tx) => {
      const [owner] = await tx.select({ userId: orders.ownerUserId }).from(orders).where(eq(orders.publicId, orderId));
      const [workflow] = await tx.insert(orderWorkflows).values({
        publicId: ulid(), workflowKey: `journey_legacy_${format}`, name: `Classic integration fixture ${format}`, isDefault: false,
      }).$returningId();
      const [version] = await tx.insert(orderWorkflowVersions).values({
        publicId: ulid(), workflowId: workflow!.id, versionNumber: 1, definition: legacy,
      }).$returningId();
      await tx.update(orderWorkflows).set({ currentVersionId: version!.id }).where(eq(orderWorkflows.id, workflow!.id));
      await tx.insert(orders).values({
        publicId: legacyOrderId, reference: legacyOrderId, projectName: "Existing customer order",
        ownerUserId: owner!.userId, workflowVersionId: version!.id, statusKey: "submitted",
        subtotalMinor: 100, totalMinor: 100, currency: "USD",
      });
    });
    const workspace = Browser.ok(await browser().query<StageWorkspace>("orders.stages.workspace", { orderId: legacyOrderId }));
    expect(workspace).toMatchObject({ workflowFormat: format, derived: true });
    const listed = Browser.ok(await browser().query<{ canUpload: boolean; stageUploadsRequired: boolean }>("files.list", { orderId: legacyOrderId }));
    expect(listed).toMatchObject({ canUpload: true, stageUploadsRequired: false });
    const upload = await browser().raw("post", `/api/files/upload/${legacyOrderId}`).attach("files", exampleWav(), "legacy-voice-note.wav");
    expect(upload.status).toBe(200);
    expect(upload.body.results).toMatchObject([{ outcome: "completed", file: { extension: "wav", stageKey: null } }]);
  });

  it("sends a message on the order thread and reads it back", async () => {
    const input = { orderId, body: "Is the delivery date confirmed?", idempotencyKey: "journey-customer-msg-0001" };
    await expectCsrfRequired("engagement.messages.send", input);
    const sent = await browser().mutate<{ publicId: string }>("engagement.messages.send", input);
    const message = Browser.ok(sent);
    await expectAudited(sent.requestId, "engagement.message.sent");
    // Idempotent replay returns the same message instead of posting twice.
    const replay = Browser.ok(await browser().mutate<{ publicId: string }>("engagement.messages.send", input));
    expect(replay.publicId).toBe(message.publicId);
    const thread = JSON.stringify(Browser.ok(await browser().query("engagement.messages.listByOrder", { orderId })));
    expect(thread).toContain("Is the delivery date confirmed?");
    expect(thread.split(message.publicId).length - 1).toBe(1);
  });

  it("signs out: cookies are cleared and the old session token is dead", async () => {
    const token = browser().sessionToken!;
    await expectCsrfRequired("identity.signOut");
    const out = await browser().mutate("identity.signOut");
    Browser.ok(out);
    await expectAudited(out.requestId, "auth.logout");
    const cleared = out.res.headers["set-cookie"] as unknown as string[];
    expect(cleared.some((line) => line.startsWith("__Host-rp_session=;") && /Expires=Thu, 01 Jan 1970/.test(line))).toBe(true);
    expect(browser().sessionToken).toBeUndefined();

    const replayed = sys.browser();
    replayed.jar.set(sys.config.sessionCookieName, { value: token, attributes: [] });
    const me = await replayed.query("identity.me");
    expect(me.error?.safe.domainCode).toBe("UNAUTHENTICATED");
    void secret;
  });
});
