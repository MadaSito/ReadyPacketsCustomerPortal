import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { StorageAdapterError } from "../contracts.js";
import { SIMPLE_UPLOAD_MAX, UPLOAD_CHUNK, createGraphDriveAdapter, graphDriveDefinitions, graphDriveDiscovery, sharePointConfigSchema } from "./graphDrive.js";
import { FakeGraph } from "./graphDriveFake.js";
import { checkUploadUrl, parseSiteUrl } from "./graphDriveUrls.js";

const TENANT = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

function setup(overrides: Partial<{ rootFolderPath: string; secret: string }> = {}) {
  const graph = new FakeGraph();
  const config = { tenantId: TENANT, clientId: CLIENT, driveId: graph.libraryDrive.id, rootFolderPath: overrides.rootFolderPath ?? "Portal/Orders" };
  const adapter = createGraphDriveAdapter(graph, config, { clientSecret: overrides.secret ?? graph.validSecret });
  return { graph, adapter, config };
}

const putInput = (bytes: Buffer, name = "file.pdf", path = ["AvExample_CUST-1", "RP-1 Demo"]) => ({
  path,
  name,
  size: bytes.length,
  sha256: "0".repeat(64),
  contentType: "application/pdf",
  body: Readable.from([bytes]),
});

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageAdapterError);
  expect((error as StorageAdapterError).code).toBe(code);
  return error as StorageAdapterError;
}

describe("graph drive adapter (against the local Graph fake)", () => {
  it("validates config: site address must be a tenant SharePoint site; ids and paths bounded", () => {
    const base = { tenantId: TENANT, clientId: CLIENT, siteId: "", driveId: "", driveName: "", rootFolderPath: "" };
    expect(sharePointConfigSchema.safeParse({ ...base, siteUrl: "https://contoso.sharepoint.com/sites/Orders" }).success).toBe(true);
    expect(sharePointConfigSchema.safeParse({ ...base, siteUrl: "" }).success).toBe(true);
    for (const bad of ["http://contoso.sharepoint.com/sites/x", "https://evil.example/sites/x", "https://contoso-my.sharepoint.com/personal/x", "https://u:p@contoso.sharepoint.com/"]) {
      expect(sharePointConfigSchema.safeParse({ ...base, siteUrl: bad }).success).toBe(false);
    }
    expect(sharePointConfigSchema.safeParse({ ...base, siteUrl: "", tenantId: "common" }).success).toBe(false);
    expect(sharePointConfigSchema.safeParse({ ...base, siteUrl: "", rootFolderPath: "a/../b" }).success).toBe(false);
    expect(sharePointConfigSchema.safeParse({ ...base, siteUrl: "", extra: 1 }).success).toBe(false);
    expect(parseSiteUrl("https://contoso.sharepoint.com/sites/Orders/Shared%20Documents/Forms/AllItems.aspx")).toEqual({ hostname: "contoso.sharepoint.com", serverRelativePath: "sites/Orders" });
  });

  it("guards upload-session URLs by tenant host lineage", () => {
    expect(checkUploadUrl("https://contoso.sharepoint.com/_api/x?token=1", "contoso")).not.toBeNull();
    expect(checkUploadUrl("https://contoso-my.sharepoint.com/_api/x", "contoso")).not.toBeNull();
    for (const bad of [
      "https://fabrikam.sharepoint.com/_api/x",
      "http://contoso.sharepoint.com/_api/x",
      "https://contoso.sharepoint.com:8443/_api/x",
      "https://user@contoso.sharepoint.com/_api/x",
      "https://contoso.sharepoint.com.evil.example/x",
      "https://169.254.169.254/latest",
      42,
    ]) {
      expect(checkUploadUrl(bad, "contoso")).toBeNull();
    }
  });

  it("tests the connection with fixed codes", async () => {
    const { adapter, graph } = setup({ rootFolderPath: "" });
    expect(await adapter.test()).toEqual({ ok: true, code: "OK" });
    expect(await setup({ rootFolderPath: "Missing" }).adapter.test()).toEqual({ ok: false, code: "DESTINATION_NOT_FOUND" });
    expect(await setup({ secret: "wrong" }).adapter.test()).toEqual({ ok: false, code: "AUTH_FAILED" });
    expect(await createGraphDriveAdapter(graph, { tenantId: "", clientId: CLIENT, driveId: "x", rootFolderPath: "" }, {}).test()).toEqual({ ok: false, code: "NOT_CONFIGURED" });
    graph.intercept(() => ({ status: 403, headers: {}, body: { error: { message: "secret detail" } } }));
    expect(await adapter.test()).toEqual({ ok: false, code: "DESTINATION_DENIED" });
    graph.clearInterceptors();
    graph.intercept(() => "throw");
    expect(await adapter.test()).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });
  });

  it("creates folders idempotently and uploads a small file, verifying size and QuickXorHash", async () => {
    const { adapter, graph } = setup();
    await adapter.ensureFolder(["AvExample_CUST-1"]);
    await adapter.ensureFolder(["AvExample_CUST-1"]);
    const bytes = randomBytes(1000);
    let writes = 0;
    const result = await adapter.put({ ...putInput(bytes), beforeWrite: async () => void writes++ });
    expect(result).toMatchObject({ size: 1000, verifiedTransportDigest: "quickxor" });
    expect(result.sha256).toBeUndefined();
    const stored = graph.findByPath(graph.libraryDrive, ["Portal", "Orders", "AvExample_CUST-1", "RP-1 Demo", "file.pdf"]);
    expect(stored?.content?.equals(bytes)).toBe(true);
    expect(stored?.id).toBe(result.remoteId);
    // One new folder ("RP-1 Demo"; the customer folder already existed) plus the content PUT, each fenced
    // twice: by the adapter before the call and by the transport after token acquisition, right before sending.
    expect(writes).toBe(4);
  });

  it("re-running an identical put returns the existing item; a different object under the same name conflicts", async () => {
    const { adapter } = setup();
    const bytes = randomBytes(2048);
    const first = await adapter.put(putInput(bytes));
    const again = await adapter.put(putInput(bytes));
    expect(again.remoteId).toBe(first.remoteId);
    await rejectsWith(adapter.put(putInput(randomBytes(2048))), "DESTINATION_CONFLICT");
    await rejectsWith(adapter.put(putInput(randomBytes(10))), "DESTINATION_CONFLICT");
  });

  it("uses a chunked upload session for large files without forwarding the bearer token", async () => {
    const { adapter, graph } = setup();
    const bytes = randomBytes(UPLOAD_CHUNK + 12345);
    expect(bytes.length).toBeGreaterThan(SIMPLE_UPLOAD_MAX);
    const result = await adapter.put(putInput(bytes, "big.bin"));
    expect(result.size).toBe(bytes.length);
    const uploads = graph.calls.filter((c) => c.kind === "upload");
    expect(uploads).toHaveLength(2);
    expect(uploads.every((c) => !c.authorized)).toBe(true);
    expect(graph.findByPath(graph.libraryDrive, ["Portal", "Orders", "AvExample_CUST-1", "RP-1 Demo", "big.bin"])?.content?.equals(bytes)).toBe(true);
  });

  it("uploads small files through a single-chunk session when the transport cannot send raw bytes", async () => {
    const { adapter, graph } = setup();
    graph.supportsRawBody = false;
    const bytes = randomBytes(5000);
    const result = await adapter.put(putInput(bytes, "small.bin"));
    expect(result).toMatchObject({ size: 5000, verifiedTransportDigest: "quickxor" });
    expect(graph.calls.filter((c) => c.kind === "upload" && c.method === "PUT")).toHaveLength(1);
    await rejectsWith(adapter.put(putInput(Buffer.alloc(0), "empty.bin")), "INVALID_INPUT");
  });

  it("propagates a fence loss during chunk upload unchanged and cancels the session", async () => {
    const { adapter, graph } = setup();
    await adapter.ensureFolder(["AvExample_CUST-1", "RP-1 Demo"]);
    // Fence calls: session pre-check 1, session in-transport 2, chunk 1: 3/4, chunk 2: 5 (adapter) / 6 (transport).
    for (const [i, failAt] of [5, 6].entries()) {
      let n = 0;
      const loseOnSecondChunk = async () => {
        if (++n === failAt) throw new Error("lease lost");
      };
      const before = graph.calls.filter((c) => c.kind === "upload" && c.method === "PUT").length;
      await expect(adapter.put({ ...putInput(randomBytes(UPLOAD_CHUNK * 2 + 1), `fenced${i}.bin`), beforeWrite: loseOnSecondChunk })).rejects.toThrow("lease lost");
      expect(graph.calls.filter((c) => c.kind === "upload" && c.method === "PUT").length - before).toBe(1);
      expect(graph.sessions.size).toBe(0);
    }
  });

  it("refuses an upload-session URL outside the tenant lineage before sending bytes", async () => {
    const { adapter, graph } = setup();
    graph.uploadHost = "attacker.example";
    await rejectsWith(adapter.put(putInput(randomBytes(SIMPLE_UPLOAD_MAX + 1), "big.bin")), "DESTINATION_DENIED");
    expect(graph.calls.some((c) => c.kind === "upload")).toBe(false);
    graph.uploadHost = "fabrikam.sharepoint.com";
    await rejectsWith(adapter.put(putInput(randomBytes(SIMPLE_UPLOAD_MAX + 1), "big2.bin")), "DESTINATION_DENIED");
    expect(graph.calls.some((c) => c.kind === "upload")).toBe(false);
  });

  it("resumes a chunk after a transient failure and cancels the session on a permanent one", async () => {
    const { adapter, graph } = setup();
    let failed = false;
    graph.intercept(({ kind, method }) => {
      if (kind === "upload" && method === "PUT" && !failed) {
        failed = true;
        return { status: 503, headers: {}, body: null };
      }
      return undefined;
    });
    const bytes = randomBytes(UPLOAD_CHUNK + 5);
    expect((await adapter.put(putInput(bytes, "resumed.bin"))).size).toBe(bytes.length);
    graph.clearInterceptors();
    graph.intercept(({ kind, method }) => (kind === "upload" && method === "PUT" ? { status: 400, headers: {}, body: null } : undefined));
    await rejectsWith(adapter.put(putInput(randomBytes(UPLOAD_CHUNK + 5), "bad.bin")), "INVALID_INPUT");
    expect(graph.calls.filter((c) => c.kind === "upload" && c.method === "DELETE")).toHaveLength(1);
    expect(graph.sessions.size).toBe(0);
  });

  it("stops before any write when the fence is lost, and cancels an open session", async () => {
    const { adapter, graph } = setup();
    const lost = async () => {
      throw new Error("lease lost");
    };
    // The fence error propagates unchanged so the job layer can recognise lease loss.
    await expect(adapter.put({ ...putInput(randomBytes(10)), beforeWrite: lost })).rejects.toThrow("lease lost");
    expect(graph.calls.some((c) => c.method === "POST" || c.method === "PUT")).toBe(false);
    let n = 0;
    const lateLoss = async () => {
      if (++n > 4) throw new Error("lease lost");
    };
    await expect(adapter.put({ ...putInput(randomBytes(UPLOAD_CHUNK * 2 + 1), "late.bin"), beforeWrite: lateLoss })).rejects.toThrow("lease lost");
    expect(graph.sessions.size).toBe(0);
  });

  it("detects provider-side corruption, size mismatch and missing hashes", async () => {
    const { adapter, graph } = setup();
    graph.corruptUploads = true;
    await rejectsWith(adapter.put(putInput(randomBytes(100), "c1.bin")), "INTEGRITY_MISMATCH");
    await rejectsWith(adapter.put(putInput(randomBytes(UPLOAD_CHUNK + 1), "c2.bin")), "INTEGRITY_MISMATCH");
    graph.corruptUploads = false;
    graph.reportHashes = false;
    expect((await adapter.put(putInput(randomBytes(100), "c3.bin"))).verifiedTransportDigest).toBe("quickxor");
    const short = { ...putInput(randomBytes(100), "short.bin"), size: 200 };
    await rejectsWith(adapter.put(short), "INVALID_INPUT");
  });

  it("refuses unsafe names and paths", async () => {
    const { adapter, graph } = setup();
    for (const [path, name] of [[[".."], "x"], [["a/b"], "x"], [["ok"], "../x"], [["ok"], "a:b"], [["ok"], ""], [["ok"], "x\u202e"]] as const) {
      await rejectsWith(adapter.put(putInput(Buffer.from("x"), name, [...path])), "INVALID_INPUT");
    }
    expect(graph.calls).toHaveLength(0);
  });

  it("removes only by validated remote id", async () => {
    const { adapter, graph } = setup();
    const { remoteId } = await adapter.put(putInput(randomBytes(10)));
    await adapter.remove(remoteId);
    await adapter.remove(remoteId); // already gone: no error
    await rejectsWith(adapter.remove("../../x"), "INVALID_INPUT");
    expect(graph.findByPath(graph.libraryDrive, ["Portal", "Orders", "AvExample_CUST-1", "RP-1 Demo", "file.pdf"])).toBeNull();
  });

  it("discovers a site, its document libraries, a OneDrive and folders", async () => {
    const graph = new FakeGraph();
    const d = graphDriveDiscovery(graph);
    const cfg = { tenantId: TENANT, clientId: CLIENT };
    const creds = { clientSecret: graph.validSecret };
    const site = await d.discoverSite(cfg, creds, "https://contoso.sharepoint.com/sites/Orders");
    expect(site).toEqual({ siteId: graph.site.id, displayName: "Orders", webUrl: "https://contoso.sharepoint.com/sites/Orders" });
    await rejectsWith(d.discoverSite(cfg, creds, "https://contoso.sharepoint.com/sites/Nope"), "DESTINATION_NOT_FOUND");
    await rejectsWith(d.discoverSite(cfg, creds, "https://evil.example/"), "INVALID_INPUT");
    await rejectsWith(d.discoverSite(cfg, null, "https://contoso.sharepoint.com/sites/Orders"), "NOT_CONFIGURED");
    expect((await d.listDrives(cfg, creds, site.siteId)).drives).toEqual([{ driveId: graph.libraryDrive.id, name: "Documents", driveType: "documentLibrary" }]);
    expect(await d.resolveOneDrive(cfg, creds, "ops@contoso.example.test")).toMatchObject({ driveName: "OneDrive" });
    const adapter = createGraphDriveAdapter(graph, { ...cfg, driveId: graph.libraryDrive.id, rootFolderPath: "" }, creds);
    await adapter.ensureFolder(["Portal"]);
    const listed = await d.listFolders(cfg, creds, { driveId: graph.libraryDrive.id, parentItemId: null, cursor: null });
    expect(listed.folders.map((f) => f.name)).toEqual(["Portal"]);
    await rejectsWith(d.listFolders(cfg, creds, { driveId: "../x", parentItemId: null, cursor: null }), "INVALID_INPUT");
  });

  it("registers sharepoint (incl. order_data) and onedrive definitions", () => {
    const defs = graphDriveDefinitions(new FakeGraph());
    expect(defs.sharepoint.purposes).toContain("order_data");
    expect(defs.onedrive.purposes).not.toContain("order_data");
    expect(defs.sharepoint.credentialsSchema.safeParse({ clientSecret: "" }).success).toBe(false);
  });
});
