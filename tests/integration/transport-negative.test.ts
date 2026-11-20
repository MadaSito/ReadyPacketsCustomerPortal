/**
 * Transport negatives (d), assembled system in the non-preview `test` profile: the preview header session
 * transport is ignored, no response ever carries a previewLink or preview transport header, unknown Hosts are
 * refused (alias hosts redirect to canonical), and cross-site / missing-Origin / bad-CSRF mutations are refused
 * at the edge with a durable audit note under the response's request id. See tests/integration/README.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HEADER_PREVIEW_CSRF_SET, HEADER_PREVIEW_SESSION, HEADER_PREVIEW_SESSION_SET,
} from "../../shared/sessionTransportHeaders.js";
import {
  Browser, bootstrapAdmin, createSystem, freshProbeAddress, ORIGIN, registerCustomer, responseLog, stepUp,
  type ReadyAdmin, type ReadyCustomer, type System,
} from "./harness.js";

let sys: System;
let admin: ReadyAdmin;
let customer: ReadyCustomer;

beforeAll(async () => {
  sys = await createSystem();
  expect(sys.config.deploymentProfile).toBe("test");
  admin = await bootstrapAdmin(sys);
  customer = await registerCustomer(sys, "tess.transport@example.test", "Tess Transport");
}, 120_000);

afterAll(async () => sys?.close());

describe("transport negatives (non-preview profile)", () => {
  it("ignores the preview header session transport, even with a valid live session token", async () => {
    const token = customer.browser.sessionToken;
    expect(token).toBeTruthy();
    Browser.ok(await customer.browser.query("identity.me")); // the token is live over the cookie transport
    const stranger = sys.browser();
    const res = await stranger.raw("get", `/api/trpc/identity.me?input=${encodeURIComponent(JSON.stringify({ json: null }))}`)
      .set(HEADER_PREVIEW_SESSION, token!);
    expect(res.status).toBe(401);
    expect(res.body.error.json.data.safe.domainCode).toBe("UNAUTHENTICATED");
    // The header transport also cannot carry a mutation.
    const mutation = await stranger.raw("post", "/api/trpc/identity.signOut").set(HEADER_PREVIEW_SESSION, token!).send({ json: null });
    expect(mutation.status).toBe(403);
    Browser.ok(await customer.browser.query("identity.me")); // the real session is untouched
  });

  it("never returns a previewLink or preview transport header from any link-issuing flow", async () => {
    const anonymous = sys.browser();
    await anonymous.primeCsrf();
    Browser.ok(await anonymous.mutate("identity.register", { email: "late.verifier@example.test", name: "Late Verifier", password: "correct horse battery staple 42" }));
    Browser.ok(await anonymous.mutate("identity.requestPasswordReset", { email: customer.email }));
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    const invited = Browser.ok(await admin.browser.mutate<{ customerId: string }>("identity.admin.customers.create", {
      email: "pending.invitee@example.test", name: "Pending Invitee",
    }));
    sys.clock.advance(61_000); // past the 60 s resend cooldown
    Browser.ok(await admin.browser.mutate("identity.admin.customers.resendInvitation", { customerId: invited.customerId }));
    const staff = Browser.ok(await admin.browser.mutate<{ userId: string }>("identity.admin.staff.create", {
      email: "pat.pending@example.test", name: "Pat Pending", role: "staff",
    }));
    sys.clock.advance(61_000);
    Browser.ok(await admin.browser.mutate("identity.admin.staff.resendInvitation", { userId: staff.userId }));
    await sys.drainJobs();

    expect(responseLog.length).toBeGreaterThan(20);
    const offenders = responseLog.filter((r) =>
      /previewLink/i.test(r.text) ||
      [HEADER_PREVIEW_SESSION, HEADER_PREVIEW_SESSION_SET, HEADER_PREVIEW_CSRF_SET].some((h) => h in r.headers));
    expect(offenders.map((r) => `${r.status} ${r.path}`)).toEqual([]);
  });

  it("refuses an unknown Host and redirects an alias host to the canonical origin", async () => {
    const wrong = await sys.browser({ host: "evil.example.test" }).raw("get", "/api/csrf");
    expect(wrong.status).toBe(400);
    expect(wrong.body.safe.reasonCode).toBe("HOST_NOT_ALLOWED");
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    const wrongMutation = await sys.browser({ host: "evil.example.test" }).raw("post", "/api/trpc/identity.signOut").send({ json: null });
    expect(wrongMutation.status).toBe(400);

    const alias = await sys.browser({ host: "portal.readypackets.test" }).raw("get", "/orders?tab=open");
    expect(alias.status).toBe(308);
    expect(alias.headers.location).toBe(`${ORIGIN}/orders?tab=open`);
  });

  it("refuses cross-site, missing and look-alike Origins on mutations, each with an audit note", async () => {
    const variants: [string, { origin?: string | null; fetchSite?: string | null }][] = [
      ["cross-site Origin", { origin: "https://evil.example.test", fetchSite: "cross-site" }],
      ["canonical Origin but Sec-Fetch-Site cross-site", { fetchSite: "cross-site" }],
      ["same-site sibling", { origin: "https://portal.readypackets.test", fetchSite: "same-site" }],
      ["scheme downgrade", { origin: "http://my.readypackets.test", fetchSite: null }],
      ["opaque null Origin", { origin: "null", fetchSite: null }],
      ["missing Origin", { origin: null, fetchSite: null }],
    ];
    for (const [label, options] of variants) {
      const browser = sys.browser(options);
      // Reuse the customer's cookies: a forged cross-site request rides the victim's credentials.
      const forged = await browser.raw("post", "/api/trpc/identity.signOut", { address: freshProbeAddress() })
        .set("Cookie", `${sys.config.sessionCookieName}=${customer.browser.sessionToken}; ${sys.config.csrfCookieName}=${customer.browser.csrfToken}`)
        .set("x-rp-csrf", customer.browser.csrfToken!)
        .send({ json: null });
      expect({ label, status: forged.status, body: forged.body as unknown }).toMatchObject({
        label, status: 403, body: { error: { json: { data: { safe: { reasonCode: "ORIGIN_NOT_ALLOWED" } } } } },
      });
      const requestId = String(forged.headers["x-request-id"]);
      expect(await sys.audit({ requestId, eventName: "http.origin.denied" }), label).toHaveLength(1);
    }
    Browser.ok(await customer.browser.query("identity.me")); // none of them signed the victim out
  });

  it("refuses same-origin mutations with a missing or mismatched CSRF token", async () => {
    for (const [label, csrf] of [["missing", null], ["mismatched", "A".repeat(43)]] as const) {
      const refused = await customer.browser.mutate("identity.signOut", undefined, { csrf, address: freshProbeAddress() });
      expect(refused.status, label).toBe(403);
      expect(refused.error?.safe.reasonCode, label).toBe("CSRF_INVALID");
      expect(await sys.audit({ requestId: refused.requestId, eventName: "http.csrf.denied" }), label).toHaveLength(1);
    }
    Browser.ok(await customer.browser.query("identity.me"));
  });
});
