import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../../../core/types.js";
import type { EgressPolicy } from "../../integrations/egress.js";
import { StorageAdapterError, type StorageAdapterDefinition } from "../contracts.js";
import {
  fromStatus, MAX_OBJECT_BYTES, measuredBody, objectKey, observedSize, pathFor, prefixParts, prefixSchema, removeKey,
  statusError, testError, transportError, WRITE_TIMEOUT_MS,
} from "./objectProtocol.js";

export const azureBlobConfig = z.strictObject({
  account: z.string().regex(/^[a-z0-9]{3,24}$/u),
  container: z.string().regex(/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u),
  prefix: prefixSchema.optional(),
  auth: z.enum(["shared_key", "sas"]),
});
const accountKey = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u).refine((value) =>
  Buffer.from(value, "base64").toString("base64") === value);
const sasFields = new Set(["sv", "sr", "sp", "se", "st", "spr", "sip", "sig", "si", "skoid", "sktid", "skt",
  "ske", "sks", "skv", "ses", "saoid", "suoid", "scid"]);
const sasToken = z.string().max(8192).regex(/^\??[A-Za-z0-9._%+=~&-]+$/u).refine((value) => {
  if (/%(?![a-f0-9]{2})/iu.test(value) || value.includes("+")) return false;
  const fields = new URLSearchParams(value);
  const keys = [...fields.keys()];
  return keys.length === new Set(keys).size && keys.every((key) => sasFields.has(key)) &&
    [...fields.values()].every((field) => field !== "" && !/\p{C}/u.test(field)) &&
    fields.get("sr") === "c" && fields.get("spr") === "https" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(fields.get("sv") ?? "") && /^[A-Za-z0-9+/]{43}=$/u.test(fields.get("sig") ?? "") &&
    (fields.has("si") || (fields.has("se") && /^r[acwdxl]*$/u.test(fields.get("sp") ?? "") && /[cw]/u.test(fields.get("sp") ?? "")));
});
export const azureBlobCredentials = z.union([
  z.strictObject({ accountKey }),
  z.strictObject({ sasToken }),
]);
type Config = z.output<typeof azureBlobConfig>;
type Credentials = z.output<typeof azureBlobCredentials>;
type Method = "HEAD" | "PUT" | "DELETE";
const storageVersion = "2023-11-03";
const maxAzureBytes = 5000 * 1024 ** 2;

export function azureSharedKeyAuthorization(input: {
  method: string; url: URL; account: string; key: string; headers: Record<string, string>;
}): string {
  const h = input.headers;
  const lines = ["content-encoding", "content-language", "content-length", "content-md5", "content-type", "date",
    "if-modified-since", "if-match", "if-none-match", "if-unmodified-since", "range"]
    .map((name) => (name === "content-length" && h[name] === "0") ? "" : h[name] ?? "");
  const msHeaders = Object.keys(h).filter((name) => name.startsWith("x-ms-")).sort()
    .map((name) => `${name}:${h[name]!.trim().replace(/[ \t]+/gu, " ")}\n`).join("");
  const query = new Map<string, string[]>();
  for (const [name, value] of input.url.searchParams) {
    const lower = name.toLowerCase();
    query.set(lower, [...(query.get(lower) ?? []), value]);
  }
  const resource = `/${input.account}${input.url.pathname}` +
    [...query.keys()].sort().map((name) => `\n${name}:${query.get(name)!.sort().join(",")}`).join("");
  const toSign = [input.method, ...lines, msHeaders + resource].join("\n");
  return `SharedKey ${input.account}:${createHmac("sha256", Buffer.from(input.key, "base64")).update(toSign, "utf8").digest("base64")}`;
}

export function azureBlobAdapter(egress: () => Pick<EgressPolicy, "fetchPinned">, clock: Clock): StorageAdapterDefinition<Config, Credentials> {
  return {
    configSchema: azureBlobConfig, credentialsSchema: azureBlobCredentials, purposes: ["order_files", "backups"],
    create({ config, credentials }) {
      const origin = `https://${config.account}.blob.core.windows.net`;
      const prefix = prefixParts(config.prefix);
      const urlFor = (parts: readonly string[]) => new URL(pathFor([config.container, ...parts]), origin);
      const authMatches = config.auth === "shared_key" ? "accountKey" in credentials : "sasToken" in credentials;
      async function request(method: Method, target: URL, options: {
        headers?: Record<string, string>; body?: ReturnType<typeof measuredBody>["body"]; signal?: AbortSignal;
      } = {}) {
        if (!authMatches) throw new StorageAdapterError("NOT_CONFIGURED");
        const headers: Record<string, string> = { "x-ms-date": clock.now().toUTCString(), "x-ms-version": storageVersion,
          ...options.headers };
        const url = new URL(target);
        if ("accountKey" in credentials) {
          headers.authorization = azureSharedKeyAuthorization({ method, url, account: config.account, key: credentials.accountKey, headers });
        } else {
          url.search += `${url.search ? "&" : "?"}${credentials.sasToken.replace(/^\?/u, "")}`;
        }
        try {
          return await egress().fetchPinned(url, "storage_azure", {
            method, headers, body: options.body, signal: options.signal,
            maxResponseBytes: 16 * 1024, requireAllowlistRule: true, publicAddressesOnly: true,
            ...(options.body ? { contentLength: Number(headers["content-length"]), maxRequestBytes: MAX_OBJECT_BYTES,
              timeoutMs: WRITE_TIMEOUT_MS } : { timeoutMs: 10_000 }),
          });
        } catch (error) {
          throw transportError(error, method !== "HEAD");
        }
      }
      return {
        async test(signal) {
          const target = urlFor([]);
          target.searchParams.set("restype", "container");
          try {
            return fromStatus((await request("HEAD", target, { signal })).status);
          } catch (error) { return testError(error); }
        },
        async ensureFolder() { /* Blob names provide virtual folders; no directory creation. */ },
        async put(input) {
          if (input.size > maxAzureBytes) throw new StorageAdapterError("TOO_LARGE");
          const key = objectKey(prefix, input);
          const url = urlFor(key.split("/"));
          await input.beforeWrite?.();
          const stream = measuredBody(input, true);
          let md5: string | undefined;
          let put;
          try {
            put = await request("PUT", url, { signal: input.signal, body: stream.body, headers: {
              "content-type": input.contentType, "content-length": String(input.size), "if-none-match": "*",
              "x-ms-blob-type": "BlockBlob",
            } });
            if (put.status !== 201) throw statusError(put.status, true);
            md5 = stream.verify().md5;
          } finally { stream.body.destroy(); }
          const uploaded = await request("HEAD", url, { signal: input.signal,
            ...(put.headers.etag ? { headers: { "if-match": put.headers.etag } } : {}) })
            .catch(() => { throw new StorageAdapterError("OUTCOME_UNKNOWN"); });
          if (uploaded.status === 412 || (put.headers.etag && uploaded.status === 200 && put.headers.etag !== uploaded.headers.etag)) {
            throw new StorageAdapterError("INTEGRITY_MISMATCH");
          }
          if (uploaded.status !== 200) throw new StorageAdapterError("OUTCOME_UNKNOWN");
          const providerMd5 = uploaded.headers["content-md5"] ?? put.headers["content-md5"];
          if (providerMd5 !== undefined && md5 !== providerMd5) throw new StorageAdapterError("INTEGRITY_MISMATCH");
          return { remoteId: key, size: observedSize(uploaded.headers),
            ...(providerMd5 === undefined ? {} : { verifiedTransportDigest: "md5" }) };
        },
        async remove(remoteId, signal) {
          const result = await request("DELETE", urlFor(removeKey(prefix, remoteId)), { signal });
          if (result.status !== 202 && result.status !== 404) throw statusError(result.status, true);
        },
      };
    },
  };
}
