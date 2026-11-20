/**
 * End-to-end SIEM forwarding integration journey (owner: siem_engineer).
 *
 * Exercises the real assembled system (`createContainer` + MySQL + `createApp` via Supertest):
 *   1. Bootstraps an administrator (`identity.provisionLocalAccount`), completes forced password
 *      rotation + TOTP MFA enrolment + step-up authentication over HTTP/cookies/CSRF.
 *   2. Authorizes loopback RFC 5425 targets exclusively through the sanctioned egress admin API
 *      (`integrations.admin.egress.create` in `test` deployment profile; production defaults remain
 *      untouched) and creates an enabled RFC 5425 TLS destination trusting a runtime-generated CA.
 *   3. Triggers real user/admin HTTP actions (sign-in failure + platform setting update) and runs
 *      `audit.chain.seal` and `siem.deliver` through the real MySQL job queue (`drainJobs()`).
 *   4. Verifies octet-framed RFC 5424 messages arrive over TLS with structured data carrying the
 *      exact `X-Request-Id` / correlation IDs from the HTTP responses and zero secret/PII fields.
 *   5. Verifies a destination configured against an untrusted CA delivers zero frames and surfaces
 *      `state: "failing"` in the admin health APIs.
 */
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleHealth } from "../../server/core/types.js";
import type { SiemDestinationSummary } from "../../server/modules/siem/index.js";
import { createTestPki } from "../../server/modules/siem/testPki.js";
import {
  Browser,
  NEW_PASSWORD,
  STRONG_PASSWORD,
  bootstrapAdmin,
  createSystem,
  stepUp,
  type System,
} from "./harness.js";

interface FramedTlsReceiver {
  port: number;
  frames: { declaredLength: number; message: string }[];
  rawBytesReceived: number;
  handshakeCount: number;
  tlsErrorCount: number;
  close(): Promise<void>;
}

async function startOctetFramedTlsReceiver(options: {
  certPem: string;
  keyPem: string;
}): Promise<FramedTlsReceiver> {
  const frames: { declaredLength: number; message: string }[] = [];
  let rawBytesReceived = 0;
  let handshakeCount = 0;
  let tlsErrorCount = 0;
  const sockets = new Set<Duplex>();

  const server = tls.createServer(
    {
      cert: options.certPem,
      key: options.keyPem,
      minVersion: "TLSv1.2",
    },
    (socket) => {
      handshakeCount += 1;
      sockets.add(socket);
      let buf: Buffer = Buffer.alloc(0);

      socket.on("data", (chunk: Buffer) => {
        rawBytesReceived += chunk.byteLength;
        buf = Buffer.concat([buf, chunk]);

        while (buf.length > 0) {
          const spaceIdx = buf.indexOf(0x20);
          if (spaceIdx <= 0) break;
          const prefix = buf.subarray(0, spaceIdx).toString("ascii");
          if (!/^[1-9][0-9]*$/.test(prefix)) break;
          const declaredLength = Number(prefix);
          const frameEnd = spaceIdx + 1 + declaredLength;
          if (buf.length < frameEnd) break;

          const payloadBytes = buf.subarray(spaceIdx + 1, frameEnd);
          expect(payloadBytes.byteLength).toBe(declaredLength);
          frames.push({
            declaredLength,
            message: payloadBytes.toString("utf8"),
          });
          buf = Buffer.from(buf.subarray(frameEnd));
        }
      });

      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    },
  );

  server.on("tlsClientError", () => {
    tlsErrorCount += 1;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    frames,
    get rawBytesReceived() {
      return rawBytesReceived;
    },
    get handshakeCount() {
      return handshakeCount;
    },
    get tlsErrorCount() {
      return tlsErrorCount;
    },
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForFrames(getter: () => number, minCount: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getter() < minCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface ParsedRfc5424Frame {
  raw: string;
  sdParams: Record<string, string>;
  jsonPayload: Record<string, unknown>;
}

function parseRfc5424Frame(raw: string): ParsedRfc5424Frame {
  // <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD-ID k="v" ...] \uFEFF?{json}
  const match = /^<\d{1,3}>1 (\S+) (\S+) (\S+) (\S+) (\S+) \[([^\]]+)\] ([\s\S]+)$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid RFC 5424 message structure: ${raw}`);
  }
  const sdBlock = match[6]!;
  const sdParams: Record<string, string> = {};
  const paramRegex = /([a-z0-9_]+)="((?:\\.|[^"\\])*)"/g;
  let pm: RegExpExecArray | null;
  while ((pm = paramRegex.exec(sdBlock)) !== null) {
    sdParams[pm[1]!] = pm[2]!.replace(/\\(["\\\]])/g, "$1");
  }

  const bodyText = match[7]!.replace(/^\uFEFF/, "");
  const jsonPayload = JSON.parse(bodyText) as Record<string, unknown>;
  return { raw, sdParams, jsonPayload };
}

describe("integration journey: end-to-end RFC 5425 TLS SIEM forwarding", () => {
  let sys: System;
  const activeReceivers: FramedTlsReceiver[] = [];

  beforeAll(async () => {
    sys = await createSystem();
  });

  afterAll(async () => {
    while (activeReceivers.length > 0) {
      const r = activeReceivers.pop()!;
      await r.close();
    }
    if (sys) {
      await sys.close();
    }
  });

  it("forwards correlated RFC 5424 octet-framed audit events over TLS without PII/secrets and surfaces failing health on untrusted CA", async () => {
    // 1. Runtime-generated trusted + untrusted CAs and in-process RFC 5425 TLS receivers on loopback.
    const trustedPki = createTestPki({ caCommonName: "ReadyPackets Trusted SIEM Root CA" });
    const untrustedPki = createTestPki({ caCommonName: "Untrusted Rogue SIEM Root CA" });

    const trustedLeaf = trustedPki.issueServerCert({
      commonName: "127.0.0.1",
      ipAddresses: ["127.0.0.1"],
    });
    const untrustedLeaf = untrustedPki.issueServerCert({
      commonName: "127.0.0.1",
      ipAddresses: ["127.0.0.1"],
    });

    const trustedReceiver = await startOctetFramedTlsReceiver({
      certPem: trustedLeaf.certPem,
      keyPem: trustedLeaf.keyPem,
    });
    activeReceivers.push(trustedReceiver);

    const untrustedReceiver = await startOctetFramedTlsReceiver({
      certPem: untrustedLeaf.certPem,
      keyPem: untrustedLeaf.keyPem,
    });
    activeReceivers.push(untrustedReceiver);

    // 2. Bootstrap administrator, sign in, enrol TOTP MFA, and perform step-up over HTTP.
    const admin = await bootstrapAdmin(sys, "siem-admin@example.test");
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));

    // 3. Authorize loopback target ONLY through the sanctioned admin egress allowlist API (`test` profile seam).
    Browser.ok(
      await admin.browser.mutate("integrations.admin.egress.create", {
        purpose: "siem",
        matchType: "ip",
        pattern: "127.0.0.1",
        port: trustedReceiver.port,
        protocol: "tls:",
        allowPrivateAddress: true,
        enabled: true,
        justification: "Authorize in-process RFC 5425 TLS receiver for integration verification.",
      }),
    );

    // 4. Create enabled RFC 5425 TLS destination via HTTP trusting `trustedPki.ca.certPem`.
    const createDestResult = await admin.browser.mutate<SiemDestinationSummary>(
      "siem.admin.destinations.create",
      {
        name: "Primary RFC 5425 TLS Collector",
        enabled: true,
        format: "syslog_rfc5425",
        host: "127.0.0.1",
        port: trustedReceiver.port,
        allowPrivateNetwork: true,
        enterpriseNumber: 54321,
        sdIdName: "rp",
        minSeverity: "INFO",
        categories: ["security", "admin", "system", "integration"],
        secrets: {
          customCaPem: trustedPki.ca.certPem,
        },
      },
    );
    const trustedDest = Browser.ok(createDestResult);
    expect(trustedDest.enabled).toBe(true);
    expect(trustedDest.secrets.hasCustomCa).toBe(true);

    // 5. Real user/admin HTTP actions producing durable audit events with HTTP `X-Request-Id` headers.
    const wrongPasswordSecret = "wrong-password-secret-attempt-do-not-leak-98765";
    const outsider = sys.browser({ address: "203.0.113.77" });
    const failedSignIn = await outsider.mutate("identity.signIn", {
      email: admin.email,
      password: wrongPasswordSecret,
    });
    expect(failedSignIn.status).toBe(401);
    expect(failedSignIn.requestId).toBeTruthy();
    expect(failedSignIn.res.headers["x-request-id"]).toBe(failedSignIn.requestId);

    const allSettings = Browser.ok(
      await admin.browser.query<{ key: string; version: number }[]>("platform.admin.settings.list"),
    );
    const thresholdSetting = allSettings.find((s) => s.key === "siem.delivery.circuit_threshold");
    expect(thresholdSetting).toBeDefined();

    const settingsUpdate = await admin.browser.mutate("platform.admin.settings.update", {
      key: "siem.delivery.circuit_threshold",
      value: 2,
      expectedVersion: thresholdSetting!.version,
    });
    Browser.ok(settingsUpdate);
    expect(settingsUpdate.requestId).toBeTruthy();
    expect(settingsUpdate.res.headers["x-request-id"]).toBe(settingsUpdate.requestId);

    // 6. Seal the tamper-evident audit chain and execute `siem.deliver` through the real MySQL job queue.
    await sys.container.services.jobs.enqueue("audit.chain.seal", {});
    await sys.drainJobs();
    await sys.container.services.jobs.enqueue("siem.deliver", {});
    await sys.drainJobs();

    await waitForFrames(
      () => trustedReceiver.frames.filter((f) => f.message.includes(settingsUpdate.requestId)).length,
      1,
    );
    expect(trustedReceiver.handshakeCount).toBeGreaterThanOrEqual(1);
    expect(trustedReceiver.frames.length).toBeGreaterThanOrEqual(4);

    // 7. Parse received octet-counted RFC 5424 frames and verify correlation IDs + strict zero-PII/secret projection.
    const parsedFrames = trustedReceiver.frames.map((f) => parseRfc5424Frame(f.message));

    const signInFailureFrames = parsedFrames.filter(
      (f) => f.sdParams.request_id === failedSignIn.requestId,
    );
    expect(signInFailureFrames.length).toBeGreaterThanOrEqual(1);
    for (const frame of signInFailureFrames) {
      expect(frame.sdParams.request_id).toBe(String(failedSignIn.res.headers["x-request-id"]));
      expect(frame.jsonPayload.request_id).toBe(String(failedSignIn.res.headers["x-request-id"]));
      expect(frame.sdParams.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(frame.jsonPayload.category).toBe("security");
    }

    const settingsChangeFrames = parsedFrames.filter(
      (f) => f.sdParams.request_id === settingsUpdate.requestId,
    );
    expect(settingsChangeFrames.length).toBeGreaterThanOrEqual(1);
    for (const frame of settingsChangeFrames) {
      expect(frame.sdParams.request_id).toBe(String(settingsUpdate.res.headers["x-request-id"]));
      expect(frame.jsonPayload.request_id).toBe(String(settingsUpdate.res.headers["x-request-id"]));
      expect(frame.sdParams.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }

    const destCreateFrames = parsedFrames.filter(
      (f) => f.sdParams.request_id === createDestResult.requestId,
    );
    expect(destCreateFrames.length).toBeGreaterThanOrEqual(1);
    expect(destCreateFrames[0]!.sdParams.event).toBe("siem.destination.created");

    const entireWireTranscript = trustedReceiver.frames.map((f) => f.message).join("\n");
    for (const forbiddenSecretOrPii of [
      admin.email,
      "Ada Admin",
      STRONG_PASSWORD,
      NEW_PASSWORD,
      wrongPasswordSecret,
      admin.secret,
      "203.0.113.77",
      "198.51.100.",
      "BEGIN CERTIFICATE",
      "BEGIN PRIVATE KEY",
      "actor_user_id",
      "session_ref",
      "source_address_ref",
      "resource_public_id",
    ]) {
      expect(entireWireTranscript).not.toContain(forbiddenSecretOrPii);
    }

    // Healthy state check while only the trusted destination is active.
    const healthyReport = Browser.ok(
      await admin.browser.query<{ components: ModuleHealth[] }>("siem.admin.health"),
    );
    expect(healthyReport.components[0]?.component).toBe("siem.delivery");
    expect(healthyReport.components[0]?.state).toBe("ok");

    // 8. Untrusted CA destination: authorize loopback port via egress policy, point destination at `untrustedReceiver`
    // while trusting `trustedPki.ca.certPem`, run `siem.deliver` via the real job queue, and verify zero delivery + failing health.
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    Browser.ok(
      await admin.browser.mutate("integrations.admin.egress.create", {
        purpose: "siem",
        matchType: "ip",
        pattern: "127.0.0.1",
        port: untrustedReceiver.port,
        protocol: "tls:",
        allowPrivateAddress: true,
        enabled: true,
        justification: "Authorize untrusted-CA receiver port to verify strict TLS rejection.",
      }),
    );

    const untrustedDest = Browser.ok(
      await admin.browser.mutate<SiemDestinationSummary>("siem.admin.destinations.create", {
        name: "Untrusted CA Collector",
        enabled: true,
        format: "syslog_rfc5425",
        host: "127.0.0.1",
        port: untrustedReceiver.port,
        allowPrivateNetwork: true,
        enterpriseNumber: 54321,
        sdIdName: "rp",
        minSeverity: "INFO",
        categories: ["security", "admin", "system", "integration"],
        secrets: {
          customCaPem: trustedPki.ca.certPem,
        },
      }),
    );

    await sys.container.services.jobs.enqueue("audit.chain.seal", {});
    await sys.drainJobs();
    await sys.container.services.jobs.enqueue("siem.deliver", {
      destinationPublicId: untrustedDest.publicId,
    });
    await sys.drainJobs();

    // Untrusted receiver MUST receive zero application bytes and zero syslog frames.
    expect(untrustedReceiver.frames).toEqual([]);
    expect(untrustedReceiver.rawBytesReceived).toBe(0);

    const inspectedUntrusted = Browser.ok(
      await admin.browser.query<SiemDestinationSummary>("siem.admin.destinations.get", {
        publicId: untrustedDest.publicId,
      }),
    );
    expect(inspectedUntrusted.delivery.deliveredCount).toBe(0);
    expect(inspectedUntrusted.delivery.deadLetterCount).toBeGreaterThanOrEqual(1);
    expect(inspectedUntrusted.delivery.lastFailureReason).toBe("TLS_CERT_UNTRUSTED");

    // Both SIEM module health (`siem.admin.health`) and platform-wide admin health (`platform.admin.health`) surface `failing`.
    const failingSiemHealth = Browser.ok(
      await admin.browser.query<{ components: ModuleHealth[] }>("siem.admin.health"),
    );
    expect(failingSiemHealth.components[0]?.component).toBe("siem.delivery");
    expect(failingSiemHealth.components[0]?.state).toBe("failing");

    const platformHealth = Browser.ok(
      await admin.browser.query<{ state: string; components: ModuleHealth[] }>("platform.admin.health"),
    );
    const siemComponent = platformHealth.components.find((m) => m.component === "siem.delivery");
    expect(siemComponent?.state).toBe("failing");
  });
});
