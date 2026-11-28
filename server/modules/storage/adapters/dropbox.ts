import { createHash } from "node:crypto";
import { z } from "zod";
import { validation } from "../../../core/errors.js";
import { verifyRemoval, type StorageAdapterDefinition, type StoragePutInput } from "../contracts.js";
import {
  accessFor, dataError, dataRequest, integrityError, oauthConfigSchema, oauthCredentialsSchema, parseResponse, pathParts,
  safeObjectName, testResult, verifiedChunks, type OAuthStorageConfig, type OAuthStorageCredentials,
} from "../oauth/data.js";
import type { StorageRequest } from "../oauth/provider.js";

const API = "https://api.dropboxapi.com/2/";
const CONTENT = "https://content.dropboxapi.com/2/files/";
const BLOCK = 4 * 1024 * 1024;
const CHUNK = 2 * BLOCK;
const id = z.string().regex(/^id:[A-Za-z0-9_-]{1,200}$/);
const file = z.object({ id, size: z.number().int().nonnegative(), content_hash: z.string().regex(/^[a-f0-9]{64}$/) });
const session = z.object({ session_id: z.string().regex(/^[\x21-\x7e]{1,512}$/) });
const folder = z.object({ ".tag": z.literal("folder") });
const createFolder = z.object({ metadata: z.object({ id }) });
const headerJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

function dropboxPath(parts: string[]): string {
  const path = "/" + parts.join("/");
  if (Buffer.byteLength(path) > 2_000 || parts.some((part) => /[<>:"|?*]/.test(part) || part.endsWith("."))) {
    throw validation("STORAGE_PATH_INVALID", "The Dropbox destination path is invalid.");
  }
  return path;
}

export function dropboxAdapter(request: StorageRequest): StorageAdapterDefinition<OAuthStorageConfig, OAuthStorageCredentials> {
  return {
    configSchema: oauthConfigSchema, credentialsSchema: oauthCredentialsSchema, purposes: ["order_files", "backups"],
    create({ config, credentials }) {
      const access = accessFor(request, "dropbox", { clientId: config.clientId, clientSecret: credentials.clientSecret }, credentials.refreshToken);
      const send = dataRequest(request, false, true);
      async function rpc(operation: string, arg: unknown, signal?: AbortSignal, fence?: () => Promise<void>) {
        const body = JSON.stringify(arg);
        const bearer = await access(signal);
        return send(API + operation, { method: "POST", signal, body, beforeSend: fence, headers: {
          Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)),
        } });
      }
      async function upload(operation: string, arg: unknown, body: Buffer, signal?: AbortSignal, fence?: () => Promise<void>) {
        const bearer = await access(signal);
        return send(CONTENT + operation, { method: "POST", signal, body, timeoutMs: 30_000, maxRequestBytes: CHUNK, beforeSend: fence, headers: {
          Authorization: `Bearer ${bearer}`, "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": headerJson(arg), "Content-Length": String(body.length),
        } });
      }
      return {
        async test(signal) {
          try {
            // App Folder access and metadata scope; no mutation or user/account-read scope.
            parseResponse(await rpc("files/list_folder", { path: "", limit: 1 }, signal),
              z.object({ entries: z.array(z.unknown()) }));
            return { ok: true, code: "OK" };
          } catch (error) { return testResult(error); }
        },
        async ensureFolder(path, signal, beforeWrite) {
          const parts = pathParts(config, path);
          for (let i = 1; i <= parts.length; i++) {
            const path = dropboxPath(parts.slice(0, i));
            const rsp = await rpc("files/create_folder_v2", { path, autorename: false }, signal, beforeWrite);
            if (rsp.status === 409) {
              // 409 also covers files, namespace conflicts and incorrect paths; only an actual folder is accepted.
              parseResponse(await rpc("files/get_metadata", { path }, signal), folder);
            } else parseResponse(rsp, createFolder);
          }
        },
        async put(input: StoragePutInput) {
          const path = dropboxPath([...pathParts(config, input.path), safeObjectName(input.name)]);
          const commit = { path, mode: input.protectExisting ? "add" : "overwrite", autorename: false, mute: true };
          const hash = createHash("sha256");
          const bytes = verifiedChunks(input, CHUNK);
          let metadata: z.infer<typeof file>;
          if (input.size <= CHUNK) {
            const { value } = await bytes.next();
            if (!value) throw integrityError();
            for (let offset = 0; offset < value.length; offset += BLOCK) hash.update(createHash("sha256").update(value.subarray(offset, offset + BLOCK)).digest());
            metadata = parseResponse(await upload("upload", commit, value, input.signal, input.beforeWrite), file);
          } else {
            let offset = 0;
            let sessionId: string | undefined;
            for await (const part of bytes) {
              for (let block = 0; block < part.length; block += BLOCK) hash.update(createHash("sha256").update(part.subarray(block, block + BLOCK)).digest());
              if (!sessionId) {
                sessionId = parseResponse(await upload("upload_session/start", { close: false }, part, input.signal, input.beforeWrite), session).session_id;
              } else {
                const rsp = await upload("upload_session/append_v2",
                  { cursor: { session_id: sessionId, offset }, close: false }, part, input.signal, input.beforeWrite);
                if (rsp.status !== 200) throw dataError(rsp.status);
              }
              offset += part.length;
            }
            if (!sessionId || offset !== input.size) throw integrityError();
            metadata = parseResponse(await upload("upload_session/finish",
              { cursor: { session_id: sessionId, offset }, commit }, Buffer.alloc(0), input.signal, input.beforeWrite), file);
          }
          if (metadata.size !== input.size || metadata.content_hash !== hash.digest("hex")) throw integrityError();
          return { remoteId: metadata.id, size: metadata.size };
        },
        async remove(remoteId, signal) {
          if (!id.safeParse(remoteId).success) throw validation("STORAGE_REMOTE_ID_INVALID", "The storage object reference is invalid.");
          function absent(rsp: Awaited<ReturnType<typeof rpc>>) {
            if (rsp.status !== 409) return false;
            const missing = z.object({ error: z.object({ ".tag": z.literal("path_lookup"),
              path_lookup: z.object({ ".tag": z.literal("not_found") }) }) });
            const alternate = z.object({ error: z.object({ ".tag": z.literal("path"),
              path: z.object({ ".tag": z.literal("not_found") }) }) });
            const result = JSON.parse(rsp.body.toString("utf8")) as unknown;
            return missing.safeParse(result).success || alternate.safeParse(result).success;
          }
          const path = { path: remoteId };
          const before = await rpc("files/get_metadata", path, signal);
          if (!absent(before)) {
            const { id: foundId } = before.status === 200 ?
              await verifyRemoval(async () => parseResponse(before, file)) : parseResponse(before, file);
            if (foundId !== remoteId) throw integrityError();
            const result = await verifyRemoval(() => rpc("files/delete_v2", path, signal));
            if (result.status === 401 || result.status === 403) parseResponse(result, file);
            await verifyRemoval(async () => {
              if (!absent(result)) parseResponse(result, z.object({ metadata: z.object({ id: z.literal(remoteId) }) }));
              if (!absent(await rpc("files/get_metadata", path, signal))) throw integrityError();
            });
          }
          // This connector is a user app; Dropbox Business-only permanent-delete is not within its scope.
          return { providerRecycleBin: true as const };
        },
      };
    },
  };
}
