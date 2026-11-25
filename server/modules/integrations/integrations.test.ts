/**
 * Integrations module — comprehensive server test suite.
 *
 * Covers:
 *  1. SSRF / Egress IP & hostname classification matrix (IPv4, IPv6, IPv4-mapped/compatible/NAT64/6to4/Teredo
 *     transition bypasses, RFC 9637 `3fff::/20`, octal/decimal/hex/shorthand host tricks, DNS rebinding,
 *     redirect refusal, purpose-scoped allowlisting).
 *  2. Provider registry & health truthfulness (`disabled` / `not_configured` / `degraded` / `failing` / `ok`).
 *  3. SMTP TLS enforcement, plaintext refusal, CRLF header injection defense, secret write-only encryption,
 *     and outbox `send()` outcome taxonomy (`not_configured`, `accepted`, `rejected`, `unknown`).
 *  4. Analytics (Clarity + PostHog) strict identifier/origin validation, public safe config, and route-exact CSP.
 *  5. Stripe signature-verified raw-body diagnostic webhook, replay window, idempotency, payload-mismatch detection,
 *     and Express IPv6 /64 rate-limit key normalization.
 *  6. Live SAML 2.0 / Entra SSO, SharePoint / Microsoft 365 file-sync, and Stripe hub status derivation.
 *  7. Zero-trust authorization & cross-model review regression tests:
 *     - Customer, staff, step-up-missing admin, and remediation-pending admin rejected.
 *     - In-transaction `identity.sessions.assertCurrent(principal, tx)` actor revocation rejection + rollback.
 *     - Single-connection pool (`connectionLimit: 1`) non-deadlock verification (`tx` forwarding).
 *     - Audit-before-delete ordering on allowlist removal + fail-closed audit rollback on every mutation.
 */
import { createHmac } from "node:crypto";
import { TRPCError } from "@trpc/server";
import express from "express";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditUnavailableError, forbidden } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Db, SessionPrincipal, Tx } from "../../core/types.js";
import { platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import { createTestDeps, fakePrincipal, withTestRequest, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { registerSignedIntegrationWebhooks } from "./http.js";
import {
  createIntegrationsModule,
  createPinnedLookup,
  STRIPE_LEDGER_MUTATION_ENABLED,
  STRIPE_PAYMENTS_SETUP_NOTICE,
  type IntegrationsModule,
} from "./index.js";
import { parseIpAddress, precheckHost, type IpAddressClass } from "./ipPolicy.js";
import { integrationsRouter } from "./router.js";
import {
  integrationEgressAllowlist,
  integrationProviderChecks,
  integrationWebhookEvents,
} from "./schema.js";

function makeStepUpAdmin(h: TestHarness, overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    role: "admin",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: now,
    ...overrides,
  });
}

function signStripeWebhook(rawBody: Buffer, secret: string, timestampSec: number): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestampSec}.`, "utf8")
    .update(rawBody)
    .digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

describe("integrations module — ipPolicy & SSRF matrix", () => {
  it("classifies loopback, private, link-local, CGNAT, multicast, metadata, documentation and IPv6 transition ranges", () => {
    const blockedCases: Array<[string, IpAddressClass]> = [
      ["127.0.0.1", "LOOPBACK"],
      ["127.255.255.254", "LOOPBACK"],
      ["::1", "LOOPBACK"],
      ["0.0.0.0", "UNSPECIFIED"],
      ["::", "UNSPECIFIED"],
      ["169.254.10.20", "LINK_LOCAL"],
      ["fe80::1", "LINK_LOCAL"],
      ["169.254.169.254", "CLOUD_METADATA"],
      ["169.254.170.2", "CLOUD_METADATA"],
      ["100.100.100.200", "CLOUD_METADATA"],
      ["fd00:ec2::254", "CLOUD_METADATA"],
      ["::ffff:169.254.169.254", "CLOUD_METADATA"],
      ["10.0.0.1", "PRIVATE_NETWORK"],
      ["172.16.5.4", "PRIVATE_NETWORK"],
      ["192.168.1.50", "PRIVATE_NETWORK"],
      ["fc00::1", "PRIVATE_NETWORK"],
      ["fd12:3456:789a::1", "PRIVATE_NETWORK"],
      ["100.64.0.1", "PRIVATE_NETWORK"],
      ["224.0.0.1", "MULTICAST_OR_RESERVED"],
      ["ff02::1", "MULTICAST_OR_RESERVED"],
      ["255.255.255.255", "BROADCAST"],
      ["192.0.2.1", "DOCUMENTATION_OR_RESERVED"],
      ["198.51.100.10", "DOCUMENTATION_OR_RESERVED"],
      ["203.0.113.5", "DOCUMENTATION_OR_RESERVED"],
      ["2001:db8::1", "DOCUMENTATION_OR_RESERVED"],
      ["3fff::1", "DOCUMENTATION_OR_RESERVED"],
      ["5f00::1", "DOCUMENTATION_OR_RESERVED"],
      // Transition embeddings MUST return IPV4_TRANSITION_ADDRESS (non-allowlistable!)
      ["::ffff:10.0.0.1", "IPV4_TRANSITION_ADDRESS"],
      ["::ffff:93.184.216.34", "IPV4_TRANSITION_ADDRESS"],
      ["::ffff:0:10.0.0.1", "IPV4_TRANSITION_ADDRESS"],
      ["64:ff9b::10.0.0.1", "IPV4_TRANSITION_ADDRESS"],
      ["2002:0a00:0001::1", "IPV4_TRANSITION_ADDRESS"],
      ["2001:0000:4136:e378:8000:63bf:3fff:fdd2", "IPV4_TRANSITION_ADDRESS"],
    ];

    for (const [ip, expectedClass] of blockedCases) {
      const parsed = parseIpAddress(ip);
      expect(parsed, `expected ${ip} to parse`).not.toBeNull();
      expect(parsed?.classification, `classification mismatch for ${ip}`).toBe(expectedClass);
    }

    // Zone identifiers (`%eth0`) are rejected outright by both `parseIpAddress` and `precheckHost`
    expect(parseIpAddress("fe80::1%eth0")).toBeNull();
    expect(precheckHost("[fe80::1%eth0]").ok).toBe(false);

    // Legitimate global unicast IPv4 & IPv6
    expect(parseIpAddress("93.184.216.34")).toMatchObject({
      family: 4,
      classification: "PUBLIC",
    });
    expect(parseIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toMatchObject({
      family: 6,
      classification: "PUBLIC",
    });
  });

  it("rejects decimal, octal, hex, shorthand IPv4 and localhost/localdomain hostname tricks", () => {
    const badHosts = [
      "localhost",
      "sub.localhost",
      "localhost.localdomain",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "2130706433", // decimal 127.0.0.1
      "0177.0.0.1", // octal 127.0.0.1
      "0x7f.0.0.1", // hex 127.0.0.1
      "0x7f000001", // single-hex 127.0.0.1
      "127.1", // shorthand 127.0.0.1
      "10.1.2", // 3-part shorthand
      "singlelabel",
    ];
    for (const host of badHosts) {
      const res = precheckHost(host);
      expect(res.ok, `expected hostname '${host}' to be rejected`).toBe(false);
    }

    expect(precheckHost("smtp.mailprovider.example")).toEqual({
      ok: true,
      kind: "dns",
      normalizedHost: "smtp.mailprovider.example",
    });
  });
});

describe("integrations module — DB-backed integration suite", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let mod: IntegrationsModule;
  let dnsMap: Map<string, Array<{ address: string; family: 4 | 6 }>>;

  beforeAll(async () => {
    tdb = await createTestDb({
      schema: {
        platformSettings,
        integrationEgressAllowlist,
        integrationProviderChecks,
        integrationWebhookEvents,
      },
    });
  });

  afterAll(async () => {
    await tdb.cleanup();
  });

  beforeEach(async () => {
    await tdb.db.delete(integrationEgressAllowlist);
    await tdb.db.delete(integrationProviderChecks);
    await tdb.db.delete(integrationWebhookEvents);
    await tdb.db.delete(platformSettings);

    dnsMap = new Map([
      ["smtp.public-mail.example", [{ address: "93.184.216.34", family: 4 }]],
      ["siem.internal.corp.example", [{ address: "10.24.10.50", family: 4 }]],
      ["rebind.attacker.example", [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]],
      ["metadata.attacker.example", [{ address: "169.254.169.254", family: 4 }]],
      ["analytics.selfhosted.example", [{ address: "93.184.216.35", family: 4 }]],
    ]);

    h = createTestDeps({ db: tdb.db });
    // Use the real DB-backed PlatformSettingsStore so AES-256-GCM secrets & `tx` semantics are exercised!
    const realSettings = createSettingsStore({
      db: tdb.db,
      clock: h.clock,
      logger: h.deps.logger,
      crypto: h.deps.crypto,
      audit: h.audit,
    });
    h.deps.settings = realSettings;
    h.services.settings = realSettings;
    (h.services as unknown as { identity: unknown }).identity = {
      getUser: async (userId: number, opts?: { tx?: Tx }) => ({
        id: userId,
        publicId: "01JADMINUSER00000000000001",
        role: "admin",
        status: "active",
        email: "ops@readypackets.example",
        name: "Ops Admin",
        customerRef: null,
        emailVerified: true,
        authSource: "local",
        mustChangePassword: false,
        hasPassword: true,
        createdAt: h.clock.now(),
        version: 1,
        ...(opts?.tx ? {} : {}),
      }),
      sessions: {
        assertCurrent: async (p: SessionPrincipal, tx?: Tx) => {
          expect(tx).toBeDefined();
          return p;
        },
      },
    };

    mod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async (hostname) => {
          const records = dnsMap.get(hostname);
          if (!records) throw new Error(`ENOTFOUND ${hostname}`);
          return records;
        },
        httpsRequester: async () => ({
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
          body: Buffer.alloc(0),
        }),
      },
      smtpTransportFactory: () => ({
        sendMail: async () => ({
          accepted: ["recipient@example.com"],
          rejected: [],
        }),
        close: () => {},
      }),
    });
    h.services.integrations = mod;
  });

  it("enforces egress SSRF policy, blocks DNS rebinding & redirects, and scopes explicit private allowlist rules", async () => {
    const admin = makeStepUpAdmin(h);

    // 1. Public HTTPS webhook succeeds and returns pinned address + SNI
    const pinnedPublic = await mod.egress.assertAllowed("https://smtp.public-mail.example/hook", "webhook");
    expect(pinnedPublic).toMatchObject({
      hostname: "smtp.public-mail.example",
      address: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https:",
      servername: "smtp.public-mail.example",
    });
    expect(pinnedPublic.allowlistRulePublicId).toBeUndefined();

    // 2. Dual-record DNS rebinding (`[public, 127.0.0.1]`) is refused fail-closed
    await expect(mod.egress.assertAllowed("https://rebind.attacker.example/hook", "webhook")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 3. Cloud metadata DNS resolution is refused
    await expect(mod.egress.assertAllowed("https://metadata.attacker.example/latest", "webhook")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 4. Disallowed scheme (`http:` for webhook) and disallowed port (`6379`) refused
    await expect(mod.egress.assertAllowed("http://smtp.public-mail.example/hook", "webhook")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      mod.egress.assertAllowed({ host: "smtp.public-mail.example", port: 6379, protocol: "tls:" }, "siem"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 5. Private RFC 1918 SIEM host is refused by default until explicitly allowlisted for `siem`
    await expect(
      mod.egress.assertAllowed({ host: "siem.internal.corp.example", port: 6514, protocol: "tls:" }, "siem"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Cloud metadata (`169.254.169.254`) allowlist rules are unconditionally rejected even if an admin attempts to create them
    await expect(
      withTestRequest(
        () =>
          mod.egress.createAllowlistRule(admin, {
            purpose: "siem",
            matchType: "ip",
            pattern: "169.254.169.254",
            port: 6514,
            protocol: "tls:",
            allowPrivateAddress: true,
            justification: "Attempted cloud metadata rule",
          }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Create legitimate private SIEM allowlist rule (step-up + audited)
    const rule = await withTestRequest(
      () =>
        mod.egress.createAllowlistRule(admin, {
          purpose: "siem",
          matchType: "host",
          pattern: "siem.internal.corp.example",
          port: 6514,
          protocol: "tls:",
          allowPrivateAddress: true,
          justification: "On-prem syslog TLS collector in corp VLAN",
        }),
      admin,
    );
    expect(rule.allowPrivateAddress).toBe(true);

    // Admitted ONLY for `siem` on port 6514/tls:, NOT for `smtp` or `webhook`!
    const pinnedSiem = await mod.egress.assertAllowed(
      { host: "siem.internal.corp.example", port: 6514, protocol: "tls:" },
      "siem",
    );
    expect(pinnedSiem.address).toBe("10.24.10.50");
    expect(pinnedSiem.allowlistRulePublicId).toBe(rule.publicId);

    await expect(
      mod.egress.assertAllowed({ host: "siem.internal.corp.example", port: 443, protocol: "https:" }, "webhook"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 6. IPv4-mapped IPv6 (`::ffff:10.24.10.50`) is NEVER admitted even when `10.24.0.0/16` CIDR is allowlisted
    await withTestRequest(
      () =>
        mod.egress.createAllowlistRule(admin, {
          purpose: "siem",
          matchType: "cidr",
          pattern: "10.24.0.0/16",
          port: 6514,
          protocol: "tls:",
          allowPrivateAddress: true,
          justification: "Corp SIEM subnet CIDR",
        }),
      admin,
    );
    await expect(
      mod.egress.assertAllowed({ host: "[::ffff:10.24.10.50]", port: 6514, protocol: "tls:" }, "siem"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 7. `fetchPinned` refuses HTTP 3xx redirects rather than following to metadata
    await expect(mod.egress.fetchPinned("https://smtp.public-mail.example/hook", "webhook")).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "EGRESS_REDIRECT_REFUSED",
    });

    // 8. Node 22 `createPinnedLookup` network-free contract (`{ all: true }` array + scalar forms)
    const pinnedLookup = createPinnedLookup(pinnedPublic);
    const allRes = await new Promise<unknown>((resolve, reject) => {
      pinnedLookup("ignored.attacker.example", { all: true }, (err, address) => {
        if (err) reject(err);
        else resolve(address);
      });
    });
    expect(allRes).toEqual([{ address: "93.184.216.34", family: 4 }]);

    const scalarRes = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
      pinnedLookup("ignored.attacker.example", { family: 4 }, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
    expect(scalarRes).toEqual({ address: "93.184.216.34", family: 4 });

    // 9. DNS lookup deadline refuses hanging resolvers (`EGRESS_DNS_TIMEOUT`)
    const slowDnsMod = createIntegrationsModule(h.deps, {
      egress: {
        dnsTimeoutMs: 20,
        dnsLookup: () => new Promise(() => {}),
      },
    });
    await expect(
      slowDnsMod.egress.assertAllowed("https://hanging.example/hook", "webhook"),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      reasonCode: "EGRESS_DNS_TIMEOUT",
    });
  });

  it("reports truthful provider states and never emits health 'ok' until a real check succeeds", async () => {
    const admin = makeStepUpAdmin(h);

    // Fresh installation: every provider is disabled or not_configured; zero 'ok' or 'failing'
    const initialHealth = await mod.health();
    expect(initialHealth.map((c) => [c.component, c.state])).toEqual([
      ["mail.smtp", "not_configured"],
      ["mail.graph", "not_configured"],
      ["integrations.clarity", "not_configured"],
      ["integrations.posthog", "not_configured"],
      ["integrations.stripe", "disabled"],
      ["integrations.saml", "not_configured"],
      ["integrations.sharepoint", "disabled"],
      ["integrations.production", "disabled"],
      ["integrations.webhooks", "disabled"],
    ]);

    // Configure & enable SMTP WITHOUT running test message yet -> verified=false, health MUST be 'degraded' (never 'ok')!
    const smtpUnverified = await withTestRequest(
      () =>
        mod.smtp.updateConfig(admin, {
          enabled: true,
          host: "smtp.public-mail.example",
          port: 587,
          tlsMode: "starttls",
          username: "apikey",
          password: "super-secret-smtp-password",
          fromAddress: "no-reply@readypackets.example",
          fromName: "ReadyPackets Portal",
        }),
      admin,
    );
    expect(smtpUnverified.configured).toBe(true);
    expect(smtpUnverified.verified).toBe(false);
    expect(smtpUnverified.state).toBe("configured");
    expect("password" in smtpUnverified).toBe(false);

    const healthBeforeVerify = await mod.health();
    expect(healthBeforeVerify.find((c) => c.component === "mail.smtp")?.state).toBe("degraded");

    // Run real test message -> flips verified=true and health to 'ok'!
    const testResult = await withTestRequest(
      () => mod.smtp.sendTestMessage(admin, { toAddress: "ops@readypackets.example" }),
      admin,
    );
    expect(testResult.outcome).toBe("accepted");

    const readinessAfterTest = await mod.smtp.getReadiness();
    expect(readinessAfterTest).toMatchObject({
      enabled: true,
      configured: true,
      verified: true,
      ready: true,
      state: "configured",
    });

    const healthAfterVerify = await mod.health();
    expect(healthAfterVerify.find((c) => c.component === "mail.smtp")?.state).toBe("ok");
  });

  it("enforces SMTP TLS, blocks plaintext & CRLF header injection, and classifies outbox send outcomes", async () => {
    const admin = makeStepUpAdmin(h);

    // 1. Plaintext port 25 rejected
    await expect(
      withTestRequest(
        () =>
          mod.smtp.updateConfig(admin, {
            enabled: true,
            host: "smtp.public-mail.example",
            port: 25,
            tlsMode: "starttls",
            username: "apikey",
            password: "secret-password",
            fromAddress: "no-reply@readypackets.example",
            fromName: "ReadyPackets",
          }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "SMTP_PORT_25_FORBIDDEN" });

    // 2. CRLF header injection in sender rejected
    await expect(
      withTestRequest(
        () =>
          mod.smtp.updateConfig(admin, {
            enabled: true,
            host: "smtp.public-mail.example",
            port: 587,
            tlsMode: "starttls",
            username: "apikey",
            password: "secret-password",
            fromAddress: "no-reply@readypackets.example",
            fromName: "ReadyPackets\r\nBcc: attacker@evil.example",
          }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // 3. When disabled, send() returns `not_configured`
    const unconfiguredOutcome = await mod.smtp.send({
      to: "customer@example.com",
      subject: "Order update",
      text: "Hello",
      html: "<p>Hello</p>",
      signal: new AbortController().signal,
    });
    expect(unconfiguredOutcome).toEqual({ outcome: "not_configured" });

    // Configure with custom transport spy to inspect TLS options and simulate post-DATA network drop
    let capturedTlsOpts: Record<string, unknown> | null = null;
    const inspectSmtpMessage = vi.fn();
    let mode: "ok" | "550" | "connreset" = "ok";

    const customMod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      smtpTransportFactory: (opts) => {
        capturedTlsOpts = opts as unknown as Record<string, unknown>;
        return {
          sendMail: async (message) => {
            inspectSmtpMessage(message);
            if (mode === "550") {
              throw Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 });
            }
            if (mode === "connreset") {
              throw Object.assign(new Error("socket hang up after DATA"), { code: "ECONNRESET" });
            }
            return { accepted: ["customer@example.com"], rejected: [] };
          },
          close: () => {},
        };
      },
    });

    await withTestRequest(
      () =>
        customMod.smtp.updateConfig(admin, {
          enabled: true,
          host: "smtp.public-mail.example",
          port: 587,
          tlsMode: "starttls",
          username: "apikey",
          password: "secret-password",
          fromAddress: "no-reply@readypackets.example",
          fromName: "ReadyPackets",
        }),
      admin,
    );

    // Header injection in recipient/subject rejected without network call
    const crlfRes = await customMod.smtp.send({
      to: "customer@example.com",
      subject: "Reset\r\nBcc: spy@evil.example",
      text: "Body",
      html: "<p>Body</p>",
      signal: new AbortController().signal,
    });
    expect(crlfRes).toEqual({ outcome: "rejected", retryable: false });

    // Normal delivery pins IP, sets SNI, enforces TLSv1.2 + cert verification
    const okRes = await customMod.smtp.send({
      to: "customer@example.com",
      subject: "Order ready",
      text: "Your order is ready.",
      html: "<p>Your order is ready.</p>",
      attachments: [{ filename: "RPR-2026-000032.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7\n") }],
      signal: new AbortController().signal,
    });
    expect(okRes).toEqual({ outcome: "accepted" });
    expect(inspectSmtpMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      attachments: [{ filename: "RPR-2026-000032.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7\n") }],
    }));
    expect(capturedTlsOpts).toMatchObject({
      host: "93.184.216.34",
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      tls: {
        servername: "smtp.public-mail.example",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
    });

    // Permanent 550 -> non-retryable rejected
    mode = "550";
    expect(
      await customMod.smtp.send({
        to: "customer@example.com",
        subject: "Order ready",
        text: "Body",
        html: "<p>Body</p>",
        signal: new AbortController().signal,
      }),
    ).toEqual({ outcome: "rejected", retryable: false });

    // Post-connection socket reset without SMTP status -> `unknown` (prevents duplicate outbox sends!)
    mode = "connreset";
    expect(
      await customMod.smtp.send({
        to: "customer@example.com",
        subject: "Order ready",
        text: "Body",
        html: "<p>Body</p>",
        signal: new AbortController().signal,
      }),
    ).toEqual({ outcome: "unknown" });

    // Security review regression: `sendTestMessage` authorizes actor + records durable `attempted`
    // audit in a short DB transaction BEFORE revealing secrets or invoking `smtpTransportFactory`!
    let sendMailInvocations = 0;
    const guardedMod = createIntegrationsModule(h.deps, {
      egress: { dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      smtpTransportFactory: () => {
        sendMailInvocations += 1;
        return {
          sendMail: async () => ({ accepted: ["ops@readypackets.example"], rejected: [] }),
          close: () => {},
        };
      },
    });

    (h.services as unknown as { identity: unknown }).identity = {
      sessions: {
        assertCurrent: async (_p: SessionPrincipal, tx?: Tx) => {
          expect(tx).toBeDefined();
          throw forbidden("REVOKED_BEFORE_SMTP_IO");
        },
      },
    };
    await expect(
      withTestRequest(() => guardedMod.smtp.sendTestMessage(admin, { toAddress: "ops@readypackets.example" }), admin),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "REVOKED_BEFORE_SMTP_IO" });
    expect(sendMailInvocations).toBe(0);

    (h.services as unknown as { identity: unknown }).identity = {
      getUser: async (userId: number) => ({
        id: userId,
        publicId: "01JADMINUSER00000000000001",
        role: "admin",
        status: "active",
        email: "ops@readypackets.example",
        name: "Ops Admin",
        customerRef: null,
        emailVerified: true,
        authSource: "local",
        mustChangePassword: false,
        hasPassword: true,
        createdAt: h.clock.now(),
        version: 1,
      }),
      sessions: { assertCurrent: async (p: SessionPrincipal) => p },
    };
    h.audit.failRecords = true;
    await expect(
      withTestRequest(() => guardedMod.smtp.sendTestMessage(admin, { toAddress: "ops@readypackets.example" }), admin),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(sendMailInvocations).toBe(0);
    h.audit.failRecords = false;
  });

  it("validates Clarity & PostHog identifiers strictly and scopes analyticsCsp to /privacy and /terms only", async () => {
    const admin = makeStepUpAdmin(h);

    // Default public config is completely disabled
    expect(await mod.analytics.getPublicConfig()).toEqual({
      clarity: { enabled: false, projectId: null },
      posthog: { enabled: false, key: null, host: null },
    });
    expect(await mod.analyticsCsp("/privacy")).toBeNull();

    // Reject script/HTML/path-ish Clarity inputs
    for (const badId of ["<script>alert(1)</script>", "abc/def", "javascript:1", "ab", "a".repeat(40)]) {
      await expect(
        withTestRequest(
          () =>
            mod.analytics.updateConfig(admin, {
              clarityEnabled: true,
              clarityProjectId: badId,
              posthogEnabled: false,
              posthogProjectKey: "",
              posthogHost: "https://us.i.posthog.com",
            }),
          admin,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }

    // Reject unallowlisted or HTTP PostHog host
    await expect(
      withTestRequest(
        () =>
          mod.analytics.updateConfig(admin, {
            clarityEnabled: false,
            clarityProjectId: "",
            posthogEnabled: true,
            posthogProjectKey: "phc_ValidToken1234567890",
            posthogHost: "https://unapproved.posthog.example",
          }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "INVALID_POSTHOG_HOST" });

    await expect(
      withTestRequest(
        () =>
          mod.analytics.updateConfig(admin, {
            clarityEnabled: false,
            clarityProjectId: "",
            posthogEnabled: true,
            posthogProjectKey: "phc_ValidToken1234567890",
            posthogHost: "http://us.i.posthog.com",
          }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Enable both Clarity and PostHog (with official cloud host)
    await withTestRequest(
      () =>
        mod.analytics.updateConfig(admin, {
          clarityEnabled: true,
          clarityProjectId: " clarity987abc ",
          posthogEnabled: true,
          posthogProjectKey: "phc_ProjectTokenAbc123456",
          posthogHost: "https://eu.i.posthog.com",
        }),
      admin,
    );

    expect(await mod.analytics.getPublicConfig()).toEqual({
      clarity: { enabled: true, projectId: "clarity987abc" },
      posthog: { enabled: true, key: "phc_ProjectTokenAbc123456", host: "https://eu.i.posthog.com" },
    });

    // CSP hook emits vendor origins ONLY on `/privacy` and `/terms`
    for (const allowedPath of ["/privacy", "/terms"]) {
      const csp = await mod.analyticsCsp(allowedPath);
      expect(csp).toEqual({
        scriptSrc: ["https://www.clarity.ms"],
        connectSrc: expect.arrayContaining(["https://www.clarity.ms", "https://eu.i.posthog.com"]),
      });
    }

    // Every auth, customer, file, message, invoice, admin and sub-route MUST return null CSP!
    const excludedRoutes = [
      "/",
      "/sign-in",
      "/register",
      "/mfa",
      "/recovery",
      "/account/security",
      "/orders",
      "/orders/01ORDER",
      "/files",
      "/messages",
      "/invoices",
      "/admin",
      "/admin/integrations",
      "/admin/integrations/analytics",
      "/privacy/extra",
      "/terms/extra",
    ];
    for (const route of excludedRoutes) {
      expect(await mod.analyticsCsp(route), `expected null CSP on ${route}`).toBeNull();
    }
  });

  it("keeps the legacy integrations Stripe diagnostic receiver inert, verifies webhook signatures idempotently, and leaves the compliance ledger unchanged", async () => {
    const admin = makeStepUpAdmin(h);
    const webhookSecret = "whsec_TestSigningSecretKey1234567890";
    const secretKey = "sk_test_SecretApiKeyValue1234567890";

    expect(STRIPE_LEDGER_MUTATION_ENABLED).toBe(false);
    const initialCfg = await mod.stripe.getConfig();
    expect(initialCfg).toMatchObject({
      enabled: false,
      summary: STRIPE_PAYMENTS_SETUP_NOTICE,
      paymentsSetupPath: "/admin/payments/setup",
      state: "disabled",
      verified: false,
    });

    // 1. Inert (`503`) when no webhook secret is stored
    const inertRes = await mod.stripe.handleSignedWebhook({
      rawBody: Buffer.from("{}"),
      signatureHeader: "t=1,v1=deadbeef",
    });
    expect(inertRes).toMatchObject({ httpStatus: 503, accepted: false, reasonCode: "STRIPE_NOT_CONFIGURED" });

    // 2. Attempting to enable Stripe via the legacy diagnostic endpoint directs callers to Payment Setup (`STRIPE_MANAGED_IN_PAYMENTS`)
    await expect(
      withTestRequest(
        () =>
          mod.stripe.updateConfig(admin, {
            enabled: true,
            publishableKey: "pk_test_PublishableKey1234567890",
            secretKey,
            webhookSecret,
            webhookToleranceSeconds: 300,
          }),
        admin,
      ),
    ).rejects.toMatchObject({ reasonCode: "STRIPE_MANAGED_IN_PAYMENTS" });
    expect(await mod.stripe.isOnlinePaymentConfigured()).toBe(false);

    // 3. Save non-active diagnostic metadata + webhook signing secret (`enabled: false`) & attach compliance spy
    const savedCfg = await withTestRequest(
      () =>
        mod.stripe.updateConfig(admin, {
          enabled: false,
          publishableKey: "pk_test_PublishableKey1234567890",
          secretKey,
          webhookSecret,
          webhookToleranceSeconds: 300,
        }),
      admin,
    );
    expect(savedCfg.enabled).toBe(false);
    expect(savedCfg.webhookSecretConfigured).toBe(true);
    expect(await mod.stripe.isOnlinePaymentConfigured()).toBe(false);

    const paymentCalls: Array<unknown> = [];
    (h.services as unknown as { compliance: unknown }).compliance = {
      recordProviderPayment: async (input: unknown) => {
        paymentCalls.push(input);
        return { applied: true, reasonCode: "INVOICE_PAID" };
      },
    };

    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const checkoutPayload = JSON.stringify({
      id: "evt_test_000001",
      type: "checkout.session.completed",
      created: nowSec,
      data: {
        object: {
          id: "cs_test_999999",
          payment_intent: "pi_test_999999",
          amount_total: 25000,
          currency: "usd",
          metadata: {
            invoicePublicId: "01JINV00000000000000000001",
            orderPublicId: "01JORD00000000000000000001",
          },
        },
      },
    });
    const rawBody = Buffer.from(checkoutPayload, "utf8");

    // 4. Reject tampered signature (`400 INVALID_SIGNATURE`) and stale timestamp (`400 STALE_WEBHOOK_TIMESTAMP`)
    const badSigRes = await mod.stripe.handleSignedWebhook({
      rawBody,
      signatureHeader: `t=${nowSec},v1=${"0".repeat(64)}`,
    });
    expect(badSigRes).toMatchObject({ httpStatus: 400, accepted: false, reasonCode: "INVALID_SIGNATURE" });

    const staleSigRes = await mod.stripe.handleSignedWebhook({
      rawBody,
      signatureHeader: signStripeWebhook(rawBody, webhookSecret, nowSec - 900),
    });
    expect(staleSigRes).toMatchObject({
      httpStatus: 400,
      accepted: false,
      reasonCode: "STALE_WEBHOOK_TIMESTAMP",
    });

    // 5. Valid signed `checkout.session.completed` + `payment_intent.succeeded` + `charge.refunded` events
    //    are durably recorded + audited, and leave the compliance ledger COMPLETELY UNCHANGED (`paymentCalls === 0`)!
    const validSig = signStripeWebhook(rawBody, webhookSecret, nowSec);
    const firstDelivery = await mod.stripe.handleSignedWebhook({ rawBody, signatureHeader: validSig });
    expect(firstDelivery).toEqual({
      httpStatus: 200,
      accepted: true,
      duplicate: false,
      ledgerMutated: false,
      reasonCode: "STRIPE_INERT_DIAGNOSTIC_RECEIVER",
    });

    for (const [evtId, evtType] of [
      ["evt_test_000002", "payment_intent.succeeded"],
      ["evt_test_000003", "charge.refunded"],
    ] as const) {
      const extraRaw = Buffer.from(
        JSON.stringify({
          id: evtId,
          type: evtType,
          created: nowSec,
          data: { object: { id: "pi_test_999999", amount_received: 25000, amount_refunded: 5000, currency: "usd" } },
        }),
        "utf8",
      );
      const res = await mod.stripe.handleSignedWebhook({
        rawBody: extraRaw,
        signatureHeader: signStripeWebhook(extraRaw, webhookSecret, nowSec),
      });
      expect(res).toMatchObject({
        httpStatus: 200,
        accepted: true,
        duplicate: false,
        ledgerMutated: false,
        reasonCode: "STRIPE_INERT_DIAGNOSTIC_RECEIVER",
      });
    }

    expect(paymentCalls).toHaveLength(0);
    const recordedRows = await tdb.db.select().from(integrationWebhookEvents);
    expect(recordedRows).toHaveLength(3);
    expect(recordedRows.every((r) => r.status === "ignored")).toBe(true);

    // Health stays `disabled` when Stripe online checkout is not configured in Payment Setup
    const stripeHealth = (await mod.health()).find((c) => c.component === "integrations.stripe");
    expect(stripeHealth?.state).toBe("disabled");

    // 6. Exact duplicate event ID returns `200 duplicate: true`
    const replayDelivery = await mod.stripe.handleSignedWebhook({ rawBody, signatureHeader: validSig });
    expect(replayDelivery).toEqual({
      httpStatus: 200,
      accepted: true,
      duplicate: true,
      ledgerMutated: false,
      reasonCode: "DUPLICATE_EVENT",
    });
    expect(paymentCalls).toHaveLength(0);

    // 7. Same event ID with mutated signed body returns `409 EVENT_PAYLOAD_MISMATCH`
    const mutatedBody = Buffer.from(checkoutPayload.replace("25000", "99999"), "utf8");
    const mismatchDelivery = await mod.stripe.handleSignedWebhook({
      rawBody: mutatedBody,
      signatureHeader: signStripeWebhook(mutatedBody, webhookSecret, nowSec),
    });
    expect(mismatchDelivery).toEqual({
      httpStatus: 409,
      accepted: false,
      duplicate: false,
      ledgerMutated: false,
      reasonCode: "EVENT_PAYLOAD_MISMATCH",
    });
    expect(paymentCalls).toHaveLength(0);

    // 8. Express webhook route folds IPv6 addresses to `/64` via `rateLimitAddress`
    const app = express();
    app.set("trust proxy", true);
    app.use("/api/integrations/webhooks", express.raw({ type: "application/json", limit: "256kb" }));
    const webhookRouter = express.Router();
    registerSignedIntegrationWebhooks(webhookRouter, h.services);
    app.use("/api/integrations/webhooks", webhookRouter);

    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const resp = await fetch(`http://127.0.0.1:${port}/api/integrations/webhooks/stripe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": validSig,
          "x-forwarded-for": "2001:db8:abcd:0012:9999:8888:7777:6666",
        },
        body: rawBody,
      });
      expect(resp.status).toBe(200);
      expect(h.rateLimiter.calls).toContainEqual({
        category: "api",
        key: "webhook:stripe:2001:db8:abcd:12::/64",
      });
    } finally {
      server.close();
    }
  });

  it("derives live SAML SSO, SharePoint/Microsoft 365 file-sync, and Stripe hub states from real service ports", async () => {
    const admin = makeStepUpAdmin(h);
    const now = h.clock.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // 1. SAML card state machine + protocol & MFA mode wording
    let ssoState = {
      configured: false,
      enabled: false,
      complete: false,
      availableInThisDeployment: true,
      protocol: "saml" as "saml" | "oidc",
      entraMfaMode: "portal" as "portal" | "claim" | "entra",
      trustedCertificates: 0,
      nearestCertificateExpiry: null as Date | null,
      metadataStatus: null as string | null,
      metadataCheckedAt: null as Date | null,
      lastSignInAt: null as Date | null,
      settingsPath: "/admin/sso" as const,
    };
    (h.services.identity as unknown as { sso: { statusSummary: () => Promise<typeof ssoState> } }).sso = {
      statusSummary: async () => ({ ...ssoState }),
    };

    // 1a. No tenant / certificate -> not_configured, summary names protocol + "Portal MFA always"
    let samlCard = await mod.providers.getStatus("saml");
    expect(samlCard).toMatchObject({ state: "not_configured", verified: false, scaffoldOnly: false, lastCheckedAt: null });
    expect(samlCard.summary).toContain("SAML 2.0 · Portal MFA always");
    expect((await mod.health()).find((c) => c.component === "integrations.saml")?.state).toBe("not_configured");

    // 1b. Configured + valid certificate, switched off -> disabled, summary names "MFA claim required"
    ssoState = {
      ...ssoState,
      configured: true,
      enabled: false,
      complete: true,
      entraMfaMode: "claim",
      trustedCertificates: 1,
      nearestCertificateExpiry: new Date(now.getTime() + 120 * dayMs),
    };
    samlCard = await mod.providers.getStatus("saml");
    expect(samlCard).toMatchObject({ state: "disabled", verified: false });
    expect(samlCard.summary).toContain("SAML 2.0 · MFA claim required");
    expect((await mod.health()).find((c) => c.component === "integrations.saml")?.state).toBe("disabled");

    // 1c. Enabled, valid certificate, never verified -> degraded
    ssoState = {
      ...ssoState,
      enabled: true,
      entraMfaMode: "entra",
    };
    samlCard = await mod.providers.getStatus("saml");
    expect(samlCard).toMatchObject({ state: "degraded", verified: false });
    expect(samlCard.summary).toContain("SAML 2.0 · Entra manages MFA");
    expect((await mod.health()).find((c) => c.component === "integrations.saml")?.state).toBe("degraded");

    // 1d. Enabled + verified sign-in + cert valid > 30 days -> configured + verified=true (health = "ok")
    const signInAt = new Date(now.getTime() - 60_000);
    ssoState = {
      ...ssoState,
      lastSignInAt: signInAt,
    };
    samlCard = await mod.providers.getStatus("saml");
    expect(samlCard).toMatchObject({ state: "configured", verified: true, lastCheckedAt: signInAt });
    expect(samlCard.summary).toContain("SAML 2.0 · Entra manages MFA");
    expect((await mod.health()).find((c) => c.component === "integrations.saml")?.state).toBe("ok");

    // 1e. Enabled + verified, certificate expires within 30 days -> degraded
    ssoState = {
      ...ssoState,
      nearestCertificateExpiry: new Date(now.getTime() + 14 * dayMs),
    };
    samlCard = await mod.providers.getStatus("saml");
    expect(samlCard).toMatchObject({ state: "degraded", verified: false });
    expect(samlCard.summary).toContain("expires within 30 days");
    expect((await mod.health()).find((c) => c.component === "integrations.saml")?.state).toBe("degraded");

    // 1f. No valid certificate -> failing
    ssoState = {
      ...ssoState,
      complete: false,
      trustedCertificates: 0,
      nearestCertificateExpiry: null,
    };
    samlCard = await mod.providers.getStatus("saml");
    expect(samlCard).toMatchObject({ state: "failing", verified: false });
    expect(samlCard.summary).toContain("no valid active signing certificate");
    expect((await mod.health()).find((c) => c.component === "integrations.saml")?.state).toBe("failing");

    // 2. SharePoint / Microsoft 365 file-sync card state machine
    let fileSyncState = {
      totalConnections: 0,
      enabledConnections: 0,
      approvedConnections: 0,
      writeTestedConnections: 0,
      readyConnections: 0,
      failingConnections: 0,
      blockedTransfers: 0,
      lastCheckedAt: null as Date | null,
      lastSuccessAt: null as Date | null,
    };
    (h.services as unknown as { storageConnections: unknown }).storageConnections = {
      fileSync: { statusSummary: async () => ({ ...fileSyncState }) },
    };

    // 2a. No connections -> not_configured
    expect(await mod.providers.getStatus("sharepoint")).toMatchObject({
      state: "not_configured",
      verified: false,
      scaffoldOnly: false,
    });

    // 2b. Connection configured, switched off -> disabled
    fileSyncState = { ...fileSyncState, totalConnections: 1 };
    expect(await mod.providers.getStatus("sharepoint")).toMatchObject({ state: "disabled", verified: false });

    // 2c. Enabled + ready connection, egress presets still off -> degraded until both Graph presets enabled
    const writeTestedAt = new Date(now.getTime() - 30_000);
    fileSyncState = {
      ...fileSyncState,
      enabledConnections: 1,
      approvedConnections: 1,
      writeTestedConnections: 1,
      readyConnections: 1,
      lastCheckedAt: writeTestedAt,
    };
    expect(await mod.providers.getStatus("sharepoint")).toMatchObject({ state: "degraded", verified: false });

    await withTestRequest(
      () => mod.egress.setPresetEnabled(admin, { presetKey: "microsoft_graph", enabled: true }),
      admin,
    );
    await withTestRequest(
      () => mod.egress.setPresetEnabled(admin, { presetKey: "microsoft_graph_upload", enabled: true }),
      admin,
    );

    // 2d. Ready connection + both Graph presets enabled -> configured + verified=true (health = "ok")
    const spReady = await mod.providers.getStatus("sharepoint");
    expect(spReady).toMatchObject({ state: "configured", verified: true, lastCheckedAt: writeTestedAt });
    expect((await mod.health()).find((c) => c.component === "integrations.sharepoint")?.state).toBe("ok");

    // 2e. Failing enabled connection -> failing
    fileSyncState = { ...fileSyncState, readyConnections: 0, failingConnections: 1, blockedTransfers: 2 };
    expect(await mod.providers.getStatus("sharepoint")).toMatchObject({ state: "failing", verified: false });
    expect((await mod.health()).find((c) => c.component === "integrations.sharepoint")?.state).toBe("failing");

    // 3. Stripe card reflects live payments readiness when configured in Payment Setup
    const verifiedIso = new Date(now.getTime() - 15_000).toISOString();
    const origGet = h.deps.settings.get.bind(h.deps.settings);
    h.deps.settings.get = (async (key: string, parse: (raw: unknown) => unknown, fallback: unknown, tx?: Tx) => {
      if (key === "payments.config") {
        return parse({
          provider: "stripe",
          mode: "test",
          stripeSecretKeyLast4: "4242",
          stripeWebhookSecretLast4: "9999",
          stripeLastApiVerifiedAt: verifiedIso,
          stripeLastSelfTestAt: verifiedIso,
        });
      }
      return origGet(key, parse, fallback, tx);
    }) as typeof h.deps.settings.get;
    (h.services as unknown as { payments: unknown }).payments = {
      healthCounts: async () => ({
        provider: "stripe",
        onlineEnabled: true,
        redirectedAttempts: 0,
        retryPendingWebhooks: 0,
      }),
    };
    const stripeActive = await mod.providers.getStatus("stripe");
    expect(stripeActive).toMatchObject({
      state: "configured",
      verified: true,
      scaffoldOnly: false,
      lastCheckedAt: new Date(verifiedIso),
    });
    expect((await mod.health()).find((c) => c.component === "integrations.stripe")?.state).toBe("ok");
  });

  it("enforces negative authorization, in-tx actor revocation re-validation, audit-before-delete, fail-closed audit, and single-connection pool safety", async () => {
    const now = h.clock.now();
    const customer = fakePrincipal({ role: "customer", stepUpAt: now });
    const supportStaff = fakePrincipal({ role: "staff", stepUpAt: now });
    const adminWithoutStepUp = fakePrincipal({ role: "admin", stepUpAt: null });
    const remediationAdmin = fakePrincipal({
      role: "admin",
      state: "remediation",
      pendingSteps: ["enroll_mfa"],
      stepUpAt: now,
    });
    const validAdmin = makeStepUpAdmin(h);

    // 1. Router negative authz checks (customer, staff, no step-up, remediation)
    for (const deniedPrincipal of [customer, supportStaff, adminWithoutStepUp, remediationAdmin]) {
      const caller = integrationsRouter.createCaller({
        request: newRequestContext("test"),
        transport: { issue() {}, clear() {} },
        session: deniedPrincipal,
        services: h.services,
      });
      await expect(
        caller.admin.analytics.update({
          clarityEnabled: false,
          clarityProjectId: "",
          posthogEnabled: false,
          posthogProjectKey: "",
          posthogHost: "https://us.i.posthog.com",
        }),
      ).rejects.toBeInstanceOf(TRPCError);
    }

    // 2. Cross-Model Review Rule #2 + PW-06: Fail-closed when `identity` is absent AND when actor revoked in-tx
    (h.services as unknown as { identity: unknown }).identity = undefined;
    await expect(
      withTestRequest(
        () =>
          mod.egress.createAllowlistRule(validAdmin, {
            purpose: "siem",
            matchType: "host",
            pattern: "siem.internal.corp.example",
            port: 6514,
            protocol: "tls:",
            allowPrivateAddress: true,
            justification: "Must fail closed when identity.sessions.assertCurrent is absent",
          }),
        validAdmin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "ACTOR_UNVERIFIABLE" });

    const assertCurrentSpy = vi.fn(async (_p: SessionPrincipal, tx?: Tx) => {
      expect(tx).toBeDefined();
      throw forbidden("SESSION_REVOKED_MID_REQUEST");
    });
    (h.services as unknown as { identity: unknown }).identity = {
      sessions: { assertCurrent: assertCurrentSpy },
    };

    await expect(
      withTestRequest(
        () =>
          mod.egress.createAllowlistRule(validAdmin, {
            purpose: "siem",
            matchType: "host",
            pattern: "siem.internal.corp.example",
            port: 6514,
            protocol: "tls:",
            allowPrivateAddress: true,
            justification: "Should roll back when actor revoked in tx",
          }),
        validAdmin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "SESSION_REVOKED_MID_REQUEST" });
    expect(assertCurrentSpy).toHaveBeenCalledTimes(1);
    expect(await mod.egress.listAllowlist()).toHaveLength(0);

    // Restore healthy `assertCurrent`
    (h.services as unknown as { identity: unknown }).identity = {
      getUser: async (userId: number, opts?: { tx?: Tx }) => ({
        id: userId,
        publicId: "01JADMINUSER00000000000001",
        role: "admin",
        status: "active",
        email: "ops@readypackets.example",
        name: "Ops Admin",
        customerRef: null,
        emailVerified: true,
        authSource: "local",
        mustChangePassword: false,
        hasPassword: true,
        createdAt: h.clock.now(),
        version: 1,
        ...(opts?.tx ? {} : {}),
      }),
      sessions: {
        assertCurrent: async (p: SessionPrincipal, tx?: Tx) => {
          expect(tx).toBeDefined();
          return p;
        },
      },
    };

    // 3. Cross-Model Review Rule #3 + Fail-Closed Audit:
    // Create rule, verify audit-before-delete ordering, and verify audit failure rolls back mutations!
    const createdRule = await withTestRequest(
      () =>
        mod.egress.createAllowlistRule(validAdmin, {
          purpose: "siem",
          matchType: "host",
          pattern: "siem.internal.corp.example",
          port: 6514,
          protocol: "tls:",
          allowPrivateAddress: true,
          justification: "Test audit-before-delete and rollback",
        }),
      validAdmin,
    );

    // Simulate audit store unavailable -> delete MUST fail closed and row MUST remain!
    h.audit.failRecords = true;
    await expect(
      withTestRequest(() => mod.egress.deleteAllowlistRule(validAdmin, createdRule.publicId), validAdmin),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(await mod.egress.listAllowlist()).toHaveLength(1);

    // Also verify analytics update rolls back completely when audit fails
    await expect(
      withTestRequest(
        () =>
          mod.analytics.updateConfig(validAdmin, {
            clarityEnabled: true,
            clarityProjectId: "clarity12345",
            posthogEnabled: false,
            posthogProjectKey: "",
            posthogHost: "https://us.i.posthog.com",
          }),
        validAdmin,
      ),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect((await mod.analytics.getPublicConfig()).clarity.enabled).toBe(false);

    // Re-enable audit and verify `audit.record(..., tx)` fires WHILE the row still exists in `tx` (before DELETE)!
    h.audit.failRecords = false;
    let rowsVisibleAtAuditTime = -1;
    const origRecord = h.audit.record.bind(h.audit);
    h.audit.record = async (event, tx) => {
      if (event.eventName === "integration.egress.rule_deleted" && tx) {
        const rowsInTx = await tx.select().from(integrationEgressAllowlist);
        rowsVisibleAtAuditTime = rowsInTx.length;
      }
      return origRecord(event, tx);
    };

    await withTestRequest(() => mod.egress.deleteAllowlistRule(validAdmin, createdRule.publicId), validAdmin);
    expect(rowsVisibleAtAuditTime).toBe(1);
    expect(await mod.egress.listAllowlist()).toHaveLength(0);

    // 4. Cross-Model Review Rule #1: Single-connection pool (`connectionLimit: 1`) never self-deadlocks!
    const singlePool = mysql.createPool({
      uri: tdb.url,
      connectionLimit: 1,
      timezone: "Z",
      supportBigNumbers: true,
      charset: "utf8mb4",
    });
    try {
      const singleDb = drizzle(singlePool, { mode: "default" }) as unknown as Db;
      const singleHarness = createTestDeps({ db: singleDb });
      const singleSettings = createSettingsStore({
        db: singleDb,
        clock: singleHarness.clock,
        logger: singleHarness.deps.logger,
        crypto: singleHarness.deps.crypto,
        audit: singleHarness.audit,
      });
      singleHarness.deps.settings = singleSettings;
      singleHarness.services.settings = singleSettings;
      (singleHarness.services as unknown as { identity: unknown }).identity = {
        sessions: {
          assertCurrent: async (p: SessionPrincipal, tx?: Tx) => {
            expect(tx).toBeDefined();
            return p;
          },
        },
      };

      const singleMod = createIntegrationsModule(singleHarness.deps, {
        egress: { dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      });
      const singleAdmin = makeStepUpAdmin(singleHarness);

      await withTestRequest(
        () =>
          singleMod.smtp.updateConfig(singleAdmin, {
            enabled: true,
            host: "smtp.public-mail.example",
            port: 465,
            tlsMode: "implicit",
            username: "apikey",
            password: "single-pool-password",
            fromAddress: "no-reply@readypackets.example",
            fromName: "ReadyPackets",
          }),
        singleAdmin,
      );

      const ruleSingle = await withTestRequest(
        () =>
          singleMod.egress.createAllowlistRule(singleAdmin, {
            purpose: "smtp",
            matchType: "host",
            pattern: "smtp.public-mail.example",
            port: 465,
            protocol: "smtps:",
            allowPrivateAddress: false,
            justification: "Single-slot pool regression check",
          }),
        singleAdmin,
      );
      await withTestRequest(
        () => singleMod.egress.deleteAllowlistRule(singleAdmin, ruleSingle.publicId),
        singleAdmin,
      );
      expect((await singleMod.smtp.getConfig()).enabled).toBe(true);
    } finally {
      await singlePool.end();
    }
  });

  it("rejects seeded or restored SMTP port-25 settings in persisted schema parse and pre-dial, opening zero sockets", async () => {
    const admin = makeStepUpAdmin(h);
    const dnsLookupSpy = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const transportSpy = vi.fn(() => ({
      sendMail: async () => ({ accepted: ["ops@readypackets.example"], rejected: [] }),
      close: () => {},
    }));

    // 1. Seed a port-25 `integrations.smtp.config` row directly into `platform_settings` (simulating DB restore/manual SQL)
    const seededSettings = createSettingsStore({
      db: tdb.db,
      clock: h.clock,
      logger: h.deps.logger,
      crypto: h.deps.crypto,
      audit: h.audit,
    });
    await withTestRequest(
      async () => {
        await seededSettings.setFeature("integrations.smtp", true);
        await seededSettings.updateSecret("integrations.smtp.password", "restored-smtp-secret");
      },
      admin,
    );
    await h.deps.db.insert(platformSettings).values({
      settingKey: "integrations.smtp.config",
      kind: "value",
      valueJson: {
        host: "smtp.public-mail.example",
        port: 25,
        tlsMode: "starttls",
        username: "apikey",
        fromAddress: "no-reply@readypackets.example",
        fromName: "ReadyPackets",
        replyToAddress: "",
      },
      version: 1,
    });
    seededSettings.invalidate();

    const seededMod = createIntegrationsModule(
      { ...h.deps, settings: seededSettings },
      {
        egress: { dnsLookup: dnsLookupSpy },
        smtpTransportFactory: transportSpy,
      },
    );

    const seededHealth = await seededMod.health();
    expect(seededHealth.find((c) => c.component === "mail.smtp")?.state).toBe("not_configured");
    expect((await seededMod.smtp.getConfig()).configured).toBe(false);

    const seededSend = await seededMod.smtp.send({
      to: "ops@readypackets.example",
      subject: "Port 25 Seed Check",
      text: "Must never dial.",
      html: "<p>Must never dial.</p>",
      signal: new AbortController().signal,
    });
    expect(seededSend).toEqual({ outcome: "not_configured" });

    await expect(
      withTestRequest(
        () => seededMod.smtp.sendTestMessage(admin, { toAddress: "ops@readypackets.example" }),
        admin,
      ),
    ).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      reasonCode: "SMTP_NOT_CONFIGURED",
    });

    expect(dnsLookupSpy).not.toHaveBeenCalled();
    expect(transportSpy).not.toHaveBeenCalled();

    // 2. Pre-dial defense-in-depth: even if a custom SettingsStore bypasses schema parse and returns `port: 25`,
    // `send()` and `sendTestMessage()` fail closed with `SMTP_PORT_25_FORBIDDEN` (`failing` health) and open zero sockets.
    const unvalidatedPort25Settings = {
      ...seededSettings,
      async get<T>(key: string, parse: (raw: unknown) => T, fallback: T, tx?: Tx): Promise<T> {
        if (key === "integrations.smtp.config") {
          return {
            host: "smtp.public-mail.example",
            port: 25,
            tlsMode: "starttls",
            username: "apikey",
            fromAddress: "no-reply@readypackets.example",
            fromName: "ReadyPackets",
            replyToAddress: "",
          } as unknown as T;
        }
        return seededSettings.get(key, parse, fallback, tx);
      },
    };

    const bypassMod = createIntegrationsModule(
      { ...h.deps, settings: unvalidatedPort25Settings },
      {
        egress: { dnsLookup: dnsLookupSpy },
        smtpTransportFactory: transportSpy,
      },
    );

    const bypassSend = await bypassMod.smtp.send({
      to: "ops@readypackets.example",
      subject: "Bypass Pre-Dial Check",
      text: "Must fail closed before DNS or socket.",
      html: "<p>Must fail closed before DNS or socket.</p>",
      signal: new AbortController().signal,
    });
    expect(bypassSend).toEqual({ outcome: "rejected", retryable: false });

    const bypassHealth = await bypassMod.health();
    expect(bypassHealth.find((c) => c.component === "mail.smtp")?.state).toBe("failing");

    await expect(
      withTestRequest(
        () => bypassMod.smtp.sendTestMessage(admin, { toAddress: "ops@readypackets.example" }),
        admin,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "SMTP_PORT_25_FORBIDDEN",
    });

    expect(dnsLookupSpy).not.toHaveBeenCalled();
    expect(transportSpy).not.toHaveBeenCalled();
  });
});
