import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError, validation } from "../../../core/errors.js";
import type { EgressFetchResponse } from "../../integrations/egress.js";
import { StorageAdapterError, type StoragePutInput, type StorageTestResult } from "../contracts.js";
import { refreshAccess, type OAuthApp, type StorageOAuthProvider, type StorageRequest } from "./provider.js";

export const oauthConfigSchema = z.strictObject({
  clientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
  rootPath: z.string().max(512).refine((value) => value === "" || value.split("/").every(validSegment)).optional(),
});
export const oauthCredentialsSchema = z.strictObject({
  clientSecret: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/),
  refreshToken: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/).optional(),
});
export type OAuthStorageConfig = z.infer<typeof oauthConfigSchema>;
export type OAuthStorageCredentials = z.infer<typeof oauthCredentialsSchema>;

function validSegment(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value) <= 255 && value !== "." && value !== ".." &&
    value === value.trim() && !/[/\\\p{Cc}\p{Cf}]/u.test(value);
}

export function pathParts(config: OAuthStorageConfig, path: readonly string[]): string[] {
  const out = [...(config.rootPath ? config.rootPath.split("/") : []), ...path];
  if (out.length > 24 || !out.every(validSegment)) throw validation("STORAGE_PATH_INVALID", "The storage destination path is invalid.");
  return out;
}

export function safeObjectName(name: string): string {
  if (!validSegment(name)) throw validation("STORAGE_PATH_INVALID", "The storage destination path is invalid.");
  return name;
}

export function dataError(status?: number): StorageAdapterError {
  if (status === 401 || status === 403) return new StorageAdapterError("DESTINATION_DENIED");
  if (status === 404) return new StorageAdapterError("DESTINATION_NOT_FOUND");
  if (status === 409) return new StorageAdapterError("DESTINATION_CONFLICT");
  if (status === 413) return new StorageAdapterError("TOO_LARGE");
  if (status === 429) return new StorageAdapterError("RATE_LIMITED", true);
  return new StorageAdapterError("PROVIDER_UNAVAILABLE");
}

export function integrityError(): StorageAdapterError {
  return new StorageAdapterError("INTEGRITY_MISMATCH");
}

export function testResult(error: unknown): StorageTestResult {
  if (error instanceof StorageAdapterError) {
    switch (error.code) {
      case "NOT_CONFIGURED": case "AUTH_FAILED": case "DESTINATION_NOT_FOUND": case "DESTINATION_DENIED":
      case "EGRESS_DENIED": case "RATE_LIMITED": return { ok: false, code: error.code };
      default: return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }
  }
  if (!(error instanceof DomainError)) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  if (error.reasonCode === "STORAGE_OAUTH_APP_REQUIRED") return { ok: false, code: "NOT_CONFIGURED" };
  if (error.reasonCode === "STORAGE_OAUTH_AUTHORIZATION_REJECTED") return { ok: false, code: "AUTH_FAILED" };
  if (error.reasonCode === "STORAGE_DESTINATION_DENIED") return { ok: false, code: "DESTINATION_DENIED" };
  if (error.reasonCode === "STORAGE_PROVIDER_RATE_LIMITED") return { ok: false, code: "RATE_LIMITED" };
  if (error.reasonCode === "STORAGE_DESTINATION_NOT_FOUND") return { ok: false, code: "DESTINATION_NOT_FOUND" };
  return { ok: false, code: error.reasonCode.startsWith("EGRESS_") ? "EGRESS_DENIED" : "PROVIDER_UNAVAILABLE" };
}

export function dataRequest(request: StorageRequest, ambiguous: boolean, retrySafe: boolean): StorageRequest {
  return async (url, options) => {
    const fence = options?.beforeSend;
    let fenceFailure: { cause: unknown } | undefined;
    try {
      const resp = await request(url, fence ? { ...options, beforeSend: async () => {
        try { await fence(); } catch (cause) {
          fenceFailure = { cause };
          throw cause;
        }
      } } : options);
      if (resp.status >= 500) throw new StorageAdapterError(ambiguous ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE", retrySafe);
      return resp;
    } catch (error) {
      // A lost local write fence is not a request failure or an ambiguous external effect.
      if (fenceFailure) throw fenceFailure.cause;
      if (error instanceof StorageAdapterError) throw error;
      const hint = testResult(error);
      if (!hint.ok && hint.code !== "PROVIDER_UNAVAILABLE" && hint.code !== "OK") throw new StorageAdapterError(hint.code);
      throw new StorageAdapterError(ambiguous ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE", retrySafe);
    }
  };
}

export function parseResponse<T>(response: EgressFetchResponse, schema: z.ZodType<T>, statuses = [200]): T {
  if (!statuses.includes(response.status)) throw dataError(response.status);
  let input: unknown;
  try { input = JSON.parse(response.body.toString("utf8")); } catch { throw dataError(); }
  const result = schema.safeParse(input);
  if (!result.success) throw dataError();
  return result.data;
}

export function accessFor(request: StorageRequest, provider: StorageOAuthProvider, app: OAuthApp, refreshToken?: string) {
  let cached: { accessToken: string; freshUntil: number } | undefined;
  return async (signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    if (!refreshToken) throw validation("STORAGE_OAUTH_APP_REQUIRED", "Connect the storage account first.");
    if (cached && cached.freshUntil > Date.now()) return cached.accessToken;
    const grant = await refreshAccess(dataRequest(request, false, true), provider, app, refreshToken, signal).catch((error: unknown) => {
      if (error instanceof DomainError) {
        const hint = testResult(error);
        if (!hint.ok && hint.code !== "OK") throw new StorageAdapterError(hint.code);
      }
      throw error;
    });
    cached = { accessToken: grant.accessToken, freshUntil: Date.now() + Math.max(0, grant.expiresIn - 60) * 1000 };
    return cached.accessToken;
  };
}

/** Reads bounded byte chunks and withholds the final chunk until source length and digest are verified. */
export async function* verifiedChunks(input: StoragePutInput, limit: number): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(input.size) || input.size < 0 || !/^[a-f0-9]{64}$/.test(input.sha256)) throw integrityError();
  let remaining = input.size;
  let offset = 0;
  let chunk = Buffer.allocUnsafe(Math.min(limit, remaining));
  const hash = createHash("sha256");
  for await (const data of input.body) {
    input.signal?.throwIfAborted();
    if (!(data instanceof Uint8Array) || data.byteLength > remaining) throw integrityError();
    hash.update(data);
    remaining -= data.byteLength;
    let start = 0;
    while (start < data.byteLength) {
      const count = Math.min(chunk.length - offset, data.byteLength - start);
      chunk.set(data.subarray(start, start + count), offset);
      offset += count;
      start += count;
      if (offset === chunk.length && remaining + data.byteLength - start > 0) {
        yield chunk;
        input.signal?.throwIfAborted();
        chunk = Buffer.allocUnsafe(Math.min(limit, remaining + data.byteLength - start));
        offset = 0;
      }
    }
  }
  input.signal?.throwIfAborted();
  if (remaining !== 0 || hash.digest("hex") !== input.sha256) throw integrityError();
  yield chunk;
}
