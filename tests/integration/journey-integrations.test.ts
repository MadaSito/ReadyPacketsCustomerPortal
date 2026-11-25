/**
 * Journey (e): integrations console against the assembled system.
 *  - Analytics config is a step-up mutation; the public payload exposes only non-secret identifiers.
 *  - The page CSP gains vendor origins only while a vendor is enabled, only on anonymous navigations to the
 *    reviewed public paths, and loses them again when switched off.
 *  - The SMTP password is write-only: never returned, never in any response body or audit attribute.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, bootstrapAdmin, createSystem, responseLog, stepUp, type ReadyAdmin, type System } from "./harness.js";

const CLARITY_ID = "rpclarity42";
const POSTHOG_KEY = "phc_ReadyPacketsJourneyKey123";
const POSTHOG_HOST = "https://eu.i.posthog.com";
const SMTP_SECRET = "Relay-Secret-9f3c1d7e-NeverEcho";
const RELAY = "10.20.0.25";

let sys: System;
let admin: ReadyAdmin;

beforeAll(async () => {
  sys = await createSystem({}, { spaShell: true });
  admin = await bootstrapAdmin(sys, "integrations.admin@example.test");
});
afterAll(async () => sys?.close());

type Csp = Map<string, string[]>;
function parseCsp(header: unknown): Csp {
  const map: Csp = new Map();
  for (const part of String(header ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources);
  }
  return map;
}

async function navigate(browser: Browser, path: string): Promise<{ status: number; csp: Csp }> {
  const res = browser.absorb(await browser.raw("get", path).set("Accept", "text/html").set("Sec-Fetch-Mode", "navigate").set("Sec-Fetch-Dest", "document"));
  return { status: res.status, csp: parseCsp(res.headers["content-security-policy"]) };
}

const vendorSources = (csp: Csp) => [...(csp.get("script-src") ?? []), ...(csp.get("connect-src") ?? [])]
  .filter((s) => /clarity\.ms|c\.bing\.com|posthog\.com/.test(s));

const visitor = () => sys.browser({ origin: null, fetchSite: "none" });

async function updateAnalytics(input: Record<string, unknown>) {
  return admin.browser.mutate("integrations.admin.analytics.update", {
    clarityEnabled: false, clarityProjectId: "", posthogEnabled: false, posthogProjectKey: "", posthogHost: POSTHOG_HOST, ...input,
  });
}

describe("integrations journey (assembled system)", () => {
  it("refuses analytics changes without step-up, then accepts them after verification", async () => {
    const before = await updateAnalytics({ clarityEnabled: true, clarityProjectId: CLARITY_ID });
    expect(before.error).toBeDefined();
    expect(before.error?.safe?.reasonCode).toMatch(/STEP_UP/);
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));

    const invalid = await updateAnalytics({ clarityEnabled: true, clarityProjectId: "<script>" });
    expect(invalid.status).toBe(400);
    const personal = await updateAnalytics({ posthogEnabled: true, posthogProjectKey: "phx_personalKeyNotAllowed123" });
    expect(personal.status).toBe(400);
  });

  it("has no vendor origins in the CSP while analytics is off", async () => {
    const page = await navigate(visitor(), "/privacy");
    expect(page.status).toBe(200);
    expect(page.csp.get("script-src")).toBeDefined();
    expect(vendorSources(page.csp)).toEqual([]);
    const pub = Browser.ok(await visitor().query("integrations.publicAnalyticsConfig"));
    expect(pub).toEqual({ clarity: { enabled: false, projectId: null }, posthog: { enabled: false, key: null, host: null } });
  });

  it("enabling Clarity exposes only its project id and adds only Clarity origins on reviewed anonymous pages", async () => {
    const saved = await updateAnalytics({ clarityEnabled: true, clarityProjectId: CLARITY_ID });
    Browser.ok(saved);
    expect((await sys.audit({ requestId: saved.requestId })).map((e) => e.eventName)).toContain("integration.analytics.updated");

    const pub = await visitor().query("integrations.publicAnalyticsConfig");
    expect(Browser.ok(pub)).toEqual({ clarity: { enabled: true, projectId: CLARITY_ID }, posthog: { enabled: false, key: null, host: null } });
    expect(Object.keys(pub.res.body.result.data.json)).toEqual(["clarity", "posthog"]);

    const privacy = await navigate(visitor(), "/privacy");
    expect(privacy.csp.get("script-src")).toContain("https://www.clarity.ms");
    expect(privacy.csp.get("connect-src")).toContain("https://www.clarity.ms");
    expect(vendorSources(privacy.csp).some((s) => s.includes("posthog"))).toBe(false);
    expect(privacy.csp.get("script-src")).not.toContain("'unsafe-inline'");

    // Sensitive and authenticated screens never gain vendor origins.
    for (const path of ["/login", "/account", "/admin", "/orders"]) {
      expect(vendorSources((await navigate(visitor(), path)).csp)).toEqual([]);
    }
    expect(vendorSources((await navigate(admin.browser, "/privacy")).csp)).toEqual([]);
    // A query string or non-navigation request does not choose the analytics policy either.
    const api = admin.browser.absorb(await visitor().raw("get", "/privacy").set("Accept", "application/json"));
    expect(vendorSources(parseCsp(api.headers["content-security-policy"]))).toEqual([]);
  });

  it("enabling PostHog adds exactly its host to connect-src (no script origin); switching both off removes everything", async () => {
    Browser.ok(await updateAnalytics({ clarityEnabled: true, clarityProjectId: CLARITY_ID, posthogEnabled: true, posthogProjectKey: POSTHOG_KEY, posthogHost: POSTHOG_HOST }));
    const pub = Browser.ok(await visitor().query("integrations.publicAnalyticsConfig"));
    expect(pub).toEqual({ clarity: { enabled: true, projectId: CLARITY_ID }, posthog: { enabled: true, key: POSTHOG_KEY, host: POSTHOG_HOST } });
    const terms = await navigate(visitor(), "/terms");
    expect(terms.csp.get("connect-src")).toContain(POSTHOG_HOST);
    expect((terms.csp.get("script-src") ?? []).some((s) => s.includes("posthog"))).toBe(false);

    Browser.ok(await updateAnalytics({ clarityProjectId: CLARITY_ID, posthogProjectKey: POSTHOG_KEY }));
    expect(vendorSources((await navigate(visitor(), "/terms")).csp)).toEqual([]);
    expect(Browser.ok(await visitor().query("integrations.publicAnalyticsConfig")))
      .toEqual({ clarity: { enabled: false, projectId: null }, posthog: { enabled: false, key: null, host: null } });
  });

  it("stores the SMTP password write-only and never returns or audits it", async () => {
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    // A private relay is refused until an explicit egress rule allows it.
    const relay = { enabled: true, host: RELAY, port: 587, tlsMode: "starttls", username: "relay-user", password: SMTP_SECRET, fromAddress: "noreply@example.test", fromName: "ReadyPackets" };
    const refused = await admin.browser.mutate("integrations.admin.smtp.update", relay);
    expect(refused.error).toBeDefined();
    Browser.ok(await admin.browser.mutate("integrations.admin.egress.create", {
      purpose: "smtp", matchType: "ip", pattern: RELAY, port: 587, protocol: "smtp:", allowPrivateAddress: true, justification: "Internal mail relay for the journey",
    }));
    const saved = await admin.browser.mutate("integrations.admin.smtp.update", relay);
    Browser.ok(saved);

    const view = Browser.ok(await admin.browser.query<Record<string, unknown>>("integrations.admin.smtp.get"));
    expect(view).toMatchObject({ host: RELAY, port: 587, username: "relay-user", passwordConfigured: true });
    expect(view).not.toHaveProperty("password");

    // Omitting the password keeps it; null clears it.
    const { password: _omit, ...keep } = relay;
    Browser.ok(await admin.browser.mutate("integrations.admin.smtp.update", keep));
    expect(Browser.ok(await admin.browser.query<{ passwordConfigured: boolean }>("integrations.admin.smtp.get")).passwordConfigured).toBe(true);

    for (const entry of responseLog) expect(entry.text).not.toContain(SMTP_SECRET);
    const audit = await sys.audit({});
    for (const event of audit) expect(JSON.stringify(event)).not.toContain(SMTP_SECRET);
    expect((await sys.audit({ requestId: saved.requestId })).length).toBeGreaterThan(0);

    // Clearing the password while SMTP stays enabled is refused as incomplete; switch it off first.
    const incomplete = await admin.browser.mutate("integrations.admin.smtp.update", { ...relay, password: null });
    expect(incomplete.error?.safe?.reasonCode).toBe("SMTP_CONFIG_INCOMPLETE");
    Browser.ok(await admin.browser.mutate("integrations.admin.smtp.update", { ...relay, enabled: false, password: null }));
    expect(Browser.ok(await admin.browser.query<{ passwordConfigured: boolean }>("integrations.admin.smtp.get")).passwordConfigured).toBe(false);
  });

  it("reports Stripe, SAML, and SharePoint as available-but-disabled adapters and refuses to enable Stripe before setup prerequisites", async () => {
    const providers = Browser.ok(
      await admin.browser.query<{ key: string; scaffoldOnly: boolean; state: string; verified: boolean }[]>(
        "integrations.admin.providers",
      ),
    );
    for (const key of ["stripe", "saml", "sharepoint"]) {
      expect(providers.find((p) => p.key === key)).toMatchObject({
        scaffoldOnly: false,
        state: "disabled",
        verified: false,
      });
    }

    const legacyScaffoldEnable = await admin.browser.mutate("integrations.admin.stripe.update", {
      enabled: true,
      publishableKey: "",
    });
    expect(legacyScaffoldEnable.error?.safe?.reasonCode).toBe("STRIPE_NOT_AVAILABLE_IN_RELEASE");

    const readiness = Browser.ok(
      await admin.browser.query<{
        provider: string;
        onlineEnabled: boolean;
        checklist: { key: string; ready: boolean }[];
      }>("payments.admin.readiness"),
    );
    expect(readiness.provider).toBe("none");
    expect(readiness.onlineEnabled).toBe(false);
    expect(readiness.checklist.find((item) => item.key === "stripe_secret_key")?.ready).toBe(false);
    expect(readiness.checklist.find((item) => item.key === "stripe_webhook_secret")?.ready).toBe(false);

    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    const enableWithoutSetup = await admin.browser.mutate("payments.admin.updateSettings", {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
    });
    expect(enableWithoutSetup.error?.safe?.reasonCode).toBe("FRESH_CREDENTIALS_REQUIRED");
  });
});
