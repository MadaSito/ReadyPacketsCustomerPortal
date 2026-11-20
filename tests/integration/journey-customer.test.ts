/**
 * Journey (a): a customer registers, verifies, enrols MFA, orders, attaches a file and signs out —
 * through the assembled system exactly as a browser would. See tests/integration/README.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleWav } from "../../server/modules/files/fixtures.test-support.js";
import {
  Browser, bootstrapAdmin, createSystem, linkToken, seedProduct, STRONG_PASSWORD, totpCode, type System,
  freshProbeAddress,
} from "./harness.js";

const EMAIL = "casey.customer@example.test";
let sys: System;
let productId: string;
const browser = () => customer;
let customer: Browser;

beforeAll(async () => {
  sys = await createSystem();
  const admin = await bootstrapAdmin(sys);
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

  it("uploads a file to the order and downloads it with a single-use ticket sent in the POST body", async () => {
    const bytes = exampleWav();
    const noCsrf = await browser().raw("post", `/api/files/upload/${orderId}`, { csrf: null }).attach("files", bytes, "voice-note.wav");
    expect(noCsrf.status).toBe(403);
    const upload = await browser().raw("post", `/api/files/upload/${orderId}`).attach("files", bytes, "voice-note.wav");
    expect(upload.status).toBe(200);
    expect(upload.body.results).toEqual([expect.objectContaining({ outcome: "completed", file: expect.objectContaining({ extension: "wav" }) })]);
    const fileId = upload.body.results[0].file.publicId as string;
    await expectAudited(String(upload.headers["x-request-id"]), "file.uploaded");

    const listed = Browser.ok(await browser().query<{ items: { publicId: string }[] }>("files.list", { orderId }));
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
