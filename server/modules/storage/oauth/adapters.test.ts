import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { EgressFetchResponse } from "../../integrations/egress.js";
import { dropboxAdapter } from "../adapters/dropbox.js";
import { googleDriveAdapter } from "../adapters/googleDrive.js";
import type { StoragePutInput } from "../contracts.js";
import type { StorageRequest } from "./provider.js";

const CHUNK = 8 * 1024 * 1024;
const BLOCK = CHUNK / 2;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const validGrant = { token_type: "bearer", access_token: "local-fake-access", expires_in: 3_600 };
const config = { clientId: "synthetic-app" };
const credentials = { clientSecret: "local-fake-secret", refreshToken: "local-fake-refresh" };
const publicId = "01KFZZZZZZZZZZZZZZZZZZZZZZ";
const answer = (status: number, body: unknown = {}, headers = {}): EgressFetchResponse =>
  ({ status, headers, body: Buffer.from(JSON.stringify(body)) });
const fenced = (request: StorageRequest): StorageRequest => async (url, options) => {
  await options?.beforeSend?.();
  return request(url, options);
};

function file(data: Buffer, overrides: Partial<StoragePutInput> = {}): StoragePutInput {
  return { path: [], name: "café.pdf", size: data.length, sha256: sha(data), contentType: "application/pdf",
    body: Readable.from([data.subarray(0, 5), data.subarray(5)]), ...overrides };
}

function dropboxHash(data: Buffer): string {
  const hash = createHash("sha256");
  for (let i = 0; i < data.length; i += BLOCK) hash.update(Buffer.from(sha(data.subarray(i, i + BLOCK)), "hex"));
  return hash.digest("hex");
}

describe("Dropbox protocol fake", () => {
  it("refreshes, creates Unicode paths without renaming, verifies content hash, and checks the write fence", async () => {
    const body = Buffer.from("local fake file");
    const fence = vi.fn(async () => {});
    const request = vi.fn<StorageRequest>().mockImplementation(async (target, opts) => {
      const url = new URL(target);
      if (url.pathname === "/oauth2/token") {
        expect(new URLSearchParams(opts?.body as string).get("refresh_token")).toBe(credentials.refreshToken);
        return answer(200, validGrant);
      }
      expect(opts?.headers?.Authorization).toBe("Bearer local-fake-access");
      if (url.pathname === "/2/files/list_folder") return answer(200, { entries: [] });
      if (url.pathname === "/2/files/create_folder_v2") return answer(409);
      if (url.pathname === "/2/files/get_metadata") return answer(200, { ".tag": "folder" });
      if (url.pathname === "/2/files/upload") {
        expect(opts?.headers?.["Dropbox-API-Arg"]).toContain("\\u00e9");
        expect(JSON.parse(opts!.headers!["Dropbox-API-Arg"]!)).toMatchObject({ path: "/Reports/café.pdf", autorename: false });
        expect(opts?.body).toEqual(body);
        return answer(200, { id: "id:fake_file", size: body.length, content_hash: dropboxHash(body) });
      }
      throw new Error("Unexpected fake Dropbox request");
    });
    const adapter = dropboxAdapter(fenced(request)).create({ publicId, config: { ...config, rootPath: "Reports" }, credentials });
    await expect(adapter.test()).resolves.toEqual({ ok: true, code: "OK" });
    await adapter.ensureFolder([], undefined, fence);
    await expect(adapter.put(file(body, { beforeWrite: fence }))).resolves.toEqual({ remoteId: "id:fake_file", size: body.length });
    expect(fence).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/oauth2/token"))).toHaveLength(1);
    await expect(adapter.put(file(body, { beforeWrite: async () => { throw new Error("lost fence"); } }))).rejects.toThrow("lost fence");
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/files/upload"))).toHaveLength(1);
  });

  it("uses bounded chunks and does not commit or report a false checksum", async () => {
    const body = Buffer.alloc(CHUNK + 3, "x");
    const request = vi.fn<StorageRequest>().mockImplementation(async (target, opts) => {
      const url = new URL(target);
      if (url.pathname === "/oauth2/token") return answer(200, validGrant);
      if (url.pathname.endsWith("/start")) {
        expect((opts?.body as Buffer).length).toBe(CHUNK);
        return answer(200, { session_id: "synthetic-upload" });
      }
      if (url.pathname.endsWith("/append_v2")) {
        expect((opts?.body as Buffer).length).toBe(3);
        expect(JSON.parse(opts!.headers!["Dropbox-API-Arg"]!).cursor.offset).toBe(CHUNK);
        return answer(200);
      }
      if (url.pathname.endsWith("/finish")) return answer(200, { id: "id:fake", size: body.length, content_hash: "0".repeat(64) });
      throw new Error("Unexpected fake Dropbox request");
    });
    const adapter = dropboxAdapter(fenced(request)).create({ publicId, config, credentials });
    await expect(adapter.put(file(body, { sha256: "0".repeat(64) }))).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/finish"))).toBe(false);
    await expect(adapter.put(file(body))).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/finish"))).toBe(true);
  });
});

describe("Google Drive protocol fake", () => {
  function drive(data: Buffer, location = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=local", mismatch = false) {
    let properties: unknown;
    const desiredKey = createHash("sha256").update(JSON.stringify([publicId, "root", "ReadyPackets"])).digest("hex");
    const request = vi.fn<StorageRequest>().mockImplementation(async (target, opts) => {
      const url = new URL(target);
      if (url.hostname === "oauth2.googleapis.com") return answer(200, validGrant);
      expect(url.hostname).toBe("www.googleapis.com");
      expect(opts?.headers?.Authorization).toBe("Bearer local-fake-access");
      if (url.pathname === "/drive/v3/about") return answer(200, { user: { permissionId: "account-fake" } });
      if (url.pathname === "/drive/v3/files/fake_folder") return answer(200, {
        id: "fake_folder", name: "ReadyPackets", mimeType: "application/vnd.google-apps.folder", parents: ["fake_root"],
        appProperties: { rpObject: desiredKey, rpConnection: publicId }, trashed: false,
      });
      if (url.pathname === "/drive/v3/files" && opts?.method !== "POST") {
        const q = url.searchParams.get("q")!;
        const files = q.includes("'ReadyPackets'") ? [{ id: "fake_folder", mimeType: "application/vnd.google-apps.folder" }] : [];
        return answer(200, { files });
      }
      if (url.pathname === "/upload/drive/v3/files" && opts?.method === "POST") {
        properties = JSON.parse(opts.body as string).appProperties;
        return answer(200, {}, { location });
      }
      if (url.pathname === "/upload/drive/v3/files" && opts?.method === "PUT") {
        expect(opts.acceptUploadIncomplete).toBe(true);
        if (opts.headers?.["Content-Range"] === `bytes 0-${CHUNK - 1}/${data.length}`) {
          return answer(308, {}, { range: `bytes=0-${CHUNK - 1}` });
        }
        expect(opts.headers?.["Content-Range"]).toBe(data.length > CHUNK ? `bytes ${CHUNK}-${data.length - 1}/${data.length}` : undefined);
        return answer(201, { id: "fake_object" });
      }
      if (url.pathname === "/drive/v3/files/fake_object" && opts?.method === "DELETE") return answer(204);
      if (url.pathname === "/drive/v3/files/fake_object") return answer(200, {
        id: "fake_object", name: "café.pdf", size: String(data.length), parents: [mismatch ? "other_parent" : "fake_folder"],
        sha256Checksum: sha(data), appProperties: properties, trashed: false, mimeType: "application/pdf",
      });
      throw new Error("Unexpected fake Google Drive request");
    });
    return { request, adapter: googleDriveAdapter(fenced(request), async (_, generate) => generate()).create({ publicId, config, credentials }) };
  }

  it("uses the app-created root, checks range acknowledgements and fetches independent integrity metadata", async () => {
    const data = Buffer.alloc(CHUNK + 3, "y");
    const f = drive(data);
    const fence = vi.fn(async () => {});
    await expect(f.adapter.put(file(data, { beforeWrite: fence }))).resolves.toEqual({
      remoteId: "fake_object", size: data.length, sha256: sha(data),
    });
    expect(fence).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.filter(([, opts]) => opts?.method === "PUT")).toHaveLength(2);
    await f.adapter.remove("fake_object");
    expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  it("does not follow a supplied non-provider resumable URL and rejects mismatched metadata", async () => {
    const data = Buffer.from("synthetic content");
    const a = drive(data, "https://example.test/upload/drive/v3/files?upload_id=sensitive");
    await expect(a.adapter.put(file(data))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(a.request.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);
    const b = drive(data, undefined, true);
    await expect(b.adapter.put(file(data))).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });
});
