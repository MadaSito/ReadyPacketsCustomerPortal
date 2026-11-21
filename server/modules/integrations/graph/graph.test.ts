/**
 * Increment 03 DB-backed + local-protocol-fake test suite for:
 *  - Cloud/storage/OIDC/Graph egress purposes, presets, streaming uploads & HTTP 308 safety,
 *  - Single-tenant Microsoft Graph client, OAuth token caching/isolation, upload-session guardrails, and G-02 `beforeSend` fencing,
 *  - Graph `MailTransport` + SMTP `SmtpService` shared-sender override (B-03), explicit outcome classification (B-01 / Decision 8),
 *    self-only administrative test delivery (§2.C), and negative authorization.
 */
import { Readable } from "node:stream";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../../core/errors.js";
import { newRequestContext } from "../../../core/requestContext.js";
import type { SessionPrincipal, Tx } from "../../../core/types.js";
import {
  createTestDeps,
  fakePrincipal,
  withTestRequest,
  type TestHarness,
} from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import type { MailTransport } from "../../jobs/mailPorts.js";
import "../../jobs/mailSettings.js";
import { createSettingsStore } from "../../platform/settingsStore.js";
import { platformSettings } from "../../platform/schema.js";
import {
  createIntegrationsModule,
  EGRESS_PURPOSES,
  type EgressFetchResponse,
  type IntegrationsModule,
} from "../index.js";
import { integrationsRouter } from "../router.js";
import {
  integrationEgressAllowlist,
  integrationProviderChecks,
  integrationWebhookEvents,
} from "../schema.js";

const TENANT_GUID = "11111111-2222-4333-8444-555555555555";
const CLIENT_GUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOP_SECRET_VALUE = "top-secret-client-credential-value-XYZ9";
const TOP_SECRET_BEARER = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-bearer-token-value";
const SECRET_UPLOAD_URL =
  "https://contoso.sharepoint.com/sites/ops/_api/v2.0/drive/items/01ABC/uploadSession?token=CAPABILITY_SECRET_TOKEN_777";

function makeStepUpAdmin(h: TestHarness, overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 1,
    role: "admin",
    state: "full",
    pendingSteps: [],
    mfaVerifiedAt: now,
    stepUpAt: now,
    ...overrides,
  });
}

describe("increment 03 — Graph client, cloud egress presets, mail failover classification & self-only tests", () => {
  let tdb: TestDb;
  let h: TestHarness;
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
      ["login.microsoftonline.com", [{ address: "40.126.32.10", family: 4 }]],
      ["graph.microsoft.com", [{ address: "20.190.159.2", family: 4 }]],
      ["contoso.sharepoint.com", [{ address: "52.105.12.34", family: 4 }]],
      ["tenant-my.files.1drv.com", [{ address: "52.105.12.35", family: 4 }]],
      ["s3.us-east-1.amazonaws.com", [{ address: "52.217.100.10", family: 4 }]],
      ["portal-bucket.s3.us-east-1.amazonaws.com", [{ address: "52.217.100.11", family: 4 }]],
      ["other-tenant-bucket.s3.us-east-1.amazonaws.com", [{ address: "52.217.100.12", family: 4 }]],
      ["readypacketsblob.blob.core.windows.net", [{ address: "20.60.70.80", family: 4 }]],
      ["api.dropboxapi.com", [{ address: "162.125.65.1", family: 4 }]],
      ["www.googleapis.com", [{ address: "142.250.80.10", family: 4 }]],
      ["smtp.public-mail.example", [{ address: "93.184.216.34", family: 4 }]],
      ["evil.attacker.example", [{ address: "93.184.216.99", family: 4 }]],
      ["loopback.attacker.example", [{ address: "127.0.0.1", family: 4 }]],
      ["rfc1918.attacker.example", [{ address: "10.10.20.30", family: 4 }]],
      ["linklocal.attacker.example", [{ address: "169.254.20.30", family: 4 }]],
      ["imds.attacker.example", [{ address: "169.254.169.254", family: 4 }]],
    ]);

    h = createTestDeps({ db: tdb.db });
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
        email: "admin-self@readypackets.example",
        name: "Admin Self",
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
  });

  it("enforces default-off cloud egress presets, SSRF blocks across all new purposes, stream length bounds & Google Drive 308 stripping", async () => {
    const admin = makeStepUpAdmin(h);
    const seenRequests: Array<{ url: string; headers?: Record<string, string>; bodyLen: number }> = [];

    const mod: IntegrationsModule = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async (host) => {
          const hit = dnsMap.get(host);
          if (!hit) throw new Error(`ENOTFOUND ${host}`);
          return hit;
        },
        httpsRequester: async (_pinned, url, opts): Promise<EgressFetchResponse> => {
          let bodyLen = 0;
          if (typeof opts.body === "string") bodyLen = Buffer.byteLength(opts.body);
          else if (opts.body instanceof Uint8Array) bodyLen = opts.body.byteLength;
          else if (opts.body) {
            const chunks: Buffer[] = [];
            for await (const chunk of opts.body as AsyncIterable<Buffer | string>) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            bodyLen = Buffer.concat(chunks).byteLength;
            if (opts.declaredStreamLength !== undefined && bodyLen !== opts.declaredStreamLength) {
              throw new DomainError("VALIDATION", "EGRESS_STREAM_LENGTH_MISMATCH", "Stream length mismatch.");
            }
          }
          seenRequests.push({ url: url.toString(), headers: opts.headers, bodyLen });
          if (url.hostname === "www.googleapis.com") {
            return {
              status: 308,
              headers: {
                range: "bytes=0-1023",
                location: "http://169.254.169.254/latest/meta-data/",
              },
              body: Buffer.alloc(0),
            };
          }
          return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
        },
      },
    });

    // 1. All presets ship disabled by default
    const initialPresets = await mod.egress.listPresets();
    expect(initialPresets.length).toBeGreaterThanOrEqual(9);
    expect(initialPresets.every((p) => p.enabled === false)).toBe(true);

    // Un-enabled cloud purpose is refused fail-closed (`EGRESS_ALLOWLIST_REQUIRED`)
    await expect(mod.egress.fetchPinned("https://graph.microsoft.com/v1.0/me", "graph")).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "EGRESS_ALLOWLIST_REQUIRED",
    });

    // 2. SSRF block matrix across every new Increment 03 purpose
    const newPurposes = EGRESS_PURPOSES.filter((p) =>
      ["graph", "graph_upload", "entra_oidc", "storage_s3", "storage_azure", "storage_dropbox", "storage_gdrive"].includes(p),
    );
    expect(newPurposes).toHaveLength(7);

    for (const purpose of newPurposes) {
      for (const badHost of [
        "https://127.0.0.1/path",
        "https://[::1]/path",
        "https://loopback.attacker.example/path",
        "https://rfc1918.attacker.example/path",
        "https://linklocal.attacker.example/path",
        "https://imds.attacker.example/latest/meta-data/",
      ]) {
        await expect(
          mod.egress.fetchPinned(badHost, purpose),
          `expected ${badHost} to be blocked for ${purpose}`,
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }

      // `allowPrivateAddress: true` is refused even for step-up admins on cloud purposes
      await expect(
        withTestRequest(
          () =>
            mod.egress.createAllowlistRule(admin, {
              purpose,
              matchType: "ip",
              pattern: "10.20.30.40",
              port: 443,
              protocol: "https:",
              allowPrivateAddress: true,
              justification: "Attempted private rule on cloud purpose",
            }),
          admin,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }

    // 3. Parameterized S3 preset materializes exact hosts only (never wildcard `*.amazonaws.com`)
    const s3Preset = await withTestRequest(
      () =>
        mod.egress.setPresetEnabled(admin, {
          presetKey: "amazon_s3",
          enabled: true,
          params: { region: "us-east-1", bucket: "portal-bucket" },
        }),
      admin,
    );
    expect(s3Preset.enabled).toBe(true);
    const rulesAfterS3 = await mod.egress.listAllowlist();
    expect(rulesAfterS3.map((r) => r.pattern).sort()).toEqual([
      "portal-bucket.s3.us-east-1.amazonaws.com",
      "s3.us-east-1.amazonaws.com",
    ]);
    // Another tenant's S3 bucket in the same region is NOT allowlisted!
    await expect(
      mod.egress.fetchPinned("https://other-tenant-bucket.s3.us-east-1.amazonaws.com/key", "storage_s3"),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "EGRESS_ALLOWLIST_REQUIRED" });

    // 4. Readable stream upload requires contentLength and fails closed on mismatch
    const exactStream = Readable.from([Buffer.from("hello-"), Buffer.from("stream")]);
    const putOk = await mod.egress.fetchPinned("https://portal-bucket.s3.us-east-1.amazonaws.com/obj1", "storage_s3", {
      method: "PUT",
      body: exactStream,
      contentLength: 12,
    });
    expect(putOk.status).toBe(200);
    expect(seenRequests.at(-1)?.bodyLen).toBe(12);

    await expect(
      mod.egress.fetchPinned("https://portal-bucket.s3.us-east-1.amazonaws.com/obj-no-len", "storage_s3", {
        method: "PUT",
        body: Readable.from([Buffer.from("abc")]),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "EGRESS_STREAM_LENGTH_REQUIRED" });

    await expect(
      mod.egress.fetchPinned("https://portal-bucket.s3.us-east-1.amazonaws.com/obj2", "storage_s3", {
        method: "PUT",
        body: Readable.from([Buffer.from("too-short")]),
        contentLength: 20,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "EGRESS_STREAM_LENGTH_MISMATCH" });

    // 5. Google Drive resumable PUT allows HTTP 308 ONLY when `acceptUploadIncomplete: true` AND strips `Location`
    await withTestRequest(
      () => mod.egress.setPresetEnabled(admin, { presetKey: "google_drive", enabled: true }),
      admin,
    );
    await expect(
      mod.egress.fetchPinned("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", "storage_gdrive", {
        method: "PUT",
        body: Buffer.alloc(1024, 0x61),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "EGRESS_REDIRECT_REFUSED" });

    const gdrive308 = await mod.egress.fetchPinned("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", "storage_gdrive", {
      method: "PUT",
      body: Buffer.alloc(1024, 0x61),
      acceptUploadIncomplete: true,
    });
    expect(gdrive308.status).toBe(308);
    expect(gdrive308.headers.range).toBe("bytes=0-1023");
    expect(gdrive308.headers.location).toBeUndefined();
  });

  it("enforces single-tenant Entra GUIDs, caches & isolates tokens, guards upload-session URLs, and runs G-02 beforeSend fencing without wire writes", async () => {
    const admin = makeStepUpAdmin(h);
    let tokenCalls = 0;
    const wireLog: Array<{ host: string; method: string; path: string; headers: Record<string, string> }> = [];

    const mod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async (host) => {
          const hit = dnsMap.get(host);
          if (!hit) throw new Error(`ENOTFOUND ${host}`);
          return hit;
        },
        httpsRequester: async (_pinned, url, opts): Promise<EgressFetchResponse> => {
          wireLog.push({
            host: url.hostname,
            method: opts.method,
            path: url.pathname,
            headers: { ...(opts.headers ?? {}) },
          });
          if (url.hostname === "login.microsoftonline.com") {
            tokenCalls += 1;
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: Buffer.from(
                JSON.stringify({
                  token_type: "Bearer",
                  expires_in: 3600,
                  access_token: `${TOP_SECRET_BEARER}-${tokenCalls}`,
                }),
              ),
            };
          }
          if (url.hostname === "contoso.sharepoint.com") {
            return {
              status: 202,
              headers: { "content-type": "application/json" },
              body: Buffer.from(JSON.stringify({ nextExpectedRanges: ["4-7"] })),
            };
          }
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ id: "drive-root-123" })),
          };
        },
      },
    });

    // 1. Multi-tenant aliases (`common`, `organizations`, `consumers`) are rejected both in admin config & scoped client
    for (const alias of ["common", "organizations", "consumers"]) {
      await expect(
        withTestRequest(
          () =>
            mod.graphAdmin.updateConfig(admin, {
              enabled: false,
              tenantId: alias,
              clientId: CLIENT_GUID,
              clientSecret: TOP_SECRET_VALUE,
            }),
          admin,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "GRAPH_MULTI_TENANT_FORBIDDEN" });
    }
    expect(tokenCalls).toBe(0);

    // 2. Configure shared sender + Graph + enable `microsoft_graph` & `microsoft_graph_upload` presets; verify secret masking (`last4` only)
    await h.deps.settings.set("jobs.mail.sender", {
      fromAddress: "no-reply@readypackets.example",
      fromName: "ReadyPackets Ops",
      replyToAddress: "",
    });
    await withTestRequest(
      () => mod.egress.setPresetEnabled(admin, { presetKey: "microsoft_graph_upload", enabled: true }),
      admin,
    );
    const saved = await withTestRequest(
      () =>
        mod.graphAdmin.updateConfig(admin, {
          enabled: true,
          tenantId: TENANT_GUID,
          clientId: CLIENT_GUID,
          clientSecret: TOP_SECRET_VALUE,
          senderMailbox: "no-reply@readypackets.example",
          enableEgressPreset: true,
        }),
      admin,
    );
    expect(saved.clientSecretConfigured).toBe(true);
    expect(saved.clientSecretLast4).toBe("XYZ9");
    expect(JSON.stringify(saved)).not.toContain(TOP_SECRET_VALUE);
    expect(saved.egressPresetEnabled).toBe(true);
    expect(saved.verified).toBe(false);

    // 3. Single-flight coalescing + token caching + proactive refresh at `expires_in - 60s`
    const [r1, r2] = await Promise.all([
      mod.graph.request<{ id: string }>({ method: "GET", path: "/drives/drv1/root" }),
      mod.graph.request<{ id: string }>({ method: "GET", path: "/drives/drv2/root" }),
    ]);
    expect(r1.json().id).toBe("drive-root-123");
    expect(r2.json().id).toBe("drive-root-123");
    expect(tokenCalls).toBe(1);

    // Advance clock 58 minutes (< 3540s): still uses cached token
    h.clock.advance(58 * 60 * 1000);
    await mod.graph.request({ method: "GET", path: "/drives/drv1/root" });
    expect(tokenCalls).toBe(1);

    // Advance clock 2 more minutes (60m total, inside 60s safety window): refreshes token cleanly
    h.clock.advance(2 * 60 * 1000);
    await mod.graph.request({ method: "GET", path: "/drives/drv1/root" });
    expect(tokenCalls).toBe(2);

    // Rotating secret invalidates cached token immediately (refresh step-up after 60m clock advance)
    const refreshedAdmin = makeStepUpAdmin(h);
    await withTestRequest(
      () =>
        mod.graphAdmin.updateConfig(refreshedAdmin, {
          enabled: true,
          tenantId: TENANT_GUID,
          clientId: CLIENT_GUID,
          clientSecret: `${TOP_SECRET_VALUE}-rotated`,
          senderMailbox: "no-reply@readypackets.example",
        }),
      refreshedAdmin,
    );
    await mod.graph.request({ method: "GET", path: "/drives/drv1/root" });
    expect(tokenCalls).toBe(3);

    // 4. G-02 `beforeSend` hook runs AFTER token acquisition + DNS/allowlist check and BEFORE wire write;
    //    thrown lease-fencing error propagates unchanged with ZERO Graph wire calls!
    class SyntheticLeaseLostError extends Error {
      readonly marker = "LEASE_FENCE_LOST";
    }
    const wireCountBeforeFence = wireLog.filter((w) => w.host === "graph.microsoft.com").length;
    const tokenCallsBeforeFence = tokenCalls;
    // Clear cache so we also prove token acquisition runs BEFORE `beforeSend`!
    mod.stop();
    let sawTokenFetchBeforeFence = false;

    await expect(
      mod.graph.request({
        method: "PUT",
        path: "/drives/drv1/items/item1/content",
        rawBody: Buffer.from("small-binary"),
        beforeSend: async () => {
          sawTokenFetchBeforeFence = tokenCalls === tokenCallsBeforeFence + 1;
          throw new SyntheticLeaseLostError("Worker lease expired before wire write");
        },
      }),
    ).rejects.toBeInstanceOf(SyntheticLeaseLostError);

    expect(sawTokenFetchBeforeFence).toBe(true);
    expect(wireLog.filter((w) => w.host === "graph.microsoft.com")).toHaveLength(wireCountBeforeFence);

    // 5. Upload-session guardrails (§4.1): no Authorization/Cookie forwarded, non-SharePoint host rejected,
    //    and `uploadUrl` NEVER appears in errors or audit events!
    const chunkRes = await mod.graph.uploadChunk({
      uploadUrl: SECRET_UPLOAD_URL,
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentRange: "bytes 0-3/8",
    });
    expect(chunkRes.status).toBe(202);
    const spCall = wireLog.find((w) => w.host === "contoso.sharepoint.com");
    expect(spCall).toBeDefined();
    expect(spCall?.headers.Authorization).toBeUndefined();
    expect(spCall?.headers.authorization).toBeUndefined();
    expect(spCall?.headers.Cookie).toBeUndefined();

    // Host outside `*.sharepoint.com` / `*.files.1drv.com` is refused without leaking the URL
    const evilUploadUrl = "https://evil.attacker.example/upload?secret=DO_NOT_LEAK_999";
    let caughtErr: unknown;
    try {
      await mod.graph.uploadChunk({
        uploadUrl: evilUploadUrl,
        bytes: new Uint8Array([1, 2, 3, 4]),
        contentRange: "bytes 0-3/8",
      });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toMatchObject({ code: "FORBIDDEN", reasonCode: "EGRESS_HOST_LINEAGE_MISMATCH" });
    expect(String((caughtErr as Error).message)).not.toContain("DO_NOT_LEAK_999");
    expect(JSON.stringify(h.audit.events)).not.toContain("DO_NOT_LEAK_999");
    expect(JSON.stringify(h.audit.events)).not.toContain("CAPABILITY_SECRET_TOKEN_777");
    expect(JSON.stringify(h.audit.events)).not.toContain(TOP_SECRET_BEARER);
    expect(JSON.stringify(h.audit.events)).not.toContain(TOP_SECRET_VALUE);
  });

  it("enforces B-03 SMTP shared-sender override (without getConfig recursion), B-01/Decision-8 mail outcome classification, self-only test endpoints, and negative authz", async () => {
    const admin = makeStepUpAdmin(h);
    let registeredTransport: MailTransport | null = null;
    let getMailSenderCalls = 0;

    let graphMailBehavior: "202" | "200" | "403" | "429" | "502" | "drop_mid_flight" | "conn_refused" = "202";
    let lastGraphMailPayload: Record<string, unknown> | null = null;
    let lastGraphMailPath = "";

    let smtpBehavior: "ok" | "econnrefused" | "ehlo_timeout" | "ambiguous_socket" | "data_drop" | "451" | "535" = "ok";
    let lastSmtpMailSent: { from: unknown; replyTo?: string; to: string } | null = null;

    const mod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async (host) => {
          const hit = dnsMap.get(host);
          if (!hit) throw new Error(`ENOTFOUND ${host}`);
          return hit;
        },
        httpsRequester: async (_pinned, url, opts): Promise<EgressFetchResponse> => {
          if (url.hostname === "login.microsoftonline.com") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: Buffer.from(JSON.stringify({ token_type: "Bearer", expires_in: 3600, access_token: TOP_SECRET_BEARER })),
            };
          }
          if (url.pathname.endsWith("/sendMail")) {
            lastGraphMailPath = url.pathname;
            lastGraphMailPayload = JSON.parse(String(opts.body)) as Record<string, unknown>;
            if (graphMailBehavior === "conn_refused") {
              throw new DomainError("UNAVAILABLE", "EGRESS_CONNECT_REFUSED", "TCP connection refused.");
            }
            if (graphMailBehavior === "drop_mid_flight") {
              throw new DomainError("UNAVAILABLE", "EGRESS_CONNECTION_FAILED", "Socket closed mid-flight.");
            }
            if (graphMailBehavior === "200") {
              return { status: 200, headers: {}, body: Buffer.from("{}") };
            }
            if (graphMailBehavior === "403") {
              return {
                status: 403,
                headers: { "content-type": "application/json" },
                body: Buffer.from(JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Sensitive internal detail" } })),
              };
            }
            if (graphMailBehavior === "429") {
              return { status: 429, headers: {}, body: Buffer.from(JSON.stringify({ error: { code: "activityLimitReached" } })) };
            }
            if (graphMailBehavior === "502") {
              return { status: 502, headers: {}, body: Buffer.from("Bad Gateway") };
            }
            return { status: 202, headers: {}, body: Buffer.alloc(0) };
          }
          return { status: 200, headers: {}, body: Buffer.from("{}") };
        },
      },
      smtpTransportFactory: () => ({
        sendMail: async (msg) => {
          lastSmtpMailSent = { from: msg.from, replyTo: msg.replyTo, to: msg.to };
          if (smtpBehavior === "econnrefused") {
            throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
          }
          if (smtpBehavior === "ehlo_timeout") {
            throw Object.assign(new Error("Greeting timeout"), { code: "ETIMEDOUT", command: "EHLO" });
          }
          if (smtpBehavior === "ambiguous_socket") {
            // Generic socket error with NO command (`""`) MUST be `unknown` per B-01!
            throw Object.assign(new Error("Socket closed"), { code: "ESOCKET", command: "" });
          }
          if (smtpBehavior === "data_drop") {
            throw Object.assign(new Error("Timeout during DATA"), { code: "ETIMEDOUT", command: "DATA" });
          }
          if (smtpBehavior === "451") {
            throw Object.assign(new Error("Try again later"), { responseCode: 451 });
          }
          if (smtpBehavior === "535") {
            throw Object.assign(new Error("Auth failed"), { code: "EAUTH", responseCode: 535 });
          }
          return { accepted: [msg.to], rejected: [] };
        },
        close: () => {},
      }),
    });

    h.services.integrations = mod;
    (h.services as unknown as { jobAdmin: unknown }).jobAdmin = {
      registerMailTransport(transport: MailTransport) {
        registeredTransport = transport;
      },
      async getMailSenderIdentity() {
        getMailSenderCalls += 1;
        // Simulate Jobs' legacy fallback calling `smtp.getConfig()` to prove ZERO recursion!
        const legacy = await mod.smtp.getConfig();
        return legacy.fromAddress
          ? { fromAddress: legacy.fromAddress, fromName: legacy.fromName }
          : { fromAddress: "shared-sender@readypackets.example", fromName: "Shared Ops", replyToAddress: "reply@readypackets.example" };
      },
    };

    mod.init();
    const graphTransport = registeredTransport as MailTransport | null;
    expect(graphTransport?.key).toBe("graph");

    // 1. Configure shared sender in `jobs.mail.sender` and save SMTP with empty legacy `fromAddress`
    await h.deps.settings.set("jobs.mail.sender", {
      fromAddress: "shared-sender@readypackets.example",
      fromName: "Shared ReadyPackets",
      replyToAddress: "support@readypackets.example",
    });

    const smtpView = await withTestRequest(
      () =>
        mod.smtp.updateConfig(admin, {
          enabled: true,
          host: "smtp.public-mail.example",
          port: 587,
          tlsMode: "starttls",
          username: "smtp-user",
          password: "smtp-secret-password-9876",
          fromAddress: "",
          fromName: "",
        }),
      admin,
    );
    expect(smtpView.configured).toBe(true);
    expect(smtpView.passwordLast4).toBe("9876");
    // `smtp.getConfig()` did NOT call `jobAdmin.getMailSenderIdentity()`!
    expect(getMailSenderCalls).toBe(0);

    // 2. B-03: `smtp.send` applies explicit `input.sender` override EVEN when legacy `smtp.config` holds a different sender + replyTo!
    await withTestRequest(
      () =>
        mod.smtp.updateConfig(admin, {
          enabled: true,
          host: "smtp.public-mail.example",
          port: 587,
          tlsMode: "starttls",
          username: "smtp-user",
          fromAddress: "legacy-sender@readypackets.example",
          fromName: "Legacy Brand",
          replyToAddress: "legacy-reply@readypackets.example",
        }),
      admin,
    );

    const overrideRes = await mod.smtp.send({
      sender: {
        fromAddress: "override-sender@readypackets.example",
        fromName: "Override Brand",
        replyToAddress: "billing@readypackets.example",
      },
      to: "customer@example.com",
      subject: "Invoice Ready",
      text: "Hello",
      html: "<p>Hello</p>",
      signal: new AbortController().signal,
    });
    expect(overrideRes).toEqual({ outcome: "accepted" });
    expect(lastSmtpMailSent).toEqual({
      from: { name: "Override Brand", address: "override-sender@readypackets.example" },
      replyTo: "billing@readypackets.example",
      to: "customer@example.com",
    });

    // Omitting `replyToAddress` on `input.sender` does NOT leak legacy `smtp.config.replyToAddress`!
    await mod.smtp.send({
      sender: {
        fromAddress: "override-no-replyto@readypackets.example",
        fromName: "Override Clean",
      },
      to: "customer@example.com",
      subject: "Notice",
      text: "Hello",
      html: "<p>Hello</p>",
      signal: new AbortController().signal,
    });
    expect(lastSmtpMailSent).toEqual({
      from: { name: "Override Clean", address: "override-no-replyto@readypackets.example" },
      replyTo: undefined,
      to: "customer@example.com",
    });

    // 3. B-01 SMTP outcome classification matrix
    smtpBehavior = "econnrefused";
    expect(
      await mod.smtp.send({ to: "c@example.com", subject: "S", text: "T", html: "H", signal: new AbortController().signal }),
    ).toEqual({ outcome: "rejected", retryable: true });

    smtpBehavior = "ehlo_timeout";
    expect(
      await mod.smtp.send({ to: "c@example.com", subject: "S", text: "T", html: "H", signal: new AbortController().signal }),
    ).toEqual({ outcome: "rejected", retryable: true });

    smtpBehavior = "451";
    expect(
      await mod.smtp.send({ to: "c@example.com", subject: "S", text: "T", html: "H", signal: new AbortController().signal }),
    ).toEqual({ outcome: "rejected", retryable: true });

    smtpBehavior = "535";
    expect(
      await mod.smtp.send({ to: "c@example.com", subject: "S", text: "T", html: "H", signal: new AbortController().signal }),
    ).toEqual({ outcome: "rejected", retryable: false });

    smtpBehavior = "ambiguous_socket";
    expect(
      await mod.smtp.send({ to: "c@example.com", subject: "S", text: "T", html: "H", signal: new AbortController().signal }),
    ).toEqual({ outcome: "unknown" });

    smtpBehavior = "data_drop";
    expect(
      await mod.smtp.send({ to: "c@example.com", subject: "S", text: "T", html: "H", signal: new AbortController().signal }),
    ).toEqual({ outcome: "unknown" });

    smtpBehavior = "ok";

    // 4. Graph `MailTransport` B-01 / Decision 8 classification matrix
    // Unconfigured before Graph setup -> `not_configured`
    expect(
      await registeredTransport!.send({
        sender: { fromAddress: "shared-sender@readypackets.example", fromName: "Shared" },
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hi",
        html: "<p>Hi</p>",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ outcome: "not_configured" });

    // Mismatched `senderMailbox` constraint vs `jobs.mail.sender` is rejected on updateConfig!
    await expect(
      withTestRequest(
        () =>
          mod.graphAdmin.updateConfig(admin, {
            enabled: true,
            tenantId: TENANT_GUID,
            clientId: CLIENT_GUID,
            clientSecret: TOP_SECRET_VALUE,
            senderMailbox: "wrong-mailbox@readypackets.example",
            enableEgressPreset: true,
          }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "GRAPH_SENDER_MAILBOX_MISMATCH" });

    await withTestRequest(
      () =>
        mod.graphAdmin.updateConfig(admin, {
          enabled: true,
          tenantId: TENANT_GUID,
          clientId: CLIENT_GUID,
          clientSecret: TOP_SECRET_VALUE,
          senderMailbox: "shared-sender@readypackets.example",
          enableEgressPreset: true,
        }),
      admin,
    );

    // Mismatched `message.sender.fromAddress` against configured `senderMailbox` constraint -> non-retryable rejected!
    expect(
      await registeredTransport!.send({
        sender: { fromAddress: "other-mailbox@readypackets.example", fromName: "Other" },
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hi",
        html: "<p>Hi</p>",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ outcome: "rejected", retryable: false, safeDetail: "graph_sender_mailbox_mismatch" });

    // 202 Accepted uses authoritative `message.sender` (`fromAddress`, `fromName`, `replyToAddress`)
    graphMailBehavior = "202";
    const graphAccepted = await registeredTransport!.send({
      sender: {
        fromAddress: "shared-sender@readypackets.example",
        fromName: "Shared ReadyPackets",
        replyToAddress: "support@readypackets.example",
      },
      to: "customer@example.com",
      subject: "Welcome",
      text: "Hi",
      html: "<p>Hi</p>",
      signal: new AbortController().signal,
    });
    expect(graphAccepted.outcome).toBe("accepted");
    expect(lastGraphMailPath).toBe("/v1.0/users/shared-sender%40readypackets.example/sendMail");
    expect(lastGraphMailPayload).toMatchObject({
      saveToSentItems: false,
      message: {
        subject: "Welcome",
        from: { emailAddress: { address: "shared-sender@readypackets.example", name: "Shared ReadyPackets" } },
        replyTo: [{ emailAddress: { address: "support@readypackets.example" } }],
        toRecipients: [{ emailAddress: { address: "customer@example.com" } }],
      },
    });

    // Unexpected HTTP 200 (non-202) on `POST /sendMail` is treated fail-closed as `unknown`!
    graphMailBehavior = "200";
    expect(
      await registeredTransport!.send({
        sender: { fromAddress: "shared-sender@readypackets.example", fromName: "Shared" },
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hi",
        html: "<p>Hi</p>",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ outcome: "unknown", safeDetail: "graph_unexpected_status" });

    // 403 -> rejected (non-retryable, safe for failover)
    graphMailBehavior = "403";
    expect(
      await registeredTransport!.send({
        sender: { fromAddress: "shared-sender@readypackets.example", fromName: "Shared" },
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hi",
        html: "<p>Hi</p>",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ outcome: "rejected", retryable: false });

    // 429 -> rejected (retryable)
    graphMailBehavior = "429";
    expect(
      await registeredTransport!.send({
        sender: { fromAddress: "shared-sender@readypackets.example", fromName: "Shared" },
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hi",
        html: "<p>Hi</p>",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ outcome: "rejected", retryable: true });

    // Pre-TLS ECONNREFUSED -> rejected (retryable, safe for failover per Decision 8)
    graphMailBehavior = "conn_refused";
    expect(
      await registeredTransport!.send({
        sender: { fromAddress: "shared-sender@readypackets.example", fromName: "Shared" },
        to: "customer@example.com",
        subject: "Welcome",
        text: "Hi",
        html: "<p>Hi</p>",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ outcome: "rejected", retryable: true });

    // Mid-flight drop & 502 gateway failure -> `unknown` (NEVER replayed, NEVER failed over!)
    for (const uncertainMode of ["drop_mid_flight", "502"] as const) {
      graphMailBehavior = uncertainMode;
      expect(
        await registeredTransport!.send({
          sender: { fromAddress: "shared-sender@readypackets.example", fromName: "Shared" },
          to: "customer@example.com",
          subject: "Welcome",
          text: "Hi",
          html: "<p>Hi</p>",
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ outcome: "unknown" });
    }

    graphMailBehavior = "202";

    // 5. Self-only administrative test endpoints (§2.C): reject third-party email, succeed for self email
    await expect(
      withTestRequest(() => mod.smtp.sendTestMessage(admin, { toAddress: "victim@external.example" }), admin),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "TEST_RECIPIENT_MUST_BE_SELF" });

    await expect(
      withTestRequest(() => mod.graphAdmin.sendTestMessage(admin, { toAddress: "victim@external.example" }), admin),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reasonCode: "TEST_RECIPIENT_MUST_BE_SELF" });

    const smtpSelfTest = await withTestRequest(() => mod.smtp.sendTestMessage(admin), admin);
    expect(smtpSelfTest).toMatchObject({
      outcome: "accepted",
      recipientAddress: "admin-self@readypackets.example",
    });

    const connTest = await withTestRequest(() => mod.graphAdmin.testConnection(admin), admin);
    expect(connTest.outcome).toBe("succeeded");

    const graphSelfTest = await withTestRequest(() => mod.graphAdmin.sendTestMessage(admin), admin);
    expect(graphSelfTest).toMatchObject({
      outcome: "accepted",
      recipientAddress: "admin-self@readypackets.example",
    });

    // Health reports `mail.graph` as `ok` after real verification succeeded
    const health = await mod.health();
    expect(health.find((c) => c.component === "mail.graph")?.state).toBe("ok");

    // 6. Negative tRPC authorization checks on `admin.graph.*` (customer, staff, missing step-up, remediation)
    const now = h.clock.now();
    for (const denied of [
      fakePrincipal({ role: "customer", stepUpAt: now }),
      fakePrincipal({ role: "staff", stepUpAt: now }),
      fakePrincipal({ role: "admin", stepUpAt: null }),
      fakePrincipal({ role: "admin", state: "remediation", pendingSteps: ["enroll_mfa"], stepUpAt: now }),
    ]) {
      const caller = integrationsRouter.createCaller({
        request: newRequestContext("test"),
        transport: { issue() {}, clear() {} },
        session: denied,
        services: h.services,
      });
      await expect(
        caller.admin.graph.update({
          enabled: false,
          tenantId: TENANT_GUID,
          clientId: CLIENT_GUID,
        }),
      ).rejects.toBeInstanceOf(TRPCError);
      await expect(caller.admin.graph.testConnection({})).rejects.toBeInstanceOf(TRPCError);
      await expect(caller.admin.graph.sendTest({})).rejects.toBeInstanceOf(TRPCError);
    }
  });
});
