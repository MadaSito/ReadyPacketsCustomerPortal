import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import tls, { type PeerCertificate, type TLSSocket } from "node:tls";
import { DomainError } from "../../core/errors.js";
import type { ResolvedDestinationSecrets } from "./settings.js";
import { formatCefSyslogFrame, formatJsonlRecord, formatOtlpLogsPayload } from "./formats.js";
import { formatRfc5424Message, frameOctetCounted } from "./rfc5424.js";
import type {
  ExternalAuditEvent,
  IntegrationsEgressPort,
  PinnedEgressTarget,
  SiemFormat,
  SiemReasonCode,
  SiemReceiptConfirmation,
} from "./types.js";

export interface TransportDestinationConfig {
  publicId: string;
  version: number;
  format: SiemFormat;
  host: string;
  port: number;
  otlpPath: string | null;
  allowPrivateNetwork: boolean;
  facility: number;
  appName: string;
  hostnameOverride: string | null;
  enterpriseNumber: number | null;
  sdIdName: string;
  includeBom: boolean;
  maxMessageBytes: number;
  connectTimeoutMs: number;
  writeTimeoutMs: number;
  authHeaderName: string | null;
  deploymentProfile: string;
}

export class SiemTransportError extends Error {
  constructor(
    public readonly reasonCode: SiemReasonCode,
    public readonly retryable: boolean,
    public readonly uncertainAfterWrite = false,
  ) {
    super(`SIEM_TRANSPORT:${reasonCode}`);
    this.name = "SiemTransportError";
  }
}

export function classifySocketError(error: unknown, wroteAnyBytes = false): SiemTransportError {
  if (error instanceof SiemTransportError) return error;
  if (error instanceof DomainError) {
    if (error.reasonCode === "SECRET_UNREADABLE") {
      return new SiemTransportError("SECRET_UNREADABLE", false, false);
    }
    if (error.reasonCode === "EGRESS_DNS_RESOLUTION_FAILED" || error.reasonCode === "DNS_RESOLUTION_FAILED") {
      return new SiemTransportError("DNS_RESOLUTION_FAILED", true, false);
    }
    return new SiemTransportError("EGRESS_BLOCKED", false, false);
  }

  const err = error as { code?: string; message?: string } | undefined;
  const code = String(err?.code ?? "").toUpperCase();
  const msg = String(err?.message ?? "");

  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || /Hostname\/IP does not match/i.test(msg)) {
    return new SiemTransportError("TLS_HOSTNAME_MISMATCH", false, false);
  }
  if (code === "CERT_HAS_EXPIRED" || /certificate has expired/i.test(msg)) {
    return new SiemTransportError("TLS_CERT_EXPIRED", false, false);
  }
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_GET_ISSUER_CERT" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "CERT_UNTRUSTED" ||
    code === "ERR_TLS_INVALID_CONTEXT" ||
    /self[- ]signed|unable to verify|untrusted/i.test(msg)
  ) {
    return new SiemTransportError("TLS_CERT_UNTRUSTED", false, false);
  }
  if (
    /alert certificate required|alert bad certificate|alert unknown ca|certificate unknown|peer did not return a certificate/i.test(
      msg,
    ) ||
    code.includes("SSL_ALERT_CERTIFICATE") ||
    code === "EPROTO" && /certificate/i.test(msg)
  ) {
    return new SiemTransportError("TLS_MTLS_REJECTED", false, false);
  }
  if (code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_") || code === "EPROTO" || /handshake|tlsv1 alert/i.test(msg)) {
    // Notice: if a server sends TLS alert during or right after client auth in TLS 1.3 (post-handshake or late alert),
    // treat certificate/auth alerts as non-retryable mTLS rejection when no payload acceptance happened.
    return new SiemTransportError("TLS_HANDSHAKE_FAILED", false, false);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ESERVFAIL") {
    return new SiemTransportError("DNS_RESOLUTION_FAILED", code === "EAI_AGAIN", false);
  }
  if (code === "ECONNREFUSED") {
    return new SiemTransportError("CONNECTION_REFUSED", true, false);
  }
  if (code === "ECONNRESET" || code === "EPIPE" || code === "EOF") {
    return new SiemTransportError("CONNECTION_RESET", true, wroteAnyBytes);
  }
  if (code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT") {
    return new SiemTransportError("CONNECT_TIMEOUT", true, wroteAnyBytes);
  }
  if (code === "WRITE_TIMEOUT") {
    return new SiemTransportError("WRITE_TIMEOUT", true, true);
  }
  return new SiemTransportError("TRANSPORT_ERROR", true, wroteAnyBytes);
}

/**
 * Built-in fail-closed SSRF / IP classifier used alongside (or before) `services.integrations.egress`.
 * Always blocks cloud metadata, link-local, multicast, unspecified, and private networks unless
 * `allowPrivateNetwork` is explicitly approved on the destination (loopback allowed in test/development only).
 */
export function isBlockedIpAddress(
  ip: string,
  options: { allowPrivateNetwork: boolean; deploymentProfile: string },
): boolean {
  const normalized = ip.trim().toLowerCase();
  const blockList = new net.BlockList();

  // Unconditionally blocked in every environment (cloud metadata, link-local, multicast, broadcast, unspecified, 6to4/Teredo).
  blockList.addAddress("0.0.0.0", "ipv4");
  blockList.addSubnet("0.0.0.0", 8, "ipv4");
  blockList.addSubnet("169.254.0.0", 16, "ipv4"); // AWS/GCP/Azure IMDS 169.254.169.254 + link-local
  blockList.addAddress("100.100.100.200", "ipv4"); // Alibaba metadata
  blockList.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  blockList.addSubnet("240.0.0.0", 4, "ipv4"); // reserved / broadcast
  blockList.addAddress("::", "ipv6");
  blockList.addSubnet("fe80::", 10, "ipv6"); // link-local
  blockList.addSubnet("ff00::", 8, "ipv6"); // multicast
  blockList.addAddress("fd00:ec2::254", "ipv6"); // AWS IPv6 IMDS
  blockList.addSubnet("2002::", 16, "ipv6"); // 6to4
  blockList.addSubnet("2001::", 32, "ipv6"); // Teredo

  // Loopback: allowed ONLY in test/development when `allowPrivateNetwork` is true (for local TLS receiver tests).
  const isDevOrTest = options.deploymentProfile === "test" || options.deploymentProfile === "development";
  if (!(isDevOrTest && options.allowPrivateNetwork)) {
    blockList.addSubnet("127.0.0.0", 8, "ipv4");
    blockList.addAddress("::1", "ipv6");
  }

  // RFC1918 / RFC4193 / CGNAT: blocked unless administrator explicitly approved private network for this SIEM receiver.
  if (!options.allowPrivateNetwork) {
    blockList.addSubnet("10.0.0.0", 8, "ipv4");
    blockList.addSubnet("172.16.0.0", 12, "ipv4");
    blockList.addSubnet("192.168.0.0", 16, "ipv4");
    blockList.addSubnet("100.64.0.0", 10, "ipv4");
    blockList.addSubnet("fc00::", 7, "ipv6");
  }

  const v4MappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(normalized);
  if (v4MappedMatch) {
    return isBlockedIpAddress(v4MappedMatch[1]!, options);
  }

  const family = net.isIP(normalized);
  if (family === 4) return blockList.check(normalized, "ipv4");
  if (family === 6) return blockList.check(normalized, "ipv6");
  return true;
}

function buildTargetUrl(dest: TransportDestinationConfig): { url: string; allowedSchemes: readonly string[] } {
  const bracketHost = dest.host.includes(":") && !dest.host.startsWith("[") ? `[${dest.host}]` : dest.host;
  if (dest.format === "otlp_https") {
    const rawPath = dest.otlpPath && dest.otlpPath.trim().length > 0 ? dest.otlpPath.trim() : "/v1/logs";
    const safePath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return { url: `https://${bracketHost}:${dest.port}${safePath}`, allowedSchemes: ["https:"] };
  }
  return { url: `tls://${bracketHost}:${dest.port}`, allowedSchemes: ["tls:"] };
}

export async function resolvePinnedTarget(
  dest: TransportDestinationConfig,
  egress: IntegrationsEgressPort | undefined,
): Promise<PinnedEgressTarget> {
  const { url, allowedSchemes } = buildTargetUrl(dest);

  if (egress?.resolveAndAssertAllowed) {
    try {
      const pinned = await egress.resolveAndAssertAllowed({
        url,
        allowedSchemes,
        allowApprovedPrivate: dest.allowPrivateNetwork,
        purpose: "siem",
      });
      if (isBlockedIpAddress(pinned.address, dest)) {
        throw new SiemTransportError("EGRESS_BLOCKED", false, false);
      }
      return pinned;
    } catch (err) {
      if (err instanceof SiemTransportError) throw err;
      throw classifySocketError(err, false);
    }
  }

  if (egress?.assertAllowed && !dest.allowPrivateNetwork) {
    try {
      const pinned = await egress.assertAllowed(url, "siem");
      if (isBlockedIpAddress(pinned.address, dest)) {
        throw new SiemTransportError("EGRESS_BLOCKED", false, false);
      }
      return pinned;
    } catch (err) {
      if (err instanceof SiemTransportError) throw err;
      throw classifySocketError(err, false);
    }
  }

  // Fallback single-shot DNS resolution + strict IP policy when integrations module stub is unpopulated in isolated unit tests.
  const parsed = new URL(url);
  if (!allowedSchemes.includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new SiemTransportError("EGRESS_BLOCKED", false, false);
  }
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, "");
  // Reject octal/hex IPv4 tricks (`0177.0.0.1`, `0x7f000001`, pure integer host).
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(bareHost) || /^(?:0\d+\.)/.test(bareHost)) {
    throw new SiemTransportError("EGRESS_BLOCKED", false, false);
  }

  const directIpFamily = net.isIP(bareHost);
  if (directIpFamily === 4 || directIpFamily === 6) {
    if (isBlockedIpAddress(bareHost, dest)) {
      throw new SiemTransportError("EGRESS_BLOCKED", false, false);
    }
    return {
      hostname: bareHost,
      port: dest.port,
      protocol: parsed.protocol,
      address: bareHost,
      family: directIpFamily,
      servername: undefined,
      normalizedUrl: url,
    };
  }

  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(bareHost, { all: true, verbatim: true });
  } catch (err) {
    throw classifySocketError(err, false);
  }
  if (records.length === 0) {
    throw new SiemTransportError("DNS_RESOLUTION_FAILED", false, false);
  }
  // Every resolved A/AAAA record must pass the egress policy so round-robin cannot bypass SSRF checks.
  for (const rec of records) {
    if ((rec.family !== 4 && rec.family !== 6) || isBlockedIpAddress(rec.address, dest)) {
      throw new SiemTransportError("EGRESS_BLOCKED", false, false);
    }
  }
  const chosen = records[0]!;
  return {
    hostname: bareHost,
    port: dest.port,
    protocol: parsed.protocol,
    address: chosen.address,
    family: chosen.family as 4 | 6,
    servername: bareHost,
    normalizedUrl: url,
  };
}

function verifyServerIdentityStrict(expectedHost: string, cert: PeerCertificate): Error | undefined {
  return tls.checkServerIdentity(expectedHost, cert);
}

interface PooledTlsEntry {
  key: string;
  socket: TLSSocket;
  pinned: PinnedEgressTarget;
  healthy: boolean;
  lastError: unknown;
}

/**
 * Reusable RFC 5425 / JSONL-over-TLS connection pool.
 * Enforces TLS >= 1.2, `rejectUnauthorized: true`, hostname/SAN verification, DNS-pinned IP,
 * optional custom CA + mTLS, connect/write timeouts, and backpressure (`drain`) handling.
 */
export class SiemTlsConnectionPool {
  private readonly entries = new Map<string, PooledTlsEntry>();

  evict(publicId: string): void {
    const existing = this.entries.get(publicId);
    if (existing) {
      this.entries.delete(publicId);
      existing.healthy = false;
      existing.socket.destroy();
    }
  }

  async closeAll(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [id, entry] of this.entries.entries()) {
      this.entries.delete(id);
      entry.healthy = false;
      closing.push(
        new Promise<void>((resolve) => {
          if (entry.socket.destroyed) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            entry.socket.destroy();
            resolve();
          }, 1_000);
          timer.unref?.();
          entry.socket.end(() => {
            clearTimeout(timer);
            entry.socket.destroy();
            resolve();
          });
        }),
      );
    }
    await Promise.all(closing);
  }

  private async getOrConnect(
    dest: TransportDestinationConfig,
    secrets: ResolvedDestinationSecrets,
    egress: IntegrationsEgressPort | undefined,
    signal?: AbortSignal,
  ): Promise<PooledTlsEntry> {
    const versionKey = `${dest.publicId}:v${dest.version}`;
    const existing = this.entries.get(dest.publicId);
    if (
      existing &&
      existing.key === versionKey &&
      existing.healthy &&
      !existing.socket.destroyed &&
      existing.socket.writable
    ) {
      return existing;
    }
    if (existing) {
      this.evict(dest.publicId);
    }

    const pinned = await resolvePinnedTarget(dest, egress);
    if (signal?.aborted) {
      throw new SiemTransportError("TRANSPORT_ERROR", true, false);
    }

    const isIpHost = net.isIP(pinned.hostname) !== 0;
    const sniServername = isIpHost ? undefined : (pinned.servername ?? pinned.hostname);

    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      let settled = false;
      const tlsOpts: tls.ConnectionOptions = {
        host: pinned.address,
        port: pinned.port,
        lookup: (_hostname, opts, cb) => {
          if (opts && typeof opts === "object" && "all" in opts && opts.all) {
            cb(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
        minVersion: "TLSv1.2",
        // Non-negotiable: NEVER allow plaintext or unverified TLS certificates.
        rejectUnauthorized: true,
        servername: sniServername,
        checkServerIdentity: (_host, cert) => verifyServerIdentityStrict(pinned.hostname, cert),
        ca: secrets.customCaPem ?? undefined,
        cert: secrets.clientCertPem ?? undefined,
        key: secrets.clientKeyPem ?? undefined,
      };

      const sock = tls.connect(tlsOpts);
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutErr = Object.assign(new Error("SIEM TLS connect timeout"), { code: "CONNECT_TIMEOUT" });
        sock.destroy(timeoutErr);
        reject(classifySocketError(timeoutErr, false));
      }, dest.connectTimeoutMs);
      connectTimer.unref?.();

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        sock.destroy();
        reject(new SiemTransportError("TRANSPORT_ERROR", true, false));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      sock.once("secureConnect", () => {
        if (settled) return;
        clearTimeout(connectTimer);
        signal?.removeEventListener("abort", onAbort);
        if (!sock.authorized) {
          settled = true;
          const authErr = sock.authorizationError ?? new Error("TLS peer not authorized");
          sock.destroy();
          reject(classifySocketError(authErr, false));
          return;
        }
        settled = true;
        resolve(sock);
      });

      sock.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        signal?.removeEventListener("abort", onAbort);
        sock.destroy();
        reject(classifySocketError(err, false));
      });

      sock.once("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        signal?.removeEventListener("abort", onAbort);
        reject(new SiemTransportError("CONNECTION_RESET", true, false));
      });
    });

    const entry: PooledTlsEntry = {
      key: versionKey,
      socket,
      pinned,
      healthy: true,
      lastError: null,
    };

    // Attach permanent listeners so idle pool disconnects or asynchronous TLS 1.3 alerts never go unhandled.
    socket.on("error", (err) => {
      entry.healthy = false;
      entry.lastError = err;
      if (this.entries.get(dest.publicId) === entry) {
        this.entries.delete(dest.publicId);
      }
    });
    socket.on("close", () => {
      entry.healthy = false;
      if (this.entries.get(dest.publicId) === entry) {
        this.entries.delete(dest.publicId);
      }
    });
    socket.on("end", () => {
      entry.healthy = false;
      if (this.entries.get(dest.publicId) === entry) {
        this.entries.delete(dest.publicId);
      }
    });

    this.entries.set(dest.publicId, entry);
    return entry;
  }

  async writeFrames(
    dest: TransportDestinationConfig,
    secrets: ResolvedDestinationSecrets,
    frames: readonly Buffer[],
    egress: IntegrationsEgressPort | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (frames.length === 0) return;

    // Attempt once on an existing pooled socket; if the idle pooled socket was just closed by the peer
    // before any bytes were written, reconnect cleanly once.
    const hadPooled = this.entries.has(dest.publicId);
    try {
      await this.writeFramesOnce(dest, secrets, frames, egress, signal);
    } catch (err) {
      if (hadPooled && err instanceof SiemTransportError && !err.uncertainAfterWrite && err.retryable) {
        this.evict(dest.publicId);
        await this.writeFramesOnce(dest, secrets, frames, egress, signal);
        return;
      }
      throw err;
    }
  }

  private async writeFramesOnce(
    dest: TransportDestinationConfig,
    secrets: ResolvedDestinationSecrets,
    frames: readonly Buffer[],
    egress: IntegrationsEgressPort | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = await this.getOrConnect(dest, secrets, egress, signal);
    const { socket } = entry;
    let wroteAny = false;

    try {
      for (const frame of frames) {
        if (signal?.aborted) {
          throw new SiemTransportError("TRANSPORT_ERROR", true, wroteAny);
        }
        await writeSingleBufferWithTimeout(socket, frame, dest.writeTimeoutMs, () => {
          wroteAny = true;
        });
      }
      // In TLS 1.3, mTLS client-certificate rejection by the server often arrives as a post-handshake alert
      // immediately after the client's first flight of application data. Give the event loop a brief tick
      // (and check socket state) so an immediate fatal TLS alert from the peer is never misreported as delivered!
      await verifySocketAliveAfterFlush(socket, () => entry.lastError);
    } catch (err) {
      entry.healthy = false;
      this.evict(dest.publicId);
      throw classifySocketError(err, wroteAny);
    }
  }
}

function writeSingleBufferWithTimeout(
  socket: TLSSocket,
  chunk: Buffer,
  timeoutMs: number,
  markWrote: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed || !socket.writable) {
      reject(new SiemTransportError("CONNECTION_RESET", true, false));
      return;
    }

    let settled = false;
    let waitingDrain = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("drain", onDrain);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = Object.assign(new Error("SIEM TLS write timeout"), { code: "WRITE_TIMEOUT" });
      socket.destroy(err);
      reject(new SiemTransportError("WRITE_TIMEOUT", true, true));
    }, timeoutMs);
    timer.unref?.();

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error("SIEM TLS socket closed during write"), { code: "ECONNRESET" }));
    };

    const onDrain = () => {
      if (!waitingDrain || settled) return;
      waitingDrain = false;
      settled = true;
      cleanup();
      resolve();
    };

    socket.once("error", onError);
    socket.once("close", onClose);

    markWrote();
    const flushedImmediately = socket.write(chunk, (writeErr) => {
      if (writeErr) {
        onError(writeErr);
        return;
      }
      if (!waitingDrain && !settled) {
        settled = true;
        cleanup();
        resolve();
      }
    });

    if (!flushedImmediately && !settled) {
      waitingDrain = true;
      socket.once("drain", onDrain);
    }
  });
}

function verifySocketAliveAfterFlush(socket: TLSSocket, getLastError: () => unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const priorErr = getLastError();
    if (priorErr) {
      reject(priorErr);
      return;
    }
    if (socket.destroyed || !socket.writable) {
      reject(Object.assign(new Error("SIEM TLS socket closed immediately after write"), { code: "ECONNRESET" }));
      return;
    }

    let settled = false;
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onClose = (hadError: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = getLastError();
      if (err) {
        reject(err);
      } else if (hadError) {
        reject(Object.assign(new Error("SIEM TLS socket closed with error"), { code: "ECONNRESET" }));
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = getLastError();
      if (err) reject(err);
      else resolve();
    }, 15);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function deliverOtlpHttpsBatch(
  dest: TransportDestinationConfig,
  secrets: ResolvedDestinationSecrets,
  events: readonly ExternalAuditEvent[],
  egress: IntegrationsEgressPort | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const pinned = await resolvePinnedTarget(dest, egress);
  const body = formatOtlpLogsPayload(events);
  const rawPath = dest.otlpPath && dest.otlpPath.trim().length > 0 ? dest.otlpPath.trim() : "/v1/logs";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const isIpHost = net.isIP(pinned.hostname) !== 0;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    "user-agent": "ReadyPackets-SIEM/1.0",
  };
  if (secrets.authSecret) {
    const headerName = dest.authHeaderName && /^[A-Za-z0-9-]{1,64}$/.test(dest.authHeaderName)
      ? dest.authHeaderName
      : "Authorization";
    const lower = headerName.toLowerCase();
    if (lower !== "host" && lower !== "content-length" && lower !== "content-type" && lower !== "transfer-encoding") {
      headers[headerName] = secrets.authSecret;
    }
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let wroteBody = false;

    const req = https.request(
      {
        protocol: "https:",
        hostname: pinned.hostname,
        port: pinned.port,
        path,
        method: "POST",
        headers,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        servername: isIpHost ? undefined : (pinned.servername ?? pinned.hostname),
        checkServerIdentity: (_host, cert) => verifyServerIdentityStrict(pinned.hostname, cert),
        ca: secrets.customCaPem ?? undefined,
        cert: secrets.clientCertPem ?? undefined,
        key: secrets.clientKeyPem ?? undefined,
        agent: false,
        lookup: (_hostname, opts, cb) => {
          if (opts && typeof opts === "object" && "all" in opts && opts.all) {
            cb(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (total < 16_384) {
            chunks.push(chunk);
            total += chunk.byteLength;
          }
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(totalTimer);
          // Refuse all HTTP redirects (SSRF protection).
          if (status >= 300 && status < 400) {
            reject(new SiemTransportError("PROTOCOL_REJECTED", false, false));
            return;
          }
          if (status >= 200 && status < 300) {
            if (chunks.length > 0) {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                  partialSuccess?: { rejectedLogRecords?: string | number };
                };
                const rejected = Number(parsed?.partialSuccess?.rejectedLogRecords ?? 0);
                if (Number.isFinite(rejected) && rejected > 0) {
                  reject(new SiemTransportError("PROTOCOL_REJECTED", false, true));
                  return;
                }
              } catch {
                // Empty or non-JSON 2xx acknowledgement is valid for OTLP collectors.
              }
            }
            resolve();
            return;
          }
          if (status === 401 || status === 403) {
            reject(new SiemTransportError("HTTP_AUTH_FAILED", false, false));
            return;
          }
          if (status === 429) {
            reject(new SiemTransportError("HTTP_RATE_LIMITED", true, false));
            return;
          }
          if (status >= 500) {
            reject(new SiemTransportError("HTTP_SERVER_ERROR", true, false));
            return;
          }
          reject(new SiemTransportError("HTTP_CLIENT_ERROR", false, false));
        });
      },
    );

    const totalTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new SiemTransportError(wroteBody ? "WRITE_TIMEOUT" : "CONNECT_TIMEOUT", true, wroteBody));
    }, dest.connectTimeoutMs + dest.writeTimeoutMs);
    totalTimer.unref?.();

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(totalTimer);
          req.destroy();
          reject(new SiemTransportError("TRANSPORT_ERROR", true, wroteBody));
        },
        { once: true },
      );
    }

    req.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      reject(classifySocketError(err, wroteBody));
    });

    req.end(body, () => {
      wroteBody = true;
    });
  });
}

export async function deliverProjectedBatch(params: {
  pool: SiemTlsConnectionPool;
  dest: TransportDestinationConfig;
  secrets: ResolvedDestinationSecrets;
  events: readonly ExternalAuditEvent[];
  egress: IntegrationsEgressPort | undefined;
  signal?: AbortSignal;
}): Promise<{ receiptConfirmation: SiemReceiptConfirmation }> {
  const { pool, dest, secrets, events, egress, signal } = params;
  if (events.length === 0) return { receiptConfirmation: "none" };

  if (dest.format === "otlp_https") {
    await deliverOtlpHttpsBatch(dest, secrets, events, egress, signal);
    return { receiptConfirmation: "collector_2xx" };
  }

  const frames: Buffer[] = events.map((event) => {
    if (dest.format === "jsonl_tls") {
      return formatJsonlRecord(event, dest.maxMessageBytes);
    }
    if (dest.format === "cef_tls") {
      return formatCefSyslogFrame(event, {
        facility: dest.facility,
        hostname: dest.hostnameOverride,
        appName: dest.appName,
        maxMessageBytes: dest.maxMessageBytes,
      }).frameBytes;
    }
    const formatted = formatRfc5424Message(event, {
      facility: dest.facility,
      hostname: dest.hostnameOverride,
      appName: dest.appName,
      enterpriseNumber: dest.enterpriseNumber,
      sdIdName: dest.sdIdName,
      includeBom: dest.includeBom,
      maxMessageBytes: dest.maxMessageBytes,
    });
    return frameOctetCounted(formatted.bytes);
  });

  await pool.writeFrames(dest, secrets, frames, egress, signal);
  return { receiptConfirmation: "transport_accepted" };
}
