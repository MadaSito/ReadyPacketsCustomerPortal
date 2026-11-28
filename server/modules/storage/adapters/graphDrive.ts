/**
 * Microsoft Graph drive storage adapter: SharePoint document libraries (`sharepoint`) and OneDrive for
 * Business (`onedrive`). Destination for COPIES only; local storage stays authoritative (ADR / decision 5).
 *
 * Permissions (least privilege, documented in API.md): application permission `Sites.Selected` with a
 * `write` grant on the one site (SharePoint). OneDrive application access can require tenant-wide
 * `Files.ReadWrite.All`; a configured root path does not narrow the application's provider permissions.
 *
 * put():
 *  - Names are mapped to SharePoint/OneDrive-safe names (graphDriveNames.ts) and the full decoded path,
 *    including the library path, is checked against the 400-character limit BEFORE any folder or write call.
 *  - Folders are created one segment at a time with conflictBehavior "fail"; an existing folder (or one a
 *    concurrent worker just created) is reused, keeping the drive's casing.
 *  - Files are never overwritten. A same-name file with the same size and QuickXorHash is reused (idempotent
 *    re-run after a lost acknowledgement); otherwise the next free "name (n).ext" is used. Large uploads
 *    compare the hash before committing the final chunk. `targetPath` is the real final path.
 *  - ≤ SIMPLE_UPLOAD_MAX bytes: one PUT …:/content. Larger: an upload session; chunks are multiples of
 *    320 KiB; the session URL is checked against the tenant host lineage, receives no bearer token, is never
 *    logged, and is cancelled on failure.
 *  - After upload the provider-reported size and QuickXorHash must match what was streamed, else
 *    INTEGRITY_MISMATCH. `sha256` is never returned (Graph does not report SHA-256 for these drives).
 */
import type { Readable } from "node:stream";
import { z } from "zod";
import type { StorageAdapter, StorageAdapterDefinition, StoragePutInput, StoragePutResult, StorageTestResult } from "../contracts.js";
import { StorageAdapterError, fromStatus, toAdapterError } from "./graphDriveErrors.js";
import type { GraphCredentials, GraphHttpPort, GraphResponse } from "./graphDrivePort.js";
import { QuickXorHash } from "./graphDriveQuickXor.js";
import {
  checkUploadUrl,
  encodeDrivePath,
  parseSiteUrl,
  sharePointTenantOf,
  siteLookupPath,
  splitRootFolderPath,
} from "./graphDriveUrls.js";
import { MAX_DECODED_PATH, MAX_SUFFIX, conflictVariant, decodedLength, fitFileName, safeDriveName } from "./graphDriveNames.js";

export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** 32 × 320 KiB = 10 MiB (Graph requires multiples of 320 KiB). */
export const UPLOAD_CHUNK = 32 * 320 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const CHUNK_ATTEMPTS = 3;
/** Caller path segments below the configured root (the folder resolver allows 8). */
const MAX_PATH_SEGMENTS = 12;

/* ------------------------------------------------------------------ config */

const guidOrEmpty = z.union([z.literal(""), z.uuid()]);
const id = z.string().max(300).regex(/^[A-Za-z0-9!._,:-]*$/u, "invalid identifier");
const label = z.string().max(255);
const rootFolderPath = z
  .string()
  .max(400)
  .refine((v) => splitRootFolderPath(v) !== null, "invalid folder path");

export const sharePointConfigSchema = z.strictObject({
  tenantId: guidOrEmpty,
  clientId: guidOrEmpty,
  siteUrl: z
    .string()
    .max(400)
    .refine((v) => v === "" || parseSiteUrl(v) !== null, "must be a https://<tenant>.sharepoint.com site address"),
  siteId: id,
  driveId: id,
  driveName: label,
  rootFolderPath,
});
export type SharePointConfig = z.infer<typeof sharePointConfigSchema>;

export const oneDriveConfigSchema = z.strictObject({
  tenantId: guidOrEmpty,
  clientId: guidOrEmpty,
  userPrincipalName: z.union([z.literal(""), z.email().max(254)]),
  driveId: id,
  driveName: label,
  rootFolderPath,
});
export type OneDriveConfig = z.infer<typeof oneDriveConfigSchema>;

export const graphCredentialsSchema = z.strictObject({ clientSecret: z.string().min(1).max(512) });
export type GraphDriveCredentials = z.infer<typeof graphCredentialsSchema>;

type DriveConfig = { tenantId: string; clientId: string; driveId: string; rootFolderPath: string };

/* ------------------------------------------------------------------ helpers */

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 2048 ? v : null);

function expectOk(res: GraphResponse, ...ok: number[]): Record<string, unknown> {
  if (!ok.includes(res.status)) throw fromStatus(res.status, res.headers["retry-after"]);
  return asRecord(res.body);
}

function credentialsOf(config: DriveConfig, credentials: Partial<GraphDriveCredentials>): GraphCredentials | null {
  if (!config.tenantId || !config.clientId || !credentials.clientSecret) return null;
  return { tenantId: config.tenantId, clientId: config.clientId, clientSecret: credentials.clientSecret };
}

async function readExactly(body: Readable, size: number, onChunk: (chunk: Buffer) => Promise<void>, chunkSize: number): Promise<void> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let total = 0;
  for await (const piece of body) {
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
    total += buf.length;
    if (total > size) throw new StorageAdapterError("INVALID_INPUT", false);
    pending.push(buf);
    pendingBytes += buf.length;
    while (pendingBytes >= chunkSize) {
      const all = Buffer.concat(pending, pendingBytes);
      await onChunk(all.subarray(0, chunkSize));
      const rest = all.subarray(chunkSize);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  }
  if (total !== size) throw new StorageAdapterError("INVALID_INPUT", false);
  if (pendingBytes > 0) await onChunk(Buffer.concat(pending, pendingBytes));
}

/* ------------------------------------------------------------------ adapter */

export function createGraphDriveAdapter(graph: GraphHttpPort, config: DriveConfig, credentials: Partial<GraphDriveCredentials>): StorageAdapter {
  const creds = credentialsOf(config, credentials);
  const root = splitRootFolderPath(config.rootFolderPath) ?? [];
  const drive = `/drives/${encodeURIComponent(config.driveId)}`;

  const call = async (req: Parameters<GraphHttpPort["request"]>[1]): Promise<GraphResponse> => {
    if (!creds || !config.driveId) throw new StorageAdapterError("NOT_CONFIGURED", false);
    let fenceLost: { error: unknown } | null = null;
    const fenced = req.beforeSend;
    const beforeSend = fenced
      ? async () => {
          try {
            await fenced();
          } catch (error) {
            fenceLost = { error };
            throw error;
          }
        }
      : undefined;
    try {
      return await graph.request(creds, beforeSend ? { ...req, beforeSend } : req);
    } catch (error) {
      if (fenceLost) throw (fenceLost as { error: unknown }).error;
      throw toAdapterError(error);
    }
  };

  const itemByPath = async (segments: readonly string[], signal?: AbortSignal): Promise<Record<string, unknown> | null> => {
    const path = segments.length === 0 ? `${drive}/root` : `${drive}/root:/${encodeDrivePath(segments)}:`;
    const res = await call({ method: "GET", path, query: { $select: "id,name,size,folder,file" }, signal });
    if (res.status === 404) return null;
    return expectOk(res, 200);
  };

  /** Returns the folder item id at root + segments (creating missing folders) and the REAL segment names. */
  const ensureFolderId = async (segments: readonly string[], signal?: AbortSignal, beforeWrite?: () => Promise<void>,
    requireExistingRoot = false): Promise<{ id: string; names: string[] }> => {
    const full = [...root, ...segments];
    const rootItem = await itemByPath([], signal);
    let parentId = str(rootItem?.id);
    if (!parentId) throw new StorageAdapterError("DESTINATION_NOT_FOUND", false);
    // Real names (drive casing wins: "Customers" is reused for "customers"), so later lookups and the
    // recorded target path match what exists remotely.
    const real: string[] = [];
    for (let i = 0; i < full.length; i++) {
      const lookup = [...real, full[i]!];
      const existing = await itemByPath(lookup, signal);
      let folder: Record<string, unknown>;
      if (existing) {
        if (!existing.folder) throw new StorageAdapterError("DESTINATION_CONFLICT", false);
        folder = existing;
      } else {
        if (requireExistingRoot && i < root.length) throw new StorageAdapterError("DESTINATION_NOT_FOUND");
        await beforeWrite?.();
        const res = await call({
          method: "POST",
          path: `${drive}/items/${encodeURIComponent(parentId)}/children`,
          body: { name: full[i], folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
          signal,
          ...(beforeWrite ? { beforeSend: beforeWrite } : {}),
        });
        if (res.status === 409) {
          // A concurrent worker created it first: reuse it. Not visible yet → retry later, never duplicate.
          const raced = await itemByPath(lookup, signal);
          if (!raced) throw new StorageAdapterError("PROVIDER_UNAVAILABLE", true);
          if (!raced.folder) throw new StorageAdapterError("DESTINATION_CONFLICT", false);
          folder = raced;
        } else {
          folder = expectOk(res, 200, 201);
        }
      }
      parentId = str(folder.id);
      if (!parentId) throw new StorageAdapterError("PROVIDER_UNAVAILABLE", true);
      const name = str(folder.name);
      real.push(name && name.toLowerCase() === full[i]!.toLowerCase() ? name : full[i]!);
    }
    return { id: parentId, names: real.slice(root.length) };
  };

  /** Library server-relative path ("sites/Orders/Shared Documents"), counted in the 400-character limit. */
  let driveInfo: { tenant: string | null; prefix: string } | null = null;
  const describeDrive = async (signal?: AbortSignal) => {
    if (driveInfo) return driveInfo;
    const body = expectOk(await call({ method: "GET", path: drive, query: { $select: "id,webUrl" }, signal }), 200);
    const url = (() => {
      try {
        return new URL(str(body.webUrl) ?? "");
      } catch {
        return null;
      }
    })();
    const prefix = (() => {
      if (!url) return "";
      try {
        return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/gu, "");
      } catch {
        return url.pathname.replace(/^\/+|\/+$/gu, "");
      }
    })();
    driveInfo = { tenant: url ? sharePointTenantOf(url.hostname) : null, prefix };
    return driveInfo;
  };

  /**
   * Validates the caller's segments and maps them to safe drive names, before any folder or write call.
   * Traversal (`.`, `..`, `/`, `\\`) and empty segments are refused, never mapped; other provider rules are mapped.
   */
  const prepare = async (path: readonly string[], rawName: string | undefined, signal?: AbortSignal) => {
    const bad = (v: unknown) => typeof v !== "string" || v.trim() === "" || v === "." || v === ".." || /[\\/]/u.test(v) || v.length > 1024;
    if (path.length > MAX_PATH_SEGMENTS || path.some(bad) || (rawName !== undefined && bad(rawName))) {
      throw new StorageAdapterError("INVALID_INPUT", false);
    }
    const folders = path.map((seg, i) => safeDriveName(seg, { file: false, topLevel: root.length === 0 && i === 0 }));
    const { prefix } = await describeDrive(signal);
    const prefixSegs = [...(prefix ? [prefix] : []), ...root, ...folders];
    const folderLength = decodedLength(prefixSegs);
    if (folderLength > MAX_DECODED_PATH) throw new StorageAdapterError("INVALID_INPUT", false);
    if (rawName === undefined) return { folders, name: null };
    const name = fitFileName(folderLength, safeDriveName(rawName, { file: true }), rawName);
    if (!name) throw new StorageAdapterError("INVALID_INPUT", false);
    return { folders, name };
  };

  const hashOf = (it: Record<string, unknown>) => str(asRecord(asRecord(asRecord(it.file).hashes)).quickXorHash);

  const verify = async (item: Record<string, unknown>, size: number, quickXor: string, signal?: AbortSignal): Promise<StoragePutResult> => {
    let observed = item;
    const itemId = str(item.id);
    if (!itemId) throw new StorageAdapterError("PROVIDER_UNAVAILABLE", false);
    if (typeof observed.size !== "number" || !hashOf(observed)) {
      const res = await call({ method: "GET", path: `${drive}/items/${encodeURIComponent(itemId)}`, query: { $select: "id,name,size,file" }, signal });
      observed = expectOk(res, 200);
    }
    if (str(observed.id) !== itemId || observed.size !== size || hashOf(observed) !== quickXor) {
      throw new StorageAdapterError("INTEGRITY_MISMATCH", false);
    }
    return { remoteId: itemId, size: observed.size, verifiedTransportDigest: "quickxor" };
  };

  type LargeOutcome = { kind: "uploaded"; item: Record<string, unknown>; quickXor: string } | { kind: "conflict" } | { kind: "identical"; item: Record<string, unknown>; quickXor: string };

  /**
   * Upload session into `parentId/name`. `identicalTo` is consulted with the full QuickXorHash BEFORE the
   * final chunk is sent: a match cancels the session (nothing committed) and reuses that item.
   */
  const uploadLarge = async (parentId: string, name: string, input: StoragePutInput, identicalTo: (quickXor: string) => Record<string, unknown> | null): Promise<LargeOutcome> => {
    const { tenant } = await describeDrive(input.signal);
    if (!tenant) throw new StorageAdapterError("DESTINATION_DENIED", false);
    await input.beforeWrite?.();
    const res = await call({
      method: "POST",
      path: `${drive}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}:/createUploadSession`,
      body: { item: { "@microsoft.graph.conflictBehavior": "fail" } },
      signal: input.signal,
      ...(input.beforeWrite ? { beforeSend: input.beforeWrite } : {}),
    });
    if (res.status === 409) return { kind: "conflict" };
    const url = checkUploadUrl(expectOk(res, 200).uploadUrl, tenant);
    if (!url) throw new StorageAdapterError("DESTINATION_DENIED", false);
    const hash = new QuickXorHash();
    let offset = 0;
    let finalItem: Record<string, unknown> | null = null;
    let identical: { item: Record<string, unknown>; quickXor: string } | null = null;
    let finalSent = false;
    const stopIdentical = new Error("identical");
    // A lost fence must reach the job layer unchanged (never re-labelled as a retryable provider error).
    let fenceError: { error: unknown } | null = null;
    const fence = async () => {
      try {
        await input.beforeWrite?.();
      } catch (error) {
        fenceError = { error };
        throw error;
      }
    };
    try {
      await readExactly(
        input.body,
        input.size,
        async (chunk) => {
          hash.update(chunk);
          const end = offset + chunk.length - 1;
          if (end === input.size - 1) {
            const quickXor = hash.digestBase64();
            const match = identicalTo(quickXor);
            if (match) {
              identical = { item: match, quickXor };
              throw stopIdentical;
            }
          }
          for (let attempt = 1; ; attempt++) {
            let r: GraphResponse | null = null;
            await fence();
            try {
              r = await graph.uploadSessionPut({ url, body: chunk, contentRange: `bytes ${offset}-${end}/${input.size}`, signal: input.signal,
                beforeSend: async () => { await fence(); if (end === input.size - 1) finalSent = true; } });
            } catch (error) {
              if (input.exactCreate && finalSent && !fenceError) throw new StorageAdapterError("OUTCOME_UNKNOWN");
              if (fenceError || attempt >= CHUNK_ATTEMPTS) throw error instanceof StorageAdapterError || fenceError ? error : toAdapterError(error);
            }
            if (r && (r.status === 200 || r.status === 201)) {
              finalItem = asRecord(r.body);
              break;
            }
            if (r && r.status === 202) break;
            if (input.exactCreate && r) {
              if (finalSent && r.status >= 500) throw new StorageAdapterError("OUTCOME_UNKNOWN");
              throw fromStatus(r.status, r.headers["retry-after"]);
            }
            // Name taken at commit by a concurrent writer: nothing of ours was committed; a retry picks the next name.
            if (r && r.status === 409) throw new StorageAdapterError("DESTINATION_CONFLICT", true);
            if (r && !(r.status >= 500 || r.status === 429)) throw fromStatus(r.status);
            if (attempt >= CHUNK_ATTEMPTS) throw new StorageAdapterError("PROVIDER_UNAVAILABLE", true);
            // Resume only if the server still expects exactly this chunk.
            const status = await graph.uploadSessionControl({ url, method: "GET", signal: input.signal, beforeSend: fence }).catch((e: unknown) => {
              throw fenceError ? e : toAdapterError(e);
            });
            const ranges = asRecord(status.body).nextExpectedRanges;
            const next = Array.isArray(ranges) && typeof ranges[0] === "string" ? Number.parseInt(ranges[0], 10) : Number.NaN;
            if (next !== offset) throw new StorageAdapterError("PROVIDER_UNAVAILABLE", true);
          }
          offset = end + 1;
        },
        UPLOAD_CHUNK,
      );
    } catch (error) {
      // Best-effort cancel, but never after a lost write fence; a valid cancel is itself fenced.
      if (!fenceError) await graph.uploadSessionControl({ url, method: "DELETE", beforeSend: fence }).catch(() => undefined);
      if (fenceError) throw (fenceError as { error: unknown }).error;
      if (error === stopIdentical && identical) return { kind: "identical", ...(identical as { item: Record<string, unknown>; quickXor: string }) };
      throw toAdapterError(error);
    }
    if (!finalItem) throw input.exactCreate && finalSent ? new StorageAdapterError("OUTCOME_UNKNOWN") : new StorageAdapterError("PROVIDER_UNAVAILABLE", true);
    return { kind: "uploaded", item: finalItem, quickXor: hash.digestBase64() };
  };

  return {
    // put() validates names and the full path first, then creates its folders behind beforeWrite.
    putCreatesFolders: true,

    async testWrite(beforeWrite, signal): Promise<StorageTestResult> {
      try {
        const folder = await itemByPath(root, signal);
        const parentId = folder?.folder ? str(folder.id) : null;
        const { tenant } = await describeDrive(signal);
        if (!parentId || !tenant) return { ok: false, code: "DESTINATION_NOT_FOUND" };
        const name = `readypackets-write-check-${crypto.randomUUID()}.tmp`;
        const res = await call({
          method: "POST", path: `${drive}/items/${encodeURIComponent(parentId)}:/${name}:/createUploadSession`,
          body: { item: { "@microsoft.graph.conflictBehavior": "fail" } }, signal, beforeSend: beforeWrite,
        });
        const url = checkUploadUrl(expectOk(res, 200).uploadUrl, tenant);
        if (!url) return { ok: false, code: "DESTINATION_DENIED" };
        // Cancellation proves the chunk-session egress path without writing a file or deleting an item.
        expectOk(await graph.uploadSessionControl({ url, method: "DELETE", signal, beforeSend: beforeWrite }), 204, 200);
        return { ok: true, code: "OK" };
      } catch (error) {
        const { code } = toAdapterError(error);
        return { ok: false, code: code === "AUTH_FAILED" || code === "DESTINATION_DENIED" || code === "DESTINATION_NOT_FOUND" ||
          code === "EGRESS_DENIED" || code === "RATE_LIMITED" || code === "NOT_CONFIGURED" ? code : "PROVIDER_UNAVAILABLE" };
      }
    },
    async inspectExact(path, name, signal) {
      const prepared = await prepare(path, name, signal);
      if (!prepared.name) throw new StorageAdapterError("INVALID_INPUT");
      return await itemByPath([...root, ...prepared.folders, prepared.name], signal) ? "present" : "missing";
    },

    async test(signal?: AbortSignal): Promise<StorageTestResult> {
      try {
        if (!creds || !config.driveId || splitRootFolderPath(config.rootFolderPath) === null) return { ok: false, code: "NOT_CONFIGURED" };
        expectOk(await call({ method: "GET", path: drive, query: { $select: "id,driveType" }, signal }), 200);
        const folder = await itemByPath(root, signal);
        if (!folder) return { ok: false, code: "DESTINATION_NOT_FOUND" };
        if (!folder.folder) return { ok: false, code: "DESTINATION_NOT_FOUND" };
        return { ok: true, code: "OK" };
      } catch (error) {
        const e = toAdapterError(error);
        const code =
          e.code === "DESTINATION_CONFLICT" || e.code === "INTEGRITY_MISMATCH" || e.code === "INVALID_INPUT" || e.code === "TOO_LARGE" || e.code === "OUTCOME_UNKNOWN"
            ? "PROVIDER_UNAVAILABLE"
            : e.code;
        return { ok: false, code };
      }
    },

    async ensureFolder(path: readonly string[], signal?: AbortSignal, beforeWrite?: () => Promise<void>): Promise<void> {
      const { folders } = await prepare(path, undefined, signal);
      await ensureFolderId(folders, signal, beforeWrite);
    },

    async put(input: StoragePutInput): Promise<StoragePutResult> {
      if (!Number.isSafeInteger(input.size) || input.size < 0) throw new StorageAdapterError("INVALID_INPUT", false);
      if (input.size > MAX_FILE_BYTES) throw new StorageAdapterError("TOO_LARGE", false);
      const { folders, name } = await prepare(input.path, input.name, input.signal);
      if (!name) throw new StorageAdapterError("INVALID_INPUT", false);
      // Simple PUT needs a raw-bytes request; transports without it use a (single-chunk) upload session.
      if (input.size === 0 && graph.supportsRawBody === false) throw new StorageAdapterError("INVALID_INPUT", false);
      if (input.exactCreate && input.size === 0) throw new StorageAdapterError("INVALID_INPUT");
      const simple = !input.exactCreate && input.size <= SIMPLE_UPLOAD_MAX && graph.supportsRawBody !== false;
      const parent = await ensureFolderId(folders, input.signal, input.beforeWrite, input.exactCreate === true);
      const folderPath = [...root, ...parent.names];

      let bytes: Buffer | null = null;
      let quickXor: string | null = null;
      if (simple) {
        const parts: Buffer[] = [];
        await readExactly(input.body, input.size, async (c) => void parts.push(Buffer.from(c)), SIMPLE_UPLOAD_MAX + 1);
        bytes = Buffer.concat(parts);
        quickXor = new QuickXorHash().update(bytes).digestBase64();
      }

      // Same-name files are never overwritten: an identical file (size + QuickXorHash) is reused, otherwise
      // the next free "name (n).ext" is used. Every create uses conflictBehavior "fail", so concurrent
      // writers can never replace each other; a lost race moves on to the next variant.
      const sameSize: Record<string, unknown>[] = [];
      const identicalTo = (hash: string) => sameSize.find((item) => hashOf(item) === hash) ?? null;
      const done = async (item: Record<string, unknown>, hash: string, candidate: string, reused = false) => {
        const result = await verify(item, input.size, hash, input.signal).catch((error: unknown) => {
          if (input.exactCreate) throw new StorageAdapterError("OUTCOME_UNKNOWN");
          throw error;
        });
        // The real final path below the configured root: drive casing for folders, the committed file name.
        return { ...result, targetPath: [...parent.names, str(item.name) ?? candidate], ...(reused ? { reusedExisting: true as const } : {}) };
      };
      for (let n = 0; n <= (input.exactCreate ? 0 : MAX_SUFFIX); n++) {
        const candidate = conflictVariant(name, n);
        const existing = await itemByPath([...folderPath, candidate], input.signal);
        if (existing) {
          if (input.exactCreate) throw new StorageAdapterError("DESTINATION_CONFLICT");
          if (existing.file && existing.size === input.size) sameSize.push(existing);
          continue;
        }
        if (simple && bytes && quickXor) {
          const match = identicalTo(quickXor);
          if (match) return done(match, quickXor, candidate, true);
          await input.beforeWrite?.();
          const res = await call({
            method: "PUT",
            path: `${drive}/items/${encodeURIComponent(parent.id)}:/${encodeURIComponent(candidate)}:/content`,
            query: { "@microsoft.graph.conflictBehavior": "fail" },
            rawBody: bytes,
            headers: { "content-type": "application/octet-stream" },
            signal: input.signal,
            ...(input.beforeWrite ? { beforeSend: input.beforeWrite } : {}),
          });
          if (res.status === 409) {
            const raced = await itemByPath([...folderPath, candidate], input.signal);
            if (raced?.file && raced.size === input.size) sameSize.push(raced);
            const again = identicalTo(quickXor);
            if (again) return done(again, quickXor, candidate, true);
            continue;
          }
          return done(expectOk(res, 200, 201), quickXor, candidate);
        }
        const outcome = await uploadLarge(parent.id, candidate, input, identicalTo);
        if (outcome.kind === "conflict") {
          const raced = await itemByPath([...folderPath, candidate], input.signal);
          if (raced?.file && raced.size === input.size) sameSize.push(raced);
          continue;
        }
        if (outcome.kind === "identical") return done(outcome.item, outcome.quickXor, candidate, true);
        return done(outcome.item, outcome.quickXor, candidate);
      }
      throw new StorageAdapterError("DESTINATION_CONFLICT", false);
    },

    async remove(remoteId: string, signal?: AbortSignal): Promise<void> {
      if (!/^[A-Za-z0-9!._,-]{1,300}$/u.test(remoteId)) throw new StorageAdapterError("INVALID_INPUT", false);
      const path = `${drive}/items/${encodeURIComponent(remoteId)}`;
      const found = await call({ method: "GET", path, signal });
      if (found.status === 404) return;
      const item = expectOk(found, 200);
      if (str(item.id) !== remoteId || !item.file || item.folder) throw new StorageAdapterError("OUTCOME_UNKNOWN");
      const res = await call({ method: "POST", path: `${path}/permanentDelete`, signal });
      if (res.status === 404) return;
      expectOk(res, 204);
      if ((await call({ method: "GET", path, signal })).status !== 404) throw new StorageAdapterError("OUTCOME_UNKNOWN");
    },
  };
}

/* ------------------------------------------------------------------ registration */

export function graphDriveDefinitions(graph: GraphHttpPort): {
  sharepoint: StorageAdapterDefinition<SharePointConfig, GraphDriveCredentials>;
  onedrive: StorageAdapterDefinition<OneDriveConfig, GraphDriveCredentials>;
} {
  return {
    sharepoint: {
      configSchema: sharePointConfigSchema,
      credentialsSchema: graphCredentialsSchema,
      purposes: ["order_files", "backups", "order_data"],
      create: ({ config, credentials }) => createGraphDriveAdapter(graph, config, credentials),
    },
    onedrive: {
      configSchema: oneDriveConfigSchema,
      credentialsSchema: graphCredentialsSchema,
      purposes: ["order_files", "backups"],
      create: ({ config, credentials }) => createGraphDriveAdapter(graph, config, credentials),
    },
  };
}

/* ------------------------------------------------------------------ discovery (setup wizard) */

export interface DiscoveredSite {
  siteId: string;
  displayName: string;
  webUrl: string;
}

async function setupCall(graph: GraphHttpPort, creds: GraphCredentials | null, req: Parameters<GraphHttpPort["request"]>[1]) {
  if (!creds) throw new StorageAdapterError("NOT_CONFIGURED", false);
  try {
    return await graph.request(creds, req);
  } catch (error) {
    throw toAdapterError(error);
  }
}

export function graphDriveDiscovery(graph: GraphHttpPort) {
  const credsFor = (config: { tenantId: string; clientId: string }, credentials: Partial<GraphDriveCredentials> | null) =>
    credentialsOf({ ...config, driveId: "-", rootFolderPath: "" }, credentials ?? {});

  return {
    async discoverSite(config: { tenantId: string; clientId: string }, credentials: Partial<GraphDriveCredentials> | null, siteUrl: string, signal?: AbortSignal): Promise<DiscoveredSite> {
      const parsed = parseSiteUrl(siteUrl);
      if (!parsed) throw new StorageAdapterError("INVALID_INPUT", false);
      const res = await setupCall(graph, credsFor(config, credentials), { method: "GET", path: siteLookupPath(parsed), query: { $select: "id,displayName,webUrl" }, signal });
      const body = expectOk(res, 200);
      const siteId = str(body.id);
      const webUrl = str(body.webUrl);
      if (!siteId || !webUrl || sharePointTenantOf(new URL(webUrl).hostname) !== sharePointTenantOf(parsed.hostname)) {
        throw new StorageAdapterError("PROVIDER_UNAVAILABLE", false);
      }
      return { siteId, displayName: (str(body.displayName) ?? "").slice(0, 255), webUrl };
    },

    async listDrives(config: { tenantId: string; clientId: string }, credentials: Partial<GraphDriveCredentials> | null, siteId: string, signal?: AbortSignal) {
      if (!id.safeParse(siteId).success || !siteId) throw new StorageAdapterError("INVALID_INPUT", false);
      const res = await setupCall(graph, credsFor(config, credentials), {
        method: "GET",
        path: `/sites/${encodeURIComponent(siteId)}/drives`,
        query: { $select: "id,name,driveType", $top: "100" },
        signal,
      });
      const value = asRecord(expectOk(res, 200)).value;
      const drives = (Array.isArray(value) ? value : [])
        .map(asRecord)
        .filter((d) => d.driveType === "documentLibrary" && str(d.id))
        .map((d) => ({ driveId: str(d.id)!, name: (str(d.name) ?? "").slice(0, 255), driveType: "documentLibrary" as const }));
      return { drives };
    },

    async resolveOneDrive(config: { tenantId: string; clientId: string }, credentials: Partial<GraphDriveCredentials> | null, userPrincipalName: string, signal?: AbortSignal) {
      if (!z.email().max(254).safeParse(userPrincipalName).success) throw new StorageAdapterError("INVALID_INPUT", false);
      const res = await setupCall(graph, credsFor(config, credentials), {
        method: "GET",
        path: `/users/${encodeURIComponent(userPrincipalName)}/drive`,
        query: { $select: "id,name,driveType" },
        signal,
      });
      const body = expectOk(res, 200);
      if (body.driveType !== "business" || !str(body.id)) throw new StorageAdapterError("DESTINATION_DENIED", false);
      return { driveId: str(body.id)!, driveName: (str(body.name) ?? "OneDrive").slice(0, 255) };
    },

    async listFolders(
      config: { tenantId: string; clientId: string },
      credentials: Partial<GraphDriveCredentials> | null,
      input: { driveId: string; parentItemId: string | null; cursor: string | null },
      signal?: AbortSignal,
    ) {
      if (!input.driveId || !id.safeParse(input.driveId).success || (input.parentItemId !== null && !id.safeParse(input.parentItemId).success)) {
        throw new StorageAdapterError("INVALID_INPUT", false);
      }
      if (input.cursor !== null && !/^[A-Za-z0-9._~%-]{1,1024}$/u.test(input.cursor)) throw new StorageAdapterError("INVALID_INPUT", false);
      const item = input.parentItemId ? `items/${encodeURIComponent(input.parentItemId)}` : "root";
      const query: Record<string, string> = { $select: "id,name,folder,parentReference", $top: "200" };
      if (input.cursor) query.$skiptoken = input.cursor;
      const res = await setupCall(graph, credsFor(config, credentials), {
        method: "GET",
        path: `/drives/${encodeURIComponent(input.driveId)}/${item}/children`,
        query,
        signal,
      });
      const body = expectOk(res, 200);
      const value = Array.isArray(body.value) ? body.value : [];
      const folders = value
        .map(asRecord)
        .filter((f) => f.folder && str(f.id) && str(f.name))
        .map((f) => {
          const parentPath = str(asRecord(f.parentReference).path) ?? "";
          const relative = parentPath.includes("root:") ? parentPath.slice(parentPath.indexOf("root:") + 5).replace(/^\//u, "") : "";
          let decoded: string;
          try {
            decoded = decodeURIComponent(relative);
          } catch {
            decoded = "";
          }
          const name = str(f.name)!;
          return { itemId: str(f.id)!, name: name.slice(0, 255), path: (decoded ? `${decoded}/${name}` : name).slice(0, 400) };
        });
      let nextCursor: string | null = null;
      const next = str(body["@odata.nextLink"]);
      if (next) {
        try {
          const token = new URL(next).searchParams.get("$skiptoken");
          nextCursor = token && /^[A-Za-z0-9._~%-]{1,1024}$/u.test(encodeURIComponent(token)) ? encodeURIComponent(token) : null;
        } catch {
          nextCursor = null;
        }
      }
      return { folders, nextCursor };
    },
  };
}
