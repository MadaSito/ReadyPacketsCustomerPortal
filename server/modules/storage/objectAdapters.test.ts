import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../core/errors.js";
import type { EgressPolicy } from "../integrations/egress.js";
import { azureBlobAdapter, azureBlobConfig, azureBlobCredentials } from "./adapters/azureBlob.js";
import { s3Adapter, s3Config, s3Credentials, s3Origin, signS3 } from "./adapters/s3.js";

const publicId = "01JSTORAGE0000000000000000".replace("O", "0");
const clock = { now: () => new Date("2026-11-20T12:00:00Z") };
const bytes = Buffer.from("synthetic verified object");
const hash = (name: string) => createHash(name).update(bytes);
const s3Secret = s3Credentials.parse({ accessKeyId: "fake_app_access_id", secretAccessKey: "synthetic_secret_for_protocol_fake" });
const azureSecret = azureBlobCredentials.parse({ accountKey: Buffer.alloc(64, 7).toString("base64") });
const request = (extra: Record<string, unknown> = {}) => ({
  path: ["Résumé & Plans"], name: "synthetic quote!.bin", size: bytes.length, contentType: "application/octet-stream",
  sha256: hash("sha256").digest("hex"), body: Readable.from([bytes]), ...extra,
});
const response = (status: number, headers: Record<string, string> = {}) => ({ status, headers, body: Buffer.alloc(0) });

describe("S3 adapter through a pinned transport fake", () => {
  it("matches Amazon's public SigV4 GET example", () => {
    const signed = signS3({
      method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), region: "us-east-1",
      credentials: { accessKeyId: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
        secretAccessKey: ["wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"].join("") },
      date: new Date("2013-05-24T00:00:00.000Z"), payloadHash: createHash("sha256").digest("hex"),
      headers: { range: "bytes=0-9" },
    });
    expect(signed.authorization).toContain("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("selects the provider hostname and rejects custom endpoint credentials, paths and private-looking literals", () => {
    const config = { bucket: "private-copy", region: "us-east-1" };
    expect(s3Origin(s3Config.parse({ ...config, preset: "aws" }))).toBe("https://s3.us-east-1.amazonaws.com");
    expect(s3Origin(s3Config.parse({ ...config, preset: "wasabi" }))).toBe("https://s3.us-east-1.wasabisys.com");
    expect(s3Origin(s3Config.parse({ ...config, preset: "backblaze", region: "us-west-004" }))).toBe("https://s3.us-west-004.backblazeb2.com");
    for (const endpoint of ["http://s3.example.test", "https://s3.example.test:9000", "https://s3.example.test/root",
      "https://s3.example.test?sig=value", "https://s3.example.test/#value", "https://name@s3.example.test",
      "https://127.1", "https://[::1]", "https://s3.example.test\\@elsewhere.example.test"]) {
      expect(s3Config.safeParse({ ...config, preset: "custom", endpoint }).success, endpoint).toBe(false);
    }
    expect(s3Config.safeParse({ ...config, preset: "custom", endpoint: "https://s3.example.test", prefix: "one/../two" }).success).toBe(false);
  });

  it("encodes exactly one object key, signs the PUT, and verifies a genuine provider digest plus size", async () => {
    const beforeWrite = vi.fn(async () => {});
    const putHeaders = { etag: '"synthetic-1"', "x-amz-checksum-sha256": hash("sha256").digest("base64") };
    let written = false;
    const fetchPinned: EgressPolicy["fetchPinned"] = vi.fn(async (raw, purpose, options) => {
      const url = new URL(raw);
      expect(purpose).toBe("storage_s3");
      expect(options).toMatchObject({ publicAddressesOnly: true, requireAllowlistRule: true });
      expect(url.host).toBe("s3.us-east-1.amazonaws.com");
      if (url.pathname === "/private-copy") return response(200);
      expect(url.pathname).toBe("/private-copy/pre/R%C3%A9sum%C3%A9%20%26%20Plans/synthetic%20quote%21.bin");
      if (options?.method === "HEAD") return written ? response(200, { ...putHeaders, "content-length": String(bytes.length) }) : response(404);
      expect(options?.method).toBe("PUT");
      expect(beforeWrite).toHaveBeenCalledOnce();
      expect(options.headers).toMatchObject({ "x-amz-checksum-sha256": putHeaders["x-amz-checksum-sha256"],
        "x-amz-content-sha256": hash("sha256").digest("hex"), "if-none-match": "*" });
      expect(options.headers?.authorization).toContain("/us-east-1/s3/aws4_request");
      expect(await buffer(options.body as Readable)).toEqual(bytes);
      written = true;
      return response(200, putHeaders);
    });
    const adapter = s3Adapter(() => ({ fetchPinned }), clock).create({ publicId, credentials: s3Secret,
      config: s3Config.parse({ preset: "aws", region: "us-east-1", bucket: "private-copy", prefix: "pre" }) });
    await expect(adapter.test()).resolves.toEqual({ ok: true, code: "OK" });
    await expect(adapter.put({ ...request(), beforeWrite })).resolves.toEqual({
      remoteId: "pre/Résumé & Plans/synthetic quote!.bin", size: bytes.length, sha256: hash("sha256").digest("hex"),
    });
    await expect(adapter.put(request())).resolves.toMatchObject({ sha256: hash("sha256").digest("hex") });
    await expect(adapter.remove("unrelated/removable.bin")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("does not follow destination redirects or write on a lost fence", async () => {
    const fetchPinned: EgressPolicy["fetchPinned"] = vi.fn(async () => response(404));
    const adapter = s3Adapter(() => ({ fetchPinned }), clock).create({ publicId, credentials: s3Secret,
      config: s3Config.parse({ preset: "custom", region: "test-region", bucket: "private-copy", endpoint: "https://s3.example.test" }) });
    const beforeWrite = async () => { throw new Error("lease lost"); };
    await expect(adapter.put({ ...request(), beforeWrite })).rejects.toThrow("lease lost");
    expect(fetchPinned).toHaveBeenCalledOnce();
    const redirected: EgressPolicy["fetchPinned"] = async () => {
      throw new DomainError("UNAVAILABLE", "EGRESS_REDIRECT_REFUSED", "No redirect.");
    };
    const blocked = s3Adapter(() => ({ fetchPinned: redirected }), clock).create({ publicId, credentials: s3Secret,
      config: { preset: "aws", region: "us-east-1", bucket: "private-copy" } });
    await expect(blocked.test()).resolves.toEqual({ ok: false, code: "EGRESS_DENIED" });
  });
});

describe("Azure Blob adapter through a pinned transport fake", () => {
  const cfg = azureBlobConfig.parse({ account: "testaccount", container: "private-archive", auth: "shared_key" });
  const syntheticSignature = encodeURIComponent(Buffer.alloc(32, 249).toString("base64"));
  const sas = `sv=2023-11-03&spr=https&sr=c&sp=rc&se=2030-01-01T12%3A00%3A00Z&sig=${syntheticSignature}`;

  it("accepts only a scoped HTTPS SAS and never uses it on any other hostname", async () => {
    const credentials = azureBlobCredentials.parse({ sasToken: `?${sas}` });
    for (const token of [sas.replace("spr=https", "spr=https%2Chttp"), `${sas}&sig=duplicate`, `${sas}&comp=delete`,
      sas.replace("sr=c", "sr=b"), `https://testaccount.blob.core.windows.net/private-archive?${sas}`]) {
      expect(azureBlobCredentials.safeParse({ sasToken: token }).success).toBe(false);
    }
    const fetchPinned: EgressPolicy["fetchPinned"] = vi.fn(async (raw, purpose, options) => {
      const url = new URL(raw);
      expect(url.origin).toBe("https://testaccount.blob.core.windows.net");
      expect(url.search).toBe(`?restype=container&${sas}`);
      expect(purpose).toBe("storage_azure");
      expect(options?.headers?.authorization).toBeUndefined();
      return response(200);
    });
    const adapter = azureBlobAdapter(() => ({ fetchPinned }), clock)
      .create({ publicId, credentials, config: { ...cfg, auth: "sas" } });
    await expect(adapter.test()).resolves.toEqual({ ok: true, code: "OK" });
  });

  it("uses Shared Key and checks stored size and provider MD5 without calling it SHA-256", async () => {
    const etag = '"synthetic-etag"';
    const md5 = hash("md5").digest("base64");
    let observedDigest = md5;
    const fetchPinned: EgressPolicy["fetchPinned"] = vi.fn(async (raw, purpose, options) => {
      expect(purpose).toBe("storage_azure");
      expect(new URL(raw).search).toBe("");
      expect(options).toMatchObject({ publicAddressesOnly: true, requireAllowlistRule: true });
      expect(options?.headers?.authorization).toMatch(/^SharedKey testaccount:[A-Za-z0-9+/]{43}=$/u);
      if (options?.method === "PUT") {
        expect(options.headers).toMatchObject({ "if-none-match": "*", "x-ms-blob-type": "BlockBlob" });
        expect(await buffer(options.body as Readable)).toEqual(bytes);
        return response(201, { etag });
      }
      expect(options?.headers?.["if-match"]).toBe(etag);
      return response(200, { etag, "content-length": String(bytes.length), "content-md5": observedDigest });
    });
    const adapter = azureBlobAdapter(() => ({ fetchPinned }), clock).create({ publicId, credentials: azureSecret, config: cfg });
    await expect(adapter.put(request())).resolves.toStrictEqual({
      remoteId: "Résumé & Plans/synthetic quote!.bin", size: bytes.length, verifiedTransportDigest: "md5",
    });
    observedDigest = Buffer.alloc(16).toString("base64");
    await expect(adapter.put(request())).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });
});
