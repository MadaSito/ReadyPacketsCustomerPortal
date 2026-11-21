import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { DomainError } from "../../../core/errors.js";
import { StorageAdapterError, type StoragePutInput, type StorageTestResult } from "../contracts.js";
import { copyMetadata, copySegment } from "../validation.js";

const allowedParts = z.array(copySegment).min(1).max(16);
export const prefixSchema = z.string().max(512).refine((value) => value === "" ||
  (Buffer.byteLength(value) <= 512 && allowedParts.safeParse(value.split("/")).success));
export const MAX_OBJECT_BYTES = 5 * 1024 ** 3;
export const WRITE_TIMEOUT_MS = 10 * 60_000;
export const encodeSegment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/gu,
  (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export const prefixParts = (prefix?: string) => prefix ? prefix.split("/") : [];
export const pathFor = (parts: readonly string[]) => `/${parts.map(encodeSegment).join("/")}`;

export function objectKey(prefix: readonly string[], input: StoragePutInput): string {
  if (!copyMetadata.safeParse(input).success) throw new StorageAdapterError("INVALID_INPUT");
  if (input.size > MAX_OBJECT_BYTES) throw new StorageAdapterError("TOO_LARGE");
  const key = [...prefix, ...input.path, input.name].join("/");
  if (Buffer.byteLength(key) > 1024) throw new StorageAdapterError("INVALID_INPUT");
  return key;
}

export function removeKey(prefix: readonly string[], key: string): string[] {
  const parts = key.split("/");
  if (Buffer.byteLength(key) > 1024 || !parts.every((segment) => copySegment.safeParse(segment).success) ||
      parts.length <= prefix.length || prefix.some((part, index) => parts[index] !== part)) {
    throw new StorageAdapterError("INVALID_INPUT");
  }
  return parts;
}

export function fromStatus(status: number): StorageTestResult {
  if (status >= 200 && status < 300) return { ok: true, code: "OK" };
  if (status === 401) return { ok: false, code: "AUTH_FAILED" };
  if (status === 403) return { ok: false, code: "DESTINATION_DENIED" };
  if (status === 404) return { ok: false, code: "DESTINATION_NOT_FOUND" };
  if (status === 429) return { ok: false, code: "RATE_LIMITED" };
  return { ok: false, code: "PROVIDER_UNAVAILABLE" };
}

export function statusError(status: number, write = false): StorageAdapterError {
  if (status === 409 || status === 412) return new StorageAdapterError("DESTINATION_CONFLICT");
  if (status === 413) return new StorageAdapterError("TOO_LARGE");
  if (status === 429) return new StorageAdapterError("RATE_LIMITED", true);
  if (status >= 500) return new StorageAdapterError(write ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE", !write);
  const test = fromStatus(status);
  return new StorageAdapterError(test.code === "OK" ? "PROVIDER_UNAVAILABLE" : test.code);
}

export function transportError(error: unknown, write = false): StorageAdapterError {
  if (error instanceof StorageAdapterError) return error;
  if (error instanceof DomainError && write && ["EGRESS_RESPONSE_TOO_LARGE", "EGRESS_REDIRECT_REFUSED"].includes(error.reasonCode)) {
    return new StorageAdapterError("OUTCOME_UNKNOWN");
  }
  if (error instanceof DomainError && (error.code === "FORBIDDEN" || error.code === "VALIDATION")) {
    return new StorageAdapterError("EGRESS_DENIED");
  }
  if (error instanceof DomainError && error.reasonCode === "EGRESS_REDIRECT_REFUSED") {
    return new StorageAdapterError("EGRESS_DENIED");
  }
  return new StorageAdapterError(write ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE", !write);
}

/** Preserve pre-wire fence failures: no provider write was attempted. */
export async function objectRequest<T>(
  request: (beforeSend?: () => Promise<void>) => Promise<T>,
  write: boolean,
  beforeWrite?: () => Promise<void>,
): Promise<T> {
  const fenceFailure: { cause?: unknown } = {};
  const beforeSend = beforeWrite && (async () => {
    try { await beforeWrite(); }
    catch (error) {
      fenceFailure.cause = error;
      throw error;
    }
  });
  try { return await request(beforeSend); }
  catch (error) {
    if (Object.hasOwn(fenceFailure, "cause")) throw fenceFailure.cause;
    throw transportError(error, write);
  }
}

export function testError(error: unknown): StorageTestResult {
  const code = transportError(error).code;
  return { ok: false, code: code === "EGRESS_DENIED" || code === "NOT_CONFIGURED" ? code : "PROVIDER_UNAVAILABLE" };
}

export function observedSize(headers: Record<string, string>): number {
  const value = headers["content-length"];
  const parsed = value && /^[0-9]{1,16}$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new StorageAdapterError("INTEGRITY_MISMATCH");
  return parsed;
}

export function observedEtag(headers: Record<string, string>): string {
  const etag = headers.etag;
  if (!etag || !/^"[\x21\x23-\x7e]{1,250}"$/u.test(etag)) throw new StorageAdapterError("INTEGRITY_MISMATCH");
  return etag;
}

export function measuredBody(input: StoragePutInput, recordMd5 = false) {
  let verified: { md5?: string } | undefined;
  const body = Readable.from((async function* () {
    const sha = createHash("sha256");
    const md5 = recordMd5 ? createHash("md5") : undefined;
    let size = 0;
    for await (const item of input.body as AsyncIterable<Buffer | string>) {
      input.signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
      size += chunk.length;
      if (size > input.size) throw new StorageAdapterError("INTEGRITY_MISMATCH");
      sha.update(chunk);
      md5?.update(chunk);
      yield chunk;
    }
    if (size !== input.size || sha.digest("hex") !== input.sha256) throw new StorageAdapterError("INTEGRITY_MISMATCH");
    verified = md5 ? { md5: md5.digest("base64") } : {};
  })(), { objectMode: false });
  return { body, verify() {
    if (!verified) throw new StorageAdapterError("INTEGRITY_MISMATCH");
    return verified;
  } };
}
