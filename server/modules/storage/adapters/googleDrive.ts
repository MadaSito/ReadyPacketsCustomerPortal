import { createHash } from "node:crypto";
import { z } from "zod";
import { validation } from "../../../core/errors.js";
import type { EgressFetchOptions } from "../../integrations/egress.js";
import { StorageAdapterError, type StorageAdapterDefinition } from "../contracts.js";
import {
  accessFor, dataError, dataRequest, integrityError, oauthConfigSchema, oauthCredentialsSchema, parseResponse, pathParts,
  safeObjectName, testResult, verifiedChunks, type OAuthStorageConfig, type OAuthStorageCredentials,
} from "../oauth/data.js";
import type { StorageRequest } from "../oauth/provider.js";

const ORIGIN = "https://www.googleapis.com";
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB
const FOLDER = "application/vnd.google-apps.folder";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const listing = z.object({ files: z.array(z.object({ id, mimeType: z.string().max(200) })).max(2),
  nextPageToken: z.string().optional(), incompleteSearch: z.boolean().optional() });
const metadata = z.object({
  id, size: z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).pipe(z.number().int().safe()),
  sha256Checksum: z.string().regex(/^[a-f0-9A-F]{64}$/).transform((value) => value.toLowerCase()).optional(),
  parents: z.array(id).max(1), name: z.string().max(255), trashed: z.literal(false),
  appProperties: z.object({ rpObject: z.string(), rpConnection: z.string() }),
});
const queryValue = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

function apiUrl(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(path, ORIGIN);
  url.search = new URLSearchParams(params).toString();
  return url;
}

/** A resumable session is protocol data, not authority to send bytes/auth to a new URL. */
function uploadSession(location: string | undefined, path: string): URL {
  try {
    if (!location || location.length > 4096 || /[\s\\]/.test(location)) throw dataError();
    const url = new URL(location);
    const sessions = url.searchParams.getAll("upload_id");
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname !== path ||
        sessions.length !== 1 || !/^[A-Za-z0-9_-]{1,2048}$/.test(sessions[0]!) ||
        Array.from(url.searchParams.keys()).some((key) => key !== "upload_id" && key !== "uploadType") ||
        url.searchParams.getAll("uploadType").some((mode) => mode !== "resumable")) throw dataError();
    return url;
  } catch { throw dataError(); }
}

export function googleDriveAdapter(request: StorageRequest): StorageAdapterDefinition<OAuthStorageConfig, OAuthStorageCredentials> {
  return {
    configSchema: oauthConfigSchema, credentialsSchema: oauthCredentialsSchema, purposes: ["order_files", "backups"],
    create({ publicId, config, credentials }) {
      const access = accessFor(request, "google_drive", { clientId: config.clientId, clientSecret: credentials.clientSecret }, credentials.refreshToken);
      const appPropertyKey = "rpObject";
      const objectKey = (parent: string, name: string) => createHash("sha256").update(JSON.stringify([publicId, parent, name])).digest("hex");
      async function api(url: URL, options: EgressFetchOptions = {}, fence?: () => Promise<void>, ambiguous = false) {
        const bearer = await access(options.signal);
        await fence?.();
        return dataRequest(request, ambiguous, !ambiguous)(url, { ...options, headers: { Authorization: `Bearer ${bearer}`, ...options.headers } });
      }
      const json = (data: unknown) => {
        const body = JSON.stringify(data);
        return { body, headers: { "Content-Type": "application/json; charset=UTF-8", "Content-Length": String(Buffer.byteLength(body)) } };
      };
      async function list(q: string, signal?: AbortSignal) {
        return parseResponse(await api(apiUrl("/drive/v3/files", { q, spaces: "drive", pageSize: "2",
          fields: "nextPageToken,incompleteSearch,files(id,mimeType)" }), { signal }), listing);
      }
      async function lookup(parent: string, name: string, signal?: AbortSignal) {
        const key = queryValue(objectKey(parent, name));
        const response = await list(`trashed = false and ${queryValue(parent)} in parents and name = ${queryValue(name)} and appProperties has { key='${appPropertyKey}' and value=${key} }`, signal);
        if (response.incompleteSearch || response.nextPageToken || response.files.length > 1) {
          throw new StorageAdapterError("DESTINATION_CONFLICT");
        }
        return response.files[0];
      }
      const properties = (parent: string, name: string) => ({
        [appPropertyKey]: objectKey(parent, name), rpConnection: publicId,
      });
      const folderCache = new Map<string, string>();
      async function resolveFolder(path: readonly string[], signal?: AbortSignal, fence?: () => Promise<void>) {
        let parent = "root";
        for (const name of pathParts({ ...config, rootPath: config.rootPath || "ReadyPackets" }, path)) {
          const cacheKey = objectKey(parent, name);
          const cached = folderCache.get(cacheKey);
          if (cached) { parent = cached; continue; }
          const existing = await lookup(parent, name, signal);
          if (existing && existing.mimeType !== FOLDER) throw dataError();
          if (existing) parent = existing.id;
          else {
            const created = parseResponse(await api(apiUrl("/drive/v3/files", { fields: "id,mimeType" }), {
              method: "POST", signal, ...json({ name, mimeType: FOLDER, parents: [parent], appProperties: properties(parent, name) }),
            }, fence, true), z.object({ id, mimeType: z.literal(FOLDER) }), [200, 201]);
            // Drive does not have a unique name constraint. Verify the newly created path is unambiguous.
            const check = await lookup(parent, name, signal);
            if (!check || check.id !== created.id || check.mimeType !== FOLDER) throw dataError();
            parent = created.id;
          }
          folderCache.set(cacheKey, parent);
        }
        return parent;
      }
      return {
        async test(signal) {
          try {
            const data = await list("trashed = false and 'root' in parents", signal);
            if (data.incompleteSearch) throw dataError();
            return { ok: true, code: "OK" };
          } catch (error) { return testResult(error); }
        },
        async ensureFolder(path, signal, beforeWrite) { await resolveFolder(path, signal, beforeWrite); },
        async put(input) {
          const name = safeObjectName(input.name);
          const parent = await resolveFolder(input.path, input.signal, input.beforeWrite);
          const existing = await lookup(parent, name, input.signal);
          if (existing?.mimeType === FOLDER) throw dataError();
          const mime = /^[\w!#$&^.+-]{1,60}\/[\w!#$&^.+-]{1,60}$/.test(input.contentType) ? input.contentType : "application/octet-stream";
          const path = `/upload/drive/v3/files${existing ? `/${existing.id}` : ""}`;
          const info = json(existing ? { name } : { name, mimeType: mime, parents: [parent], appProperties: properties(parent, name) });
          const initial = await api(apiUrl(path, { uploadType: "resumable", fields: "id,size,name,parents,sha256Checksum" }), {
            ...info, method: existing ? "PATCH" : "POST", signal: input.signal, headers: {
              ...info.headers, "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(input.size),
            },
          }, input.beforeWrite);
          if (initial.status !== 200 && initial.status !== 201) throw dataError(initial.status);
          const session = uploadSession(initial.headers.location, path);
          let offset = 0;
          let completedId: string | undefined;
          for await (const chunk of verifiedChunks(input, CHUNK)) {
            const next = offset + chunk.length;
            const rsp = await api(session, {
              method: "PUT", body: chunk, timeoutMs: 30_000, maxRequestBytes: CHUNK,
              signal: input.signal, acceptUploadIncomplete: true, headers: {
                "Content-Type": mime, "Content-Length": String(chunk.length),
                ...(input.size > CHUNK ? { "Content-Range": `bytes ${offset}-${next - 1}/${input.size}` } : {}),
              },
            }, input.beforeWrite, next === input.size && !existing);
            if (next < input.size) {
              if (rsp.status !== 308 || rsp.headers.location || rsp.headers.range !== `bytes=0-${next - 1}`) throw dataError(rsp.status);
            } else {
              try { completedId = parseResponse(rsp, z.object({ id }), [200, 201]).id; }
              catch (error) {
                if ((rsp.status === 200 || rsp.status === 201) && !existing) throw new StorageAdapterError("OUTCOME_UNKNOWN");
                throw error;
              }
            }
            offset = next;
          }
          if (!completedId || (existing && completedId !== existing.id)) throw integrityError();
          let observed: z.infer<typeof metadata>;
          try {
            observed = parseResponse(await api(apiUrl(`/drive/v3/files/${completedId}`,
              { fields: "id,size,name,parents,sha256Checksum,appProperties,trashed" }), { signal: input.signal }), metadata);
          } catch { throw new StorageAdapterError("OUTCOME_UNKNOWN"); }
          if (observed.id !== completedId || observed.size !== input.size || observed.name !== name || observed.parents[0] !== parent ||
              observed.appProperties.rpConnection !== publicId || observed.appProperties.rpObject !== objectKey(parent, name) ||
              (observed.sha256Checksum && observed.sha256Checksum !== input.sha256)) {
            throw integrityError();
          }
          return { remoteId: observed.id, size: observed.size, sha256: observed.sha256Checksum };
        },
        async remove(remoteId, signal) {
          if (!id.safeParse(remoteId).success) throw validation("STORAGE_REMOTE_ID_INVALID", "The storage object reference is invalid.");
          const path = `/drive/v3/files/${remoteId}`;
          const details = parseResponse(await api(apiUrl(path, { fields: "id,mimeType,appProperties" }), { signal }),
            z.object({ id, mimeType: z.string(), appProperties: z.object({ rpConnection: z.literal(publicId) }) }));
          if (details.id !== remoteId || details.mimeType === FOLDER) throw dataError(403);
          const rsp = await api(apiUrl(path), { method: "DELETE", signal });
          if (rsp.status !== 204) throw dataError(rsp.status);
        },
      };
    },
  };
}
