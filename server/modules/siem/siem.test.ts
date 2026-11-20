import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { AuditEmitter, AuditEventInput, Db, SessionTransport, SettingsStore, Tx } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createEgressPolicy } from "../integrations/egress.js";
import { integrationEgressAllowlist } from "../integrations/schema.js";
import { createTestDeps, fakePrincipal, withTestRequest } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createSiemModule, type ExternalAuditEvent, type IntegrationsEgressPort } from "./index.js";
import { siemRouter } from "./router.js";
import { siemDestinations, siemOutbox } from "./schema.js";
import {
  SIEM_CIRCUIT_COOLDOWN_SECONDS,
  SIEM_CIRCUIT_THRESHOLD,
  SIEM_MAX_ATTEMPTS,
  SIEM_OLDEST_ALERT_SECONDS,
  SIEM_SPOOL_MAX_EVENTS,
} from "./settings.js";
import { createTestPki, type TestPkiBundle } from "./testPki.js";

/**
 * In-process RFC 5425 TLS syslog / JSONL receiver.
 * Parses octet-counted frames (`<byteLen> <syslogBytes>`) across arbitrary TCP/TLS chunk boundaries,
 * and also records raw line records for `jsonl_tls` tests.
 */
interface TlsSyslogReceiver {
  port: number;
  frames: string[];
  lines: string[];
  handshakeCount: number;
  close(): Promise<void>;
}

async function startTlsReceiver(options: {
  certPem: string;
  keyPem: string;
  clientCaPem?: string;
  requireClientCert?: boolean;
  mode?: "octet" | "lines";
  port?: number;
}): Promise<TlsSyslogReceiver> {
  const frames: string[] = [];
  const lines: string[] = [];
  let handshakeCount = 0;
  const sockets = new Set<tls.TLSSocket>();

  const server = tls.createServer(
    {
      cert: options.certPem,
      key: options.keyPem,
      ca: options.clientCaPem,
      requestCert: Boolean(options.requireClientCert),
      rejectUnauthorized: Boolean(options.requireClientCert),
      minVersion: "TLSv1.2",
    },
    (socket) => {
      handshakeCount += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});

      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (options.mode === "lines") {
          while (true) {
            const nl = buffer.indexOf(0x0a);
            if (nl === -1) break;
            lines.push(buffer.subarray(0, nl).toString("utf8"));
            buffer = buffer.subarray(nl + 1);
          }
          return;
        }

        // Parse RFC 5425 octet-counting: `<digits> <MSG-of-exact-byte-length>`
        while (buffer.length > 0) {
          const sp = buffer.indexOf(0x20);
          if (sp === -1) break;
          const lenStr = buffer.subarray(0, sp).toString("ascii");
          const msgLen = Number(lenStr);
          if (!Number.isInteger(msgLen) || msgLen < 0) {
            socket.destroy();
            break;
          }
          if (buffer.length < sp + 1 + msgLen) break;
          const msgBytes = buffer.subarray(sp + 1, sp + 1 + msgLen);
          frames.push(msgBytes.toString("utf8"));
          buffer = buffer.subarray(sp + 1 + msgLen);
        }
      });
    },
  );
  server.on("tlsClientError", () => {});

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    frames,
    lines,
    get handshakeCount() {
      return handshakeCount;
    },
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface HttpsOtlpCollector {
  port: number;
  requests: { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[];
  setResponseStatus(code: number): void;
  close(): Promise<void>;
}

async function startHttpsOtlpCollector(options: { certPem: string; keyPem: string }): Promise<HttpsOtlpCollector> {
  const requests: { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];
  let statusCode = 200;
  const sockets = new Set<Duplex>();

  const server = https.createServer(
    {
      cert: options.certPem,
      key: options.keyPem,
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // keep raw
        }
        requests.push({
          path: req.url ?? "",
          headers: req.headers,
          body: parsed,
        });
        res.writeHead(statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify({ partialSuccess: { rejectedLogRecords: 0 } }));
      });
    },
  );
  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    requests,
    setResponseStatus(code: number) {
      statusCode = code;
    },
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Synthetic in-memory sealed audit stream implementing `AuditReadPort` (`readEventsAfter` + `projectForExternal`).
 */
class FakeAuditStream {
  private events: (ExternalAuditEvent & { actor_user_id?: number; source_address_ref?: string })[] = [];
  private scriptedBatches: {
    events: (ExternalAuditEvent & { actor_user_id?: number; source_address_ref?: string })[];
    nextCursor: string | null;
    headSeq: number;
    pruned?: number;
    missing?: number;
  }[] = [];

  enqueueScriptedBatch(batch: {
    events: ExternalAuditEvent[];
    nextCursor: string | null;
    headSeq: number;
    pruned?: number;
    missing?: number;
  }): void {
    this.scriptedBatches.push(batch);
  }

  setHeadSeqOffset(extraHead: number): void {
    this.extraHeadSeq = extraHead;
  }
  private extraHeadSeq = 0;

  append(partial: Partial<ExternalAuditEvent> & { event_name: string; actor_user_id?: number }): ExternalAuditEvent {
    const seq = this.events.length + 1;
    const ev: ExternalAuditEvent & { actor_user_id?: number; source_address_ref?: string } = {
      schema_version: "rp.audit/1",
      event_id: partial.event_id ?? `01JCXXTESTEVENT${String(seq).padStart(11, "0")}`,
      chain_seq: seq,
      occurred_at: partial.occurred_at ?? "2026-11-20T12:00:05.000Z",
      observed_at: partial.observed_at ?? "2026-11-20T12:00:05.001Z",
      severity_text: partial.severity_text ?? "INFO",
      severity_number: partial.severity_number ?? 9,
      category: partial.category ?? "security",
      event_name: partial.event_name,
      action: partial.action ?? "authenticate",
      outcome: partial.outcome ?? "completed",
      reason_code: partial.reason_code ?? null,
      service: "readypackets-portal",
      installation_ref: "inst_test_01",
      release_ref: "2026.11.20",
      deployment_profile: "test",
      origin: "http",
      actor_ref: partial.actor_ref ?? "act_pseudo_01",
      actor_role: partial.actor_role ?? "customer",
      resource_type: partial.resource_type ?? "session",
      resource_ref: partial.resource_ref ?? "res_pseudo_01",
      source_address_class: "public",
      request_id: "req_test_1",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      correlation_id: "cor_test_1",
      parent_correlation_id: null,
      job_id: null,
      package_id: null,
      import_id: null,
      delivery_id: null,
      provider: null,
      duration_ms: 12,
      safe_counts: partial.safe_counts ?? {},
      attributes: partial.attributes ?? {},
      dropped_attributes: 0,
      actor_user_id: partial.actor_user_id ?? 4242,
      source_address_ref: "203.0.113.77",
    };
    this.events.push(ev);
    return ev;
  }

  async readEventsAfter(cursor: string | null, limit: number) {
    if (this.scriptedBatches.length > 0) {
      return this.scriptedBatches.shift()!;
    }
    const afterSeq = cursor ? Number(cursor.replace("seq:", "")) : 0;
    const slice = this.events.filter((e) => (e.chain_seq ?? 0) > afterSeq).slice(0, limit);
    const last = slice[slice.length - 1];
    return {
      events: slice,
      nextCursor: last ? `seq:${last.chain_seq}` : cursor,
      headSeq: this.events.length + this.extraHeadSeq,
    };
  }

  projectForExternal(raw: unknown): ExternalAuditEvent {
    const copy = { ...(raw as Record<string, unknown>) };
    delete copy.actor_user_id;
    delete copy.resource_public_id;
    delete copy.session_ref;
    delete copy.source_address_ref;
    return copy as unknown as ExternalAuditEvent;
  }
}

/**
 * Synthetic DNS-pinning egress port mapping `*.siem.test` to `127.0.0.1` so TLS SNI + SAN hostname checks
 * run against real DNS hostnames in-process without modifying `/etc/hosts`.
 */
function createLoopbackPinningEgress(innerEgress: IntegrationsEgressPort): IntegrationsEgressPort {
  return {
    async resolveAndAssertAllowed(input) {
      const parsed = new URL(input.url);
      if (parsed.hostname.endsWith(".siem.test")) {
        if (!input.allowApprovedPrivate) {
          throw new DomainError("FORBIDDEN", "EGRESS_PRIVATE_BLOCKED", "Private SIEM receiver requires explicit opt-in.");
        }
        return {
          hostname: parsed.hostname,
          port: Number(parsed.port),
          protocol: parsed.protocol,
          address: "127.0.0.1",
          family: 4,
          servername: parsed.hostname,
          normalizedUrl: input.url,
        };
      }
      return innerEgress.resolveAndAssertAllowed!(input);
    },
  };
}

async function waitForCount(getter: () => number, expected: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getter() < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SIEM forwarding module (RFC 5425 TLS, mTLS, OTLP, outbox, authz, regressions)", () => {
  let testDb: TestDb;
  let pki: TestPkiBundle;
  let untrustedPki: TestPkiBundle;
  const activeServers: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    pki = createTestPki({ caCommonName: "ReadyPackets Trusted SIEM Root CA" });
    untrustedPki = createTestPki({ caCommonName: "Untrusted Rogue Root CA" });
    testDb = await createTestDb({
      schema: {
        siemDestinations,
        siemOutbox,
        integrationEgressAllowlist,
      },
    });
  });

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop()!;
      await srv.close();
    }
    await testDb.db.delete(siemOutbox);
    await testDb.db.delete(siemDestinations);
    await testDb.db.delete(integrationEgressAllowlist);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  function setupModule(now = new Date("2026-11-20T12:00:00.000Z")) {
    const h = createTestDeps({ db: testDb.db, now });
    const auditStream = new FakeAuditStream();
    const realEgress = createEgressPolicy(h.deps);
    const pinnedEgress = createLoopbackPinningEgress(realEgress);
    h.services.auditCenter = auditStream as unknown as typeof h.services.auditCenter;
    h.services.integrations = { egress: pinnedEgress } as unknown as typeof h.services.integrations;
    const siem = createSiemModule(h.deps);
    h.services.siem = siem;
    return { h, siem, auditStream };
  }

  function steppedUpAdmin(now = new Date("2026-11-20T12:00:00.000Z")) {
    return fakePrincipal({
      role: "admin",
      state: "full",
      pendingSteps: [],
      authenticatedAt: now,
      mfaVerifiedAt: now,
      stepUpAt: now,
    });
  }

  it("reports truthful health states: not_configured -> disabled -> ok -> degraded -> failing", async () => {
    const { h, siem } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    // 1. Not configured when 0 destinations exist.
    const initialHealth = await siem.health!();
    expect(initialHealth[0]?.component).toBe("siem.delivery");
    expect(initialHealth[0]?.state).toBe("not_configured");

    const serverCert = pki.issueServerCert({
      commonName: "collector.siem.test",
      dnsNames: ["collector.siem.test"],
    });
    const receiver = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    activeServers.push(receiver);

    // 2. Disabled when destination exists with enabled = false.
    const created = await withTestRequest(
      () =>
        siem.createDestination(admin, {
          name: "Primary Syslog",
          enabled: false,
          format: "syslog_rfc5425",
          host: "collector.siem.test",
          port: receiver.port,
          allowPrivateNetwork: true,
          categories: ["security", "admin"],
          secrets: { customCaPem: pki.ca.certPem },
        }),
      admin,
    );
    expect(created.enabled).toBe(false);
    expect(created.secrets.hasCustomCa).toBe(true);
    // Write-only check: raw PEM never appears in summary.
    expect(JSON.stringify(created)).not.toContain("BEGIN CERTIFICATE");

    const disabledHealth = await siem.health!();
    expect(disabledHealth[0]?.state).toBe("disabled");

    // 3. Enabled & clean => ok.
    await siem.setDestinationEnabled(admin, {
      publicId: created.publicId,
      enabled: true,
      expectedVersion: created.version,
    });
    const okHealth = await siem.health!();
    expect(okHealth[0]?.state).toBe("ok");

    // 4. Advance clock within 14 days of CA expiry => degraded; past CA expiry => failing.
    const soonExpiringPki = createTestPki({
      notBefore: new Date("2026-01-01T00:00:00.000Z"),
      notAfter: new Date("2026-11-25T00:00:00.000Z"), // 5 days from 2026-11-20
    });
    const refreshed = await siem.getDestination(admin, created.publicId);
    await siem.updateDestination(admin, {
      publicId: created.publicId,
      expectedVersion: refreshed.version,
      secrets: { customCaPem: soonExpiringPki.ca.certPem },
    });
    const degradedHealth = await siem.health!();
    expect(degradedHealth[0]?.state).toBe("degraded");

    h.clock.advance(6 * 24 * 60 * 60 * 1_000); // Past 2026-11-25
    const failingHealth = await siem.health!();
    expect(failingHealth[0]?.state).toBe("failing");

    await siem.close!();
  });

  it("delivers RFC 5424 octet-counted frames over TLS, reuses pooled sockets, and reconnects cleanly", async () => {
    const { h, siem, auditStream } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    const serverCert = pki.issueServerCert({
      commonName: "syslog.siem.test",
      dnsNames: ["syslog.siem.test"],
    });
    let receiver = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    activeServers.push(receiver);

    const dest = await siem.createDestination(admin, {
      name: "SOC RFC5425",
      enabled: true,
      format: "syslog_rfc5425",
      host: "syslog.siem.test",
      port: receiver.port,
      allowPrivateNetwork: true,
      facility: 16,
      enterpriseNumber: 54321,
      sdIdName: "rp",
      minSeverity: "WARN",
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    // Emit 3 audit events: 1 INFO (filtered out by minSeverity), 1 billing WARN (filtered out by category), 1 security WARN (matches!).
    auditStream.append({ event_name: "auth.session.viewed", severity_text: "INFO", severity_number: 9, category: "security" });
    auditStream.append({ event_name: "orders.invoice.warn", severity_text: "WARN", severity_number: 13, category: "business" });
    const matching = auditStream.append({
      event_name: "audit.checkpoint.created",
      severity_text: "WARN",
      severity_number: 13,
      category: "security",
      reason_code: "CHECKPOINT_SEALED",
      attributes: {
        auth_method: "totp",
        checkpoint_seq: 3,
        head_link_hmac_sha256: "a".repeat(64),
        note: "free-text note must be dropped by typed allowlist",
      },
    });
    // Also emit an internal SIEM delivery operational event — must be skipped to prevent feedback loops!
    auditStream.append({
      event_name: "siem.delivery.circuit_opened",
      severity_text: "WARN",
      severity_number: 13,
      category: "security",
    });

    const cycle1 = await siem.runDeliveryCycle();
    expect(cycle1).toEqual({ projected: 1, delivered: 1, failed: 0, deadLettered: 0 });
    await waitForCount(() => receiver.frames.length, 1);
    expect(receiver.frames.length).toBe(1);
    expect(receiver.handshakeCount).toBe(1);

    const wireMsg = receiver.frames[0]!;
    expect(wireMsg.startsWith("<132>1 ")).toBe(true);
    expect(wireMsg).toContain("[rp@54321 ");
    expect(wireMsg).toContain(`event_id="${matching.event_id}"`);
    expect(wireMsg).toContain('"auth_method":"totp"');
    expect(wireMsg).toContain(`"head_link_hmac_sha256":"${"a".repeat(64)}"`);
    expect(wireMsg).not.toContain("free-text note must be dropped");
    // Privacy proof: numeric actor_user_id (4242) and raw IP (203.0.113.77) NEVER leave the system!
    expect(wireMsg).not.toContain("4242");
    expect(wireMsg).not.toContain("203.0.113.77");

    // Second event reuses the exact same TLS connection (handshakeCount stays 1).
    auditStream.append({ event_name: "auth.lockout", severity_text: "ERROR", severity_number: 17, category: "security" });
    const cycle2 = await siem.runDeliveryCycle();
    expect(cycle2.delivered).toBe(1);
    await waitForCount(() => receiver.frames.length, 2);
    expect(receiver.frames.length).toBe(2);
    expect(receiver.handshakeCount).toBe(1);

    // Restart receiver on the SAME port to prove clean reconnect after remote socket close.
    const savedPort = receiver.port;
    await receiver.close();
    receiver = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem, port: savedPort });
    activeServers.push(receiver);

    auditStream.append({ event_name: "auth.bruteforce", severity_text: "FATAL", severity_number: 21, category: "security" });
    const cycle3 = await siem.runDeliveryCycle();
    expect(cycle3.delivered).toBe(1);
    await waitForCount(() => receiver.frames.length, 1);
    expect(receiver.frames.length).toBe(1);
    expect(receiver.frames[0]?.startsWith("<130>1 ")).toBe(true); // 16*8 + 2 (FATAL->Critical) = 130

    const summary = await siem.getDestination(admin, dest.publicId);
    expect(summary.delivery.deliveredCount).toBe(3);
    expect(summary.delivery.receiptConfirmation).toBe("transport_accepted");

    await siem.close!();
  });

  it("refuses untrusted CA and wrong-hostname certificates with ZERO delivery and ZERO plaintext/unverified fallback", async () => {
    const { h, siem } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    // Case A: Server presents a cert for `other-host.siem.test`, destination connects to `expected.siem.test`.
    const wrongHostCert = pki.issueServerCert({
      commonName: "other-host.siem.test",
      dnsNames: ["other-host.siem.test"],
    });
    const wrongHostServer = await startTlsReceiver({ certPem: wrongHostCert.certPem, keyPem: wrongHostCert.keyPem });
    activeServers.push(wrongHostServer);

    const destWrongHost = await siem.createDestination(admin, {
      name: "Wrong Host Test",
      enabled: false,
      format: "syslog_rfc5425",
      host: "expected.siem.test",
      port: wrongHostServer.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    const testWrongHost = await siem.sendTestEvent(admin, { publicId: destWrongHost.publicId });
    expect(testWrongHost.outcome).toBe("failed");
    expect(testWrongHost.reasonCode).toBe("TLS_HOSTNAME_MISMATCH");
    expect(testWrongHost.receiptConfirmation).toBe("none");
    expect(wrongHostServer.frames.length).toBe(0);

    // Case B: Server presents a cert signed by `untrustedPki`, destination trusts `pki.ca`.
    const rogueCert = untrustedPki.issueServerCert({
      commonName: "rogue.siem.test",
      dnsNames: ["rogue.siem.test"],
    });
    const rogueServer = await startTlsReceiver({ certPem: rogueCert.certPem, keyPem: rogueCert.keyPem });
    activeServers.push(rogueServer);

    const destUntrusted = await siem.createDestination(admin, {
      name: "Untrusted CA Test",
      enabled: false,
      format: "syslog_rfc5425",
      host: "rogue.siem.test",
      port: rogueServer.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    const testUntrusted = await siem.sendTestEvent(admin, { publicId: destUntrusted.publicId });
    expect(testUntrusted.outcome).toBe("failed");
    expect(testUntrusted.reasonCode).toBe("TLS_CERT_UNTRUSTED");
    expect(rogueServer.frames.length).toBe(0);

    await siem.close!();
  });

  it("enforces mutual TLS (mTLS): delivers with valid client cert/key and fails truthfully without client cert", async () => {
    const { h, siem } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    const serverCert = pki.issueServerCert({
      commonName: "mtls.siem.test",
      dnsNames: ["mtls.siem.test"],
    });
    const validClientCert = pki.issueClientCert({ commonName: "readypackets-forwarder" });

    const mtlsReceiver = await startTlsReceiver({
      certPem: serverCert.certPem,
      keyPem: serverCert.keyPem,
      clientCaPem: pki.ca.certPem,
      requireClientCert: true,
    });
    activeServers.push(mtlsReceiver);

    // 1. Without client certificate => receiver rejects handshake/post-handshake alert; test reports failed (never false success).
    const destNoClientCert = await siem.createDestination(admin, {
      name: "mTLS Missing Client Cert",
      enabled: false,
      format: "syslog_rfc5425",
      host: "mtls.siem.test",
      port: mtlsReceiver.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    const failedTest = await siem.sendTestEvent(admin, { publicId: destNoClientCert.publicId });
    expect(failedTest.outcome).toBe("failed");
    expect(["TLS_MTLS_REJECTED", "TLS_HANDSHAKE_FAILED", "CONNECTION_RESET"]).toContain(failedTest.reasonCode);
    expect(mtlsReceiver.frames.length).toBe(0);

    // 2. Rejects mismatched client cert + private key at configuration time.
    const otherClient = pki.issueClientCert({ commonName: "other-client" });
    await expect(
      siem.updateDestination(admin, {
        publicId: destNoClientCert.publicId,
        expectedVersion: destNoClientCert.version,
        secrets: {
          clientCertPem: validClientCert.certPem,
          clientKeyPem: otherClient.keyPem,
        },
      }),
    ).rejects.toMatchObject({ reasonCode: "MTLS_KEY_MISMATCH" });

    // 3. Configure matching client cert + key => fresh TLS handshake succeeds and frame arrives!
    const updated = await siem.updateDestination(admin, {
      publicId: destNoClientCert.publicId,
      expectedVersion: destNoClientCert.version,
      secrets: {
        clientCertPem: validClientCert.certPem,
        clientKeyPem: validClientCert.keyPem,
      },
    });
    expect(updated.secrets.hasClientCert).toBe(true);
    expect(updated.secrets.hasClientKey).toBe(true);

    const okTest = await siem.sendTestEvent(admin, { publicId: updated.publicId });
    expect(okTest.outcome).toBe("completed");
    expect(okTest.receiptConfirmation).toBe("transport_accepted");
    expect(mtlsReceiver.frames.length).toBe(1);
    expect(mtlsReceiver.frames[0]).toContain("siem.connectivity.test");

    await siem.close!();
  });

  it("delivers JSON Lines over TLS, CEF over TLS, and OTLP/HTTP JSON over HTTPS with auth headers", async () => {
    const { h, siem, auditStream } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    const serverCert = pki.issueServerCert({
      commonName: "multi.siem.test",
      dnsNames: ["multi.siem.test"],
    });

    const jsonlServer = await startTlsReceiver({
      certPem: serverCert.certPem,
      keyPem: serverCert.keyPem,
      mode: "lines",
    });
    const cefServer = await startTlsReceiver({
      certPem: serverCert.certPem,
      keyPem: serverCert.keyPem,
      mode: "octet",
    });
    const otlpServer = await startHttpsOtlpCollector({
      certPem: serverCert.certPem,
      keyPem: serverCert.keyPem,
    });
    activeServers.push(jsonlServer, cefServer, otlpServer);

    await siem.createDestination(admin, {
      name: "JSONL Receiver",
      enabled: true,
      format: "jsonl_tls",
      host: "multi.siem.test",
      port: jsonlServer.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    await siem.createDestination(admin, {
      name: "CEF Receiver",
      enabled: true,
      format: "cef_tls",
      host: "multi.siem.test",
      port: cefServer.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    const otlpDest = await siem.createDestination(admin, {
      name: "OTLP Collector",
      enabled: true,
      format: "otlp_https",
      host: "multi.siem.test",
      port: otlpServer.port,
      otlpPath: "/v1/logs",
      allowPrivateNetwork: true,
      authHeaderName: "Authorization",
      categories: ["security"],
      secrets: {
        customCaPem: pki.ca.certPem,
        authSecret: "Bearer otlp_synth_token_123",
      },
    });

    const ev = auditStream.append({
      event_name: "auth.step_up.completed",
      severity_text: "INFO",
      severity_number: 9,
      category: "security",
    });

    const res = await siem.runDeliveryCycle();
    expect(res).toEqual({ projected: 3, delivered: 3, failed: 0, deadLettered: 0 });

    expect(jsonlServer.lines.length).toBe(1);
    expect((JSON.parse(jsonlServer.lines[0]!) as { event_id: string }).event_id).toBe(ev.event_id);

    expect(cefServer.frames.length).toBe(1);
    expect(cefServer.frames[0]).toContain("CEF:0|ReadyPackets|");
    expect(cefServer.frames[0]).toContain(`externalId=${ev.event_id}`);

    expect(otlpServer.requests.length).toBe(1);
    expect(otlpServer.requests[0]?.path).toBe("/v1/logs");
    expect(otlpServer.requests[0]?.headers.authorization).toBe("Bearer otlp_synth_token_123");

    const otlpSummary = await siem.getDestination(admin, otlpDest.publicId);
    expect(otlpSummary.delivery.receiptConfirmation).toBe("collector_2xx");

    await siem.close!();
  });

  it("blocks SSRF / forbidden egress targets (cloud metadata IP and unapproved private networks)", async () => {
    const { h, siem } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    // Cloud metadata IP is unconditionally blocked even if allowPrivateNetwork = true!
    await expect(
      siem.createDestination(admin, {
        name: "Metadata SSRF Attempt",
        enabled: true,
        format: "otlp_https",
        host: "169.254.169.254",
        port: 443,
        allowPrivateNetwork: true,
        categories: ["security"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "EGRESS_BLOCKED" });

    // RFC1918 address is blocked when allowPrivateNetwork = false.
    await expect(
      siem.createDestination(admin, {
        name: "Unapproved Private IP",
        enabled: true,
        format: "syslog_rfc5425",
        host: "10.20.30.40",
        port: 6514,
        allowPrivateNetwork: false,
        categories: ["security"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", reasonCode: "EGRESS_BLOCKED" });

    await siem.close!();
  });

  it("handles retry/backoff, circuit breaking, dead-lettering, step-up replay, spool cap, and restart resume", async () => {
    const { h, siem, auditStream } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    await h.settings.set(SIEM_MAX_ATTEMPTS.key, 3);
    await h.settings.set(SIEM_CIRCUIT_THRESHOLD.key, 2);
    await h.settings.set(SIEM_CIRCUIT_COOLDOWN_SECONDS.key, 120);
    await h.settings.set(SIEM_OLDEST_ALERT_SECONDS.key, 60);

    const serverCert = pki.issueServerCert({
      commonName: "resilient.siem.test",
      dnsNames: ["resilient.siem.test"],
    });
    // Reserve an unused port by starting and immediately closing a receiver.
    const tempServer = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    const port = tempServer.port;
    await tempServer.close();

    const dest = await siem.createDestination(admin, {
      name: "Resilient Receiver",
      enabled: true,
      format: "syslog_rfc5425",
      host: "resilient.siem.test",
      port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    const ev1 = auditStream.append({ event_name: "auth.event.1", severity_text: "WARN", severity_number: 13, category: "security" });

    // Attempt 1 fails with CONNECTION_REFUSED (attempts = 1 < 3 => stays queued with backoff).
    const c1 = await siem.runDeliveryCycle();
    expect(c1).toEqual({ projected: 1, delivered: 0, failed: 1, deadLettered: 0 });

    // Immediate re-run before backoff expires does NOT hammer the down receiver.
    const cImmediate = await siem.runDeliveryCycle();
    expect(cImmediate.failed).toBe(0);

    // Advance FakeClock past attempt-1 backoff (15s) -> Attempt 2 fails => consecutiveFailures == 2 => circuit OPENS!
    h.clock.advance(20_000);
    admin.stepUpAt = h.clock.now();
    const c2 = await siem.runDeliveryCycle();
    expect(c2.failed).toBe(1);
    expect(c2.deadLettered).toBe(0);

    const afterC2 = await siem.getDestination(admin, dest.publicId);
    expect(afterC2.delivery.circuitState).toBe("open");
    expect(afterC2.delivery.lastFailureReason).toBe("CONNECTION_REFUSED");

    // While circuit is open (< 120s cooldown), cycle skips transmission even if item backoff elapsed.
    h.clock.advance(40_000);
    const cOpenSkip = await siem.runDeliveryCycle();
    expect(cOpenSkip.failed).toBe(0);

    // Advance past 120s circuit cooldown -> Attempt 3 fails => reaches maxAttempts (3) => DEAD-LETTERED!
    h.clock.advance(90_000);
    admin.stepUpAt = h.clock.now();
    const c3 = await siem.runDeliveryCycle();
    expect(c3.failed).toBe(1);
    expect(c3.deadLettered).toBe(1);

    const dls = await siem.listDeadLetters(admin, { destinationPublicId: dest.publicId });
    expect(dls.items.length).toBe(1);
    expect(dls.items[0]?.eventId).toBe(ev1.event_id);
    expect(dls.items[0]?.lastReasonCode).toBe("CONNECTION_REFUSED");

    // Now test spool bound (min 100) + simulated restart BEFORE bringing receiver online:
    await h.settings.set(SIEM_SPOOL_MAX_EVENTS.key, 100); // 1 dead-letter already in outbox => room for 99 more!
    const burstEvents: ExternalAuditEvent[] = [];
    for (let i = 2; i <= 105; i += 1) {
      burstEvents.push(
        auditStream.append({
          event_name: `auth.event.${i}`,
          severity_text: "WARN",
          severity_number: 13,
          category: "security",
        }),
      );
    }

    await siem.runDeliveryCycle();
    const saturatedDest = await siem.getDestination(admin, dest.publicId);
    // Spool cap = 100 (1 dead_letter + 99 queued), so remaining 5 events stay safely behind cursor without being dropped!
    expect(saturatedDest.delivery.queuedCount).toBe(99);
    expect(saturatedDest.delivery.deadLetterCount).toBe(1);
    expect(saturatedDest.delivery.lagSeq).toBe(5);

    const saturatedHealth = await siem.health!();
    expect(saturatedHealth[0]?.state).toBe("failing");

    // Simulate process restart: close current SIEM module and boot a brand-new instance on the same DB.
    await siem.close!();
    const restarted = createSiemModule(h.deps);
    h.services.siem = restarted;

    // Bring TLS receiver online on `port`, replay dead letters (step-up), and run delivery cycles!
    const liveReceiver = await startTlsReceiver({
      certPem: serverCert.certPem,
      keyPem: serverCert.keyPem,
      port,
    });
    activeServers.push(liveReceiver);

    admin.stepUpAt = h.clock.now();
    const replayRes = await restarted.replayDeadLetters(admin, { destinationPublicId: dest.publicId });
    expect(replayRes.replayedCount).toBe(1);

    // Cycle A drains the 100 queued items; Cycle B projects & delivers the 5 held-back events!
    await restarted.runDeliveryCycle();
    await restarted.runDeliveryCycle();
    await waitForCount(() => liveReceiver.frames.length, 105);

    expect(liveReceiver.frames.length).toBe(105);
    const allReceived = liveReceiver.frames.join("\n");
    expect(allReceived).toContain(ev1.event_id);
    expect(allReceived).toContain(burstEvents[0]!.event_id);
    expect(allReceived).toContain(burstEvents[burstEvents.length - 1]!.event_id);

    const recovered = await restarted.getDestination(admin, dest.publicId);
    expect(recovered.delivery.circuitState).toBe("closed");
    expect(recovered.delivery.queuedCount).toBe(0);
    expect(recovered.delivery.deadLetterCount).toBe(0);
    expect(recovered.delivery.lagSeq).toBe(0);

    await restarted.close!();
  });

  it("prevents concurrent multi-worker double-sends via per-destination lease and job fencingToken", async () => {
    const { h, siem, auditStream } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    const serverCert = pki.issueServerCert({
      commonName: "fenced.siem.test",
      dnsNames: ["fenced.siem.test"],
    });
    const receiver = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    activeServers.push(receiver);

    await siem.createDestination(admin, {
      name: "Fenced Receiver",
      enabled: true,
      format: "syslog_rfc5425",
      host: "fenced.siem.test",
      port: receiver.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    for (let i = 0; i < 5; i += 1) {
      auditStream.append({ event_name: `auth.concurrent.${i}`, severity_text: "WARN", severity_number: 13, category: "security" });
    }

    const mkJob = (jobId: string, fencingToken: number) => ({
      jobId,
      type: "siem.deliver",
      payload: {},
      attempt: 1,
      fencingToken,
      correlationId: `cor_${jobId}`,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });

    // Run two workers concurrently; lease + monotonic fencingToken ensures only one claims and sends.
    const [rHigh, rStale] = await Promise.all([
      siem.runDeliveryCycle({ job: mkJob("job_new", 10) }),
      siem.runDeliveryCycle({ job: mkJob("job_stale", 3) }),
    ]);

    expect(rHigh.delivered + rStale.delivered).toBe(5);
    await waitForCount(() => receiver.frames.length, 5);
    expect(receiver.frames.length).toBe(5);

    await siem.close!();
  });

  it("enforces zero-trust RBAC, step-up authentication via tRPC router, and fail-closed transactional audit", async () => {
    const { h, siem } = setupModule();
    const now = h.clock.now();

    const noopTransport: SessionTransport = { issue() {}, clear() {} };
    const createCaller = createCallerFactory(siemRouter);
    const makeCaller = (session: ReturnType<typeof fakePrincipal> | null) =>
      createCaller({
        services: h.services,
        session,
        request: newRequestContext("test"),
        transport: noopTransport,
      });

    // 1. Anonymous, customer, staff, and remediation-pending admin are refused and audited.
    await expect(makeCaller(null).admin.destinations.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const customer = fakePrincipal({ role: "customer", authenticatedAt: now, mfaVerifiedAt: now });
    await expect(makeCaller(customer).admin.destinations.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const staff = fakePrincipal({ role: "staff", authenticatedAt: now, mfaVerifiedAt: now });
    await expect(makeCaller(staff).admin.destinations.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const remediationAdmin = fakePrincipal({
      role: "admin",
      state: "remediation",
      pendingSteps: ["enroll_mfa"],
    });
    await expect(makeCaller(remediationAdmin).admin.destinations.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 2. Full admin WITHOUT step-up can read, and is refused with STEP_UP_REQUIRED on mutations.
    const unsteppedAdmin = fakePrincipal({
      role: "admin",
      state: "full",
      pendingSteps: [],
      authenticatedAt: now,
      mfaVerifiedAt: now,
      stepUpAt: null,
    });
    expect(await makeCaller(unsteppedAdmin).admin.destinations.list()).toEqual([]);

    await expect(
      makeCaller(unsteppedAdmin).admin.destinations.create({
        name: "No StepUp",
        enabled: false,
        format: "syslog_rfc5425",
        host: "siem.example.com",
        categories: ["security"],
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });

    // 3. Stale step-up (> 10 minutes old) is also refused.
    const staleAdmin = fakePrincipal({
      role: "admin",
      state: "full",
      pendingSteps: [],
      authenticatedAt: now,
      mfaVerifiedAt: now,
      stepUpAt: new Date(now.getTime() - 11 * 60 * 1_000),
    });
    await expect(
      makeCaller(staleAdmin).admin.destinations.create({
        name: "Stale StepUp",
        enabled: false,
        format: "syslog_rfc5425",
        host: "siem.example.com",
        categories: ["security"],
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });

    // 4. Fail-closed audit: if `audit.record` throws `AuditUnavailableError`, neither DB row nor encrypted secret column persists!
    const validAdmin = steppedUpAdmin(now);
    h.audit.failRecords = true;
    await expect(
      siem.createDestination(validAdmin, {
        name: "Should Rollback",
        enabled: false,
        format: "otlp_https",
        host: "rollback.siem.test",
        allowPrivateNetwork: true,
        categories: ["security"],
        secrets: { authSecret: "Bearer top_secret_should_rollback" },
      }),
    ).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    h.audit.failRecords = false;

    expect(await siem.listDestinations(validAdmin)).toEqual([]);

    await siem.close!();
  });

  it("REGRESSION (Cross-Model Review Rules 1, 2, 3): 1-connection pool never self-deadlocks, in-tx actor revocation fails closed, and deletes audit before removing rows", async () => {
    // Rule 1: Create a strict `connectionLimit: 1` MySQL pool over `testDb.url` and wire a DB-backed SettingsStore
    // + DB-backed AuditEmitter that execute `SELECT 1` on `tx` (would deadlock immediately if `pool` instead of `tx` were used!).
    const singleConnPool = mysql.createPool({
      uri: testDb.url,
      connectionLimit: 1,
      waitForConnections: true,
      queueLimit: 0,
      timezone: "Z",
      supportBigNumbers: true,
      charset: "utf8mb4",
    });
    const singleDb = drizzle(singleConnPool, { mode: "default" }) as unknown as Db;

    try {
      const secretBacking = new Map<string, string>();
      const txRequiredSettings: SettingsStore = {
        async get<T>(_key: string, _parse: (raw: unknown) => T, fallback: T, tx?: Tx): Promise<T> {
          const runner = tx ?? singleDb;
          await runner.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
          return fallback;
        },
        async set(_key: string, _val: unknown, tx?: Tx): Promise<void> {
          const runner = tx ?? singleDb;
          await runner.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
        },
        async getSecret(key: string, tx?: Tx): Promise<string | null> {
          const runner = tx ?? singleDb;
          await runner.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
          return secretBacking.get(key) ?? null;
        },
        async setSecret(key: string, value: string | null, tx?: Tx): Promise<void> {
          const runner = tx ?? singleDb;
          await runner.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
          if (value === null) secretBacking.delete(key);
          else secretBacking.set(key, value);
        },
        async isFeatureEnabled(_flag: string, tx?: Tx): Promise<boolean> {
          const runner = tx ?? singleDb;
          await runner.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
          return false;
        },
      };

      const auditLogOrder: string[] = [];
      let failDeleteAudit = false;
      const txVerifyingAudit: AuditEmitter = {
        async record(event: AuditEventInput, tx?: Tx): Promise<void> {
          if (failDeleteAudit && event.action === "delete") {
            throw new DomainError("UNAVAILABLE", "AUDIT_UNAVAILABLE", "Audit unavailable");
          }
          const runner = tx ?? singleDb;
          // Also verify Rule 3 on delete: when `siem.destination.deleted` is recorded, the destination row MUST STILL EXIST in `tx`!
          if (event.eventName === "siem.destination.deleted" && tx) {
            const existing = await tx.select().from(siemDestinations);
            expect(existing.length).toBe(1);
            auditLogOrder.push("audit_recorded_while_row_still_exists");
          }
          await runner.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
        },
        note() {},
      };

      const h = createTestDeps({ db: singleDb });
      h.deps.settings = txRequiredSettings;
      h.deps.audit = txVerifyingAudit;
      h.services.integrations = {
        egress: createLoopbackPinningEgress(createEgressPolicy(h.deps)),
      } as unknown as typeof h.services.integrations;

      // Rule 2: Wire live in-tx identity session & role state so mid-flight revocation/demotion is caught inside `tx`.
      let liveSessionState = {
        live: true,
        role: "admin" as "admin" | "customer",
        userStatus: "active",
        stepUpAt: h.clock.now() as Date | null,
      };
      h.services.identity = {
        sessions: {
          assertCurrent: async (_principal: unknown, tx: Tx) => {
            await tx.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
            if (!liveSessionState.live) {
              throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Revoked");
            }
            return { pendingSteps: [] };
          },
          getState: async (_sessionId: string, opts?: { tx?: Tx }) => {
            const runner = opts?.tx ?? singleDb;
            await runner.execute(mysql.format("SELECT 1") as unknown as Parameters<Db["execute"]>[0]);
            return liveSessionState;
          },
        },
      } as unknown as typeof h.services.identity;

      const siem = createSiemModule(h.deps);
      const admin = steppedUpAdmin(h.clock.now());

      // Execute full create -> update -> delete lifecycle on a `connectionLimit: 1` pool without deadlocking!
      const created = await siem.createDestination(admin, {
        name: "Single Pool Proof",
        enabled: false,
        format: "otlp_https",
        host: "singlepool.siem.test",
        allowPrivateNetwork: true,
        categories: ["security"],
        secrets: { authSecret: "Bearer single_pool_token" },
      });

      const updated = await siem.updateDestination(admin, {
        publicId: created.publicId,
        expectedVersion: created.version,
        minSeverity: "WARN",
      });
      expect(updated.minSeverity).toBe("WARN");
      expect(updated.secrets.hasAuthSecret).toBe(true);

      // Rule 2 check A: Demote actor role in DB while `admin` snapshot still claims `role: "admin"`.
      liveSessionState = { ...liveSessionState, role: "customer" };
      await expect(
        siem.deleteDestination(admin, { publicId: updated.publicId, expectedVersion: updated.version }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // Rule 2 check B: Revoke actor session in DB while `admin` snapshot still looks valid.
      liveSessionState = { ...liveSessionState, role: "admin", live: false };
      await expect(
        siem.deleteDestination(admin, { publicId: updated.publicId, expectedVersion: updated.version }),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED", reasonCode: "SESSION_NOT_CURRENT" });

      // Restore active admin session; verify Rule 3: if delete audit fails, row + per-row encrypted secrets remain intact!
      liveSessionState = { ...liveSessionState, live: true };
      failDeleteAudit = true;
      await expect(
        siem.deleteDestination(admin, { publicId: updated.publicId, expectedVersion: updated.version }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
      const surviving = await siem.listDestinations(admin);
      expect(surviving.length).toBe(1);
      expect(surviving[0]?.secrets.hasAuthSecret).toBe(true);

      // Allow audit -> delete commits, having recorded audit BEFORE deleting the row!
      failDeleteAudit = false;
      await siem.deleteDestination(admin, { publicId: updated.publicId, expectedVersion: updated.version });
      expect(auditLogOrder).toEqual(["audit_recorded_while_row_still_exists"]);
      expect(await siem.listDestinations(admin)).toEqual([]);

      await siem.close!();
    } finally {
      await singleConnPool.end();
    }
  });

  it("REGRESSION (Security Review): endpoint edits enforce credential rotation/clear + backlog quarantine/migration, and concurrent per-destination secret updates never clobber", async () => {
    const { h, siem, auditStream } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    const serverCert = pki.issueServerCert({
      commonName: "*.siem.test",
      dnsNames: ["old.siem.test", "new.siem.test", "dest-a.siem.test", "dest-b.siem.test"],
    });
    const otlpA = await startHttpsOtlpCollector({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    const otlpB = await startHttpsOtlpCollector({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    activeServers.push(otlpA, otlpB);

    // 1. Concurrent updates on distinct destinations never overwrite each other's encrypted secret columns.
    const destA = await siem.createDestination(admin, {
      name: "Collector A",
      enabled: false,
      format: "otlp_https",
      host: "dest-a.siem.test",
      port: otlpA.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });
    const destB = await siem.createDestination(admin, {
      name: "Collector B",
      enabled: false,
      format: "otlp_https",
      host: "dest-b.siem.test",
      port: otlpB.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    await Promise.all([
      siem.updateDestination(admin, {
        publicId: destA.publicId,
        expectedVersion: destA.version,
        secrets: { authSecret: "Bearer secret_alpha" },
      }),
      siem.updateDestination(admin, {
        publicId: destB.publicId,
        expectedVersion: destB.version,
        secrets: { authSecret: "Bearer secret_bravo" },
      }),
    ]);

    const resA = await siem.sendTestEvent(admin, { publicId: destA.publicId });
    const resB = await siem.sendTestEvent(admin, { publicId: destB.publicId });
    expect(resA.outcome).toBe("completed");
    expect(resB.outcome).toBe("completed");
    expect(otlpA.requests[0]?.headers.authorization).toBe("Bearer secret_alpha");
    expect(otlpB.requests[0]?.headers.authorization).toBe("Bearer secret_bravo");

    // 2. Changing `host` while `hasAuthSecret` is true WITHOUT rotating or clearing authSecret is rejected!
    const freshA = await siem.getDestination(admin, destA.publicId);
    await expect(
      siem.updateDestination(admin, {
        publicId: freshA.publicId,
        expectedVersion: freshA.version,
        host: "new.siem.test",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "CREDENTIALS_REQUIRE_ROTATION_OR_CLEAR",
    });

    // 3. Queue an undelivered event on `destA` (point port at a closed receiver first), then change endpoint with `migrateBacklog: false` (default) => quarantined to dead_letter with `ENDPOINT_CHANGED`!
    const closedTmp = await startHttpsOtlpCollector({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    const closedPort = closedTmp.port;
    await closedTmp.close();

    const movedToClosed = await siem.updateDestination(admin, {
      publicId: freshA.publicId,
      expectedVersion: freshA.version,
      enabled: true,
      port: closedPort,
      secrets: { authSecret: "Bearer rotated_for_closed" },
    });
    auditStream.append({ event_name: "auth.queued.old_endpoint", severity_text: "WARN", severity_number: 13, category: "security" });
    const failedCycle = await siem.runDeliveryCycle();
    expect(failedCycle.projected).toBe(1);
    expect(failedCycle.failed).toBe(1);

    const beforeRepoint = await siem.getDestination(admin, movedToClosed.publicId);
    expect(beforeRepoint.delivery.queuedCount).toBe(1);

    // Repoint to `new.siem.test:otlpB.port` WITHOUT `migrateBacklog: true` => queued backlog is quarantined (`ENDPOINT_CHANGED`)!
    const repointed = await siem.updateDestination(admin, {
      publicId: beforeRepoint.publicId,
      expectedVersion: beforeRepoint.version,
      host: "new.siem.test",
      port: otlpB.port,
      secrets: { authSecret: "Bearer rotated_for_new_endpoint" },
    });
    expect(repointed.delivery.queuedCount).toBe(0);
    expect(repointed.delivery.deadLetterCount).toBe(1);

    const quarantinedDls = await siem.listDeadLetters(admin, { destinationPublicId: repointed.publicId });
    expect(quarantinedDls.items[0]?.lastReasonCode).toBe("ENDPOINT_CHANGED");

    await siem.close!();
  });

  it("REGRESSION (Security & Audit S-1): persists progress-only cursor across retention-pruned empty pages, records siem.audit.loss_detected on missing gaps, and flags overdue lag", async () => {
    const { h, siem, auditStream } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());

    const serverCert = pki.issueServerCert({
      commonName: "cursor.siem.test",
      dnsNames: ["cursor.siem.test"],
    });
    const receiver = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    activeServers.push(receiver);

    const dest = await siem.createDestination(admin, {
      name: "Cursor Progress Receiver",
      enabled: true,
      format: "syslog_rfc5425",
      host: "cursor.siem.test",
      port: receiver.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    const postPruneEvent = {
      ...auditStream.append({
        event_name: "auth.after_pruned_window",
        severity_text: "WARN",
        severity_number: 13,
        category: "security",
      }),
      chain_seq: 251,
    };

    // Page 1: 250 retention-pruned events (`events: []`, `nextCursor: "seq:250"`, `pruned: 250`).
    // Page 2: real event at `seq: 251`.
    auditStream.enqueueScriptedBatch({
      events: [],
      nextCursor: "seq:250",
      headSeq: 251,
      pruned: 250,
      missing: 0,
    });
    auditStream.enqueueScriptedBatch({
      events: [postPruneEvent],
      nextCursor: "seq:251",
      headSeq: 251,
      pruned: 0,
      missing: 0,
    });
    auditStream.enqueueScriptedBatch({
      events: [],
      nextCursor: "seq:251",
      headSeq: 251,
      pruned: 0,
      missing: 0,
    });

    const cycle1 = await siem.runDeliveryCycle();
    expect(cycle1.projected).toBe(1);
    expect(cycle1.delivered).toBe(1);
    await waitForCount(() => receiver.frames.length, 1);
    expect(receiver.frames[0]).toContain("auth.after_pruned_window");

    const afterPrune = await siem.getDestination(admin, dest.publicId);
    expect(afterPrune.delivery.lastProjectedSeq).toBe(251);
    expect(afterPrune.delivery.prunedAuditCount).toBe(250);
    expect(afterPrune.delivery.missingAuditGapCount).toBe(0);

    // Now simulate unexplained audit loss (`missing: 3`): must record durable `siem.audit.loss_detected` (WARN, AUDIT_EVENTS_MISSING) and mark health `failing`.
    auditStream.enqueueScriptedBatch({
      events: [],
      nextCursor: "seq:254",
      headSeq: 254,
      pruned: 0,
      missing: 3,
    });
    auditStream.enqueueScriptedBatch({
      events: [],
      nextCursor: "seq:254",
      headSeq: 254,
      pruned: 0,
      missing: 0,
    });

    await siem.runDeliveryCycle();

    const lossEvent = h.audit.events.find((e) => e.eventName === "siem.audit.loss_detected");
    expect(lossEvent).toBeDefined();
    expect(lossEvent?.severity).toBe("WARN");
    expect(lossEvent?.reasonCode).toBe("AUDIT_EVENTS_MISSING");
    expect(lossEvent?.safeCounts).toMatchObject({ missing: 3 });

    const afterGap = await siem.getDestination(admin, dest.publicId);
    expect(afterGap.delivery.missingAuditGapCount).toBe(3);

    const gapHealth = await siem.health!();
    expect(gapHealth[0]?.state).toBe("failing");
    expect(gapHealth[0]?.metrics?.missingAuditGaps).toBe(3);

    await siem.close!();
  });

  it("REGRESSION (Security Review): cross-job fencingToken values never starve subsequent jobs, live egress revocation evicts pooled TLS sockets, and missing egress port fails closed", async () => {
    let allowEgress = true;
    const { h, siem, auditStream } = setupModule();
    const baseEgress = h.services.integrations.egress;
    const revokedEgress: IntegrationsEgressPort = {
      async resolveAndAssertAllowed(input) {
        if (!allowEgress) {
          throw new DomainError("FORBIDDEN", "EGRESS_BLOCKED", "Destination revoked by live egress policy.");
        }
        return baseEgress.resolveAndAssertAllowed!(input);
      },
    };
    h.services.integrations = { egress: revokedEgress } as unknown as typeof h.services.integrations;

    const admin = steppedUpAdmin(h.clock.now());
    const serverCert = pki.issueServerCert({
      commonName: "egress-live.siem.test",
      dnsNames: ["egress-live.siem.test"],
    });
    const receiver = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    activeServers.push(receiver);

    const dest = await siem.createDestination(admin, {
      name: "Live Egress Guarded",
      enabled: true,
      format: "syslog_rfc5425",
      host: "egress-live.siem.test",
      port: receiver.port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    const mkJob = (jobId: string, fencingToken: number) => ({
      jobId,
      type: "siem.deliver",
      payload: {},
      attempt: 1,
      fencingToken,
      correlationId: `cor_${jobId}`,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });

    // 1. Job A runs with `fencingToken: 50`; subsequent scheduled Job B has `fencingToken: 1` (fresh job row) and MUST NOT be starved!
    auditStream.append({ event_name: "auth.job_a", severity_text: "WARN", severity_number: 13, category: "security" });
    const rA = await siem.runDeliveryCycle({ job: mkJob("job_retried_high_token", 50) });
    expect(rA.delivered).toBe(1);

    auditStream.append({ event_name: "auth.job_b", severity_text: "WARN", severity_number: 13, category: "security" });
    const rB = await siem.runDeliveryCycle({ job: mkJob("job_next_scheduled_token_1", 1) });
    expect(rB.delivered).toBe(1);
    await waitForCount(() => receiver.frames.length, 2);
    expect(receiver.handshakeCount).toBe(1); // Reused pooled socket while egress remained allowed!

    // 2. Revoke egress live! Even though a pooled TLS socket is open, the next batch MUST re-authorize via egress, evict the socket, and deliver ZERO frames!
    allowEgress = false;
    auditStream.append({ event_name: "auth.after_revocation", severity_text: "WARN", severity_number: 13, category: "security" });
    const rRevoked = await siem.runDeliveryCycle({ job: mkJob("job_after_revoke", 1) });
    expect(rRevoked.delivered).toBe(0);
    expect(rRevoked.failed).toBe(1);
    expect(receiver.frames.length).toBe(2);

    const postRevoke = await siem.getDestination(admin, dest.publicId);
    expect(postRevoke.delivery.lastFailureReason).toBe("EGRESS_BLOCKED");

    // 3. Removing centralized egress port altogether fails closed (`EGRESS_BLOCKED`) instead of bypassing policy.
    (h.services as unknown as { integrations?: unknown }).integrations = undefined;
    await expect(
      siem.createDestination(admin, {
        name: "No Egress Service",
        enabled: false,
        format: "syslog_rfc5425",
        host: "egress-live.siem.test",
        port: receiver.port,
        allowPrivateNetwork: true,
        categories: ["security"],
      }),
    ).rejects.toMatchObject({ reasonCode: "EGRESS_BLOCKED" });

    await siem.close!();
  });

  it("REGRESSION (Security Review): enforces strict FIFO head-of-line backoff and requires step-up on isolated sendTestEvent", async () => {
    const { h, siem, auditStream } = setupModule();
    const admin = steppedUpAdmin(h.clock.now());
    await h.settings.set(SIEM_CIRCUIT_THRESHOLD.key, 10); // Keep circuit closed so item-level backoff is exercised directly.

    const serverCert = pki.issueServerCert({
      commonName: "fifo.siem.test",
      dnsNames: ["fifo.siem.test"],
    });
    const temp = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem });
    const port = temp.port;
    await temp.close();

    const dest = await siem.createDestination(admin, {
      name: "Strict FIFO Receiver",
      enabled: true,
      format: "syslog_rfc5425",
      host: "fifo.siem.test",
      port,
      allowPrivateNetwork: true,
      categories: ["security"],
      secrets: { customCaPem: pki.ca.certPem },
    });

    // Event 1 fails at t=0 -> backed off for ~1.6s–2.4s (`nextAttemptAt >= t + 1.6s`).
    const firstEv = auditStream.append({ event_name: "auth.fifo.first", severity_text: "WARN", severity_number: 13, category: "security" });
    const c1 = await siem.runDeliveryCycle();
    expect(c1.failed).toBe(1);

    // Event 2 arrives at t=500ms while receiver is now ONLINE! Because Event 1 is still backed off at the head of the FIFO queue, Event 2 MUST NOT overtake Event 1!
    h.clock.advance(500);
    const liveReceiver = await startTlsReceiver({ certPem: serverCert.certPem, keyPem: serverCert.keyPem, port });
    activeServers.push(liveReceiver);

    const secondEv = auditStream.append({ event_name: "auth.fifo.second", severity_text: "WARN", severity_number: 13, category: "security" });
    const c2 = await siem.runDeliveryCycle();
    expect(c2.projected).toBe(1);
    expect(c2.delivered).toBe(0);
    expect(liveReceiver.frames.length).toBe(0);

    // Once FakeClock advances past Event 1's backoff, BOTH deliver strictly in FIFO order (`firstEv` then `secondEv`)!
    h.clock.advance(20_000);
    admin.stepUpAt = h.clock.now();
    const c3 = await siem.runDeliveryCycle();
    expect(c3.delivered).toBe(2);
    await waitForCount(() => liveReceiver.frames.length, 2);
    expect(liveReceiver.frames[0]).toContain(firstEv.event_id);
    expect(liveReceiver.frames[1]).toContain(secondEv.event_id);
    expect(liveReceiver.handshakeCount).toBe(1);

    // Verify `destinations.test` via tRPC router requires `siem.manage` + step-up, and uses a one-shot isolated socket without evicting the worker's pooled socket!
    const noopTransport: SessionTransport = { issue() {}, clear() {} };
    const createCaller = createCallerFactory(siemRouter);
    const unstepped = fakePrincipal({
      role: "admin",
      state: "full",
      pendingSteps: [],
      authenticatedAt: h.clock.now(),
      mfaVerifiedAt: h.clock.now(),
      stepUpAt: null,
    });
    await expect(
      createCaller({ services: h.services, session: unstepped, request: newRequestContext("test"), transport: noopTransport })
        .admin.destinations.test({ publicId: dest.publicId }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) });

    const probe = await siem.sendTestEvent(admin, { publicId: dest.publicId });
    expect(probe.outcome).toBe("completed");
    await waitForCount(() => liveReceiver.frames.length, 3);
    expect(liveReceiver.handshakeCount).toBe(2); // Probe dialed its own one-shot TLS socket

    // Subsequent worker cycle STILL reuses its original pooled socket (`handshakeCount` stays 2, not 3!).
    auditStream.append({ event_name: "auth.fifo.third", severity_text: "WARN", severity_number: 13, category: "security" });
    const c4 = await siem.runDeliveryCycle();
    expect(c4.delivered).toBe(1);
    await waitForCount(() => liveReceiver.frames.length, 4);
    expect(liveReceiver.handshakeCount).toBe(2);

    await siem.close!();
  });
});
