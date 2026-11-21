import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../../../core/types.js";
import type { EgressPolicy } from "../../integrations/egress.js";
import { StorageAdapterError, type StorageAdapterDefinition } from "../contracts.js";
import {
  encodeSegment, fromStatus, MAX_OBJECT_BYTES, measuredBody, objectKey, objectRequest, observedEtag, observedSize, pathFor,
  prefixParts, prefixSchema, removeKey, statusError, testError, WRITE_TIMEOUT_MS,
} from "./objectProtocol.js";

const endpointSchema = z.string().max(300).transform((value, ctx) => {
  // No path, query, fragment, userinfo, encoded authority, IP literal, or non-canonical explicit port.
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?\/?$/iu.exec(value);
  try {
    const url = new URL(value);
    if (match && match[1]?.toLowerCase() === url.hostname && url.hostname.includes(".") &&
        !/^\d+(?:\.\d+){3}$/u.test(url.hostname) && (!match[2] || match[2] === "443")) return url.origin;
  } catch { /* Report a fixed validation issue below. */ }
  ctx.addIssue({ code: "custom", message: "Use an HTTPS hostname without credentials, paths or query parameters." });
  return z.NEVER;
});

export const s3Config = z.strictObject({
  preset: z.enum(["aws", "wasabi", "backblaze", "custom"]),
  bucket: z.string().regex(/^(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
  region: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u),
  prefix: prefixSchema.optional(),
  endpoint: endpointSchema.optional(),
}).refine(({ preset, region, endpoint }) => preset === "custom" ? Boolean(endpoint) :
  !endpoint && /^[a-z]{2}(?:-[a-z0-9]+){1,4}-[0-9]{1,4}$/u.test(region));

export const s3Credentials = z.strictObject({
  accessKeyId: z.string().regex(/^[A-Za-z0-9_+.-]{3,128}$/u),
  secretAccessKey: z.string().regex(/^[\x21-\x7e]{8,256}$/u),
  sessionToken: z.string().regex(/^[\x21-\x7e]{1,8192}$/u).optional(),
});
type Config = z.output<typeof s3Config>;
type Credentials = z.output<typeof s3Credentials>;
type Method = "HEAD" | "PUT" | "DELETE";
const emptyDigest = createHash("sha256").digest("hex");
const utf8Digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value, "utf8").digest();
const awsDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
const bodyChecksum = (value: string) => Buffer.from(value, "hex").toString("base64");

export function s3Origin(config: Config): string {
  if (config.preset === "custom") return config.endpoint!;
  if (config.preset === "aws") return `https://s3.${config.region}.amazonaws.com${config.region.startsWith("cn-") ? ".cn" : ""}`;
  if (config.preset === "backblaze") return `https://s3.${config.region}.backblazeb2.com`;
  return `https://s3.${config.region}.wasabisys.com`;
}

// Header signing, with exact encoded S3 path and query, not URL re-encoding or normalizing object keys.
export function signS3(input: {
  method: string; url: URL; region: string; credentials: Credentials; date: Date; payloadHash: string; headers?: Record<string, string>;
}): Record<string, string> {
  const stamp = awsDate(input.date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers, host: input.url.host, "x-amz-date": stamp, "x-amz-content-sha256": input.payloadHash,
    ...(input.credentials.sessionToken ? { "x-amz-security-token": input.credentials.sessionToken } : {}),
  };
  const keys = Object.keys(headers).sort();
  const canonicalHeaders = keys.map((key) => `${key}:${headers[key]!.trim().replace(/[ \t]+/gu, " ")}\n`).join("");
  const query = Array.from(input.url.searchParams, ([key, value]) => `${encodeSegment(key)}=${encodeSegment(value)}`).sort().join("&");
  const canonical = [input.method, input.url.pathname, query, canonicalHeaders, keys.join(";"), input.payloadHash].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${utf8Digest(canonical)}`;
  const signing = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${keys.join(";")}, Signature=${hmac(signing, toSign).toString("hex")}`;
  return headers;
}

function checksum(headers: Record<string, string>): string | undefined {
  const value = headers["x-amz-checksum-sha256"];
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value) || headers["x-amz-checksum-type"] === "COMPOSITE") {
    throw new StorageAdapterError("INTEGRITY_MISMATCH");
  }
  return Buffer.from(value, "base64").toString("hex");
}

export function s3Adapter(egress: () => Pick<EgressPolicy, "fetchPinned">, clock: Clock): StorageAdapterDefinition<Config, Credentials> {
  return {
    configSchema: s3Config, credentialsSchema: s3Credentials, purposes: ["order_files", "backups"],
    create({ config, credentials }) {
      const origin = s3Origin(config);
      const prefix = prefixParts(config.prefix);
      const nativeChecksum = config.preset === "aws";
      const urlFor = (parts: readonly string[]) => new URL(pathFor([config.bucket, ...parts]), origin);
      async function request(method: Method, url: URL, options: {
        headers?: Record<string, string>; sha256?: string; body?: ReturnType<typeof measuredBody>["body"]; signal?: AbortSignal;
        beforeWrite?: () => Promise<void>;
      } = {}) {
        const headers = signS3({ method, url, region: config.region, credentials, date: clock.now(),
          payloadHash: options.sha256 ?? emptyDigest, headers: options.headers });
        // The pinned transport writes Host itself. Sign exactly the host used by the connection.
        delete headers.host;
        return objectRequest((beforeSend) => egress().fetchPinned(url, "storage_s3", {
          method, headers, body: options.body, signal: options.signal, beforeSend,
          maxResponseBytes: 16 * 1024, requireAllowlistRule: true, publicAddressesOnly: true,
          ...(options.body ? { contentLength: Number(headers["content-length"]), maxRequestBytes: MAX_OBJECT_BYTES,
            timeoutMs: WRITE_TIMEOUT_MS } : { timeoutMs: 10_000 }),
        }), method !== "HEAD", options.beforeWrite);
      }
      return {
        async test(signal) {
          try {
            return fromStatus((await request("HEAD", urlFor([]), { signal })).status);
          } catch (error) { return testError(error); }
        },
        async ensureFolder() { /* S3 object keys provide virtual folders. */ },
        async put(input) {
          const key = objectKey(prefix, input);
          const url = urlFor(key.split("/"));
          const head = (etag?: string) => request("HEAD", url, { signal: input.signal, headers: {
            ...(nativeChecksum ? { "x-amz-checksum-mode": "ENABLED" } : {}),
            ...(etag ? { "if-match": etag } : {}),
          } });
          const existing = await head();
          if (existing.status === 200) {
            if (observedSize(existing.headers) === input.size && checksum(existing.headers) === input.sha256) {
              return { remoteId: key, size: input.size, sha256: input.sha256 };
            }
            throw new StorageAdapterError("DESTINATION_CONFLICT");
          }
          if (existing.status !== 404) throw statusError(existing.status);
          const stream = measuredBody(input);
          let put;
          try {
            put = await request("PUT", url, { signal: input.signal, body: stream.body, sha256: input.sha256,
              beforeWrite: input.beforeWrite, headers: {
              "content-type": input.contentType, "content-length": String(input.size), "if-none-match": "*",
              ...(nativeChecksum ? { "x-amz-checksum-sha256": bodyChecksum(input.sha256) } : {}),
            } });
            if (put.status !== 200) throw statusError(put.status, true);
            stream.verify();
          } finally { stream.body.destroy(); }
          const etag = observedEtag(put.headers);
          const uploaded = await head(etag).catch(() => { throw new StorageAdapterError("OUTCOME_UNKNOWN"); });
          if (uploaded.status === 412) throw new StorageAdapterError("INTEGRITY_MISMATCH");
          if (uploaded.status !== 200) throw new StorageAdapterError("OUTCOME_UNKNOWN");
          if (observedEtag(uploaded.headers) !== etag) throw new StorageAdapterError("INTEGRITY_MISMATCH");
          const size = observedSize(uploaded.headers);
          const sha256 = checksum(uploaded.headers) ?? checksum(put.headers);
          if (nativeChecksum && !sha256) throw new StorageAdapterError("INTEGRITY_MISMATCH");
          return { remoteId: key, size, ...(sha256 === undefined ? {} : { sha256 }) };
        },
        async remove(remoteId, signal) {
          const result = await request("DELETE", urlFor(removeKey(prefix, remoteId)), { signal });
          if (result.status !== 204 && result.status !== 404) throw statusError(result.status, true);
        },
      };
    },
  };
}
