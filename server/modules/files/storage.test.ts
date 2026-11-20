import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { silentLogger } from "../../../tests/helpers/fakes.js";
import { createObjectStorage, type LocalObjectStorage } from "./storage.js";

let root: string;
let storageDir: string;
let storage: LocalObjectStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rp-storage-"));
  storageDir = join(root, "private");
  storage = createObjectStorage({ config: { storageDir }, logger: silentLogger });
});
afterEach(() => rm(root, { recursive: true, force: true }));

it("writes restrictively, hashes, atomically moves, ranges, and deletes private bytes", async () => {
  const staging = storage.newKey("staging");
  const file = storage.newKey("files");
  const data = Buffer.from("synthetic");
  const sha256 = createHash("sha256").update(data).digest("hex");
  expect(await storage.put(staging, Readable.from([data.subarray(0, 4), data.subarray(4)]))).toEqual({ key: staging, size: 9, sha256 });
  expect((await lstat(storageDir)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(storageDir, staging))).mode & 0o777).toBe(0o600);
  await expect(storage.put(staging, Buffer.from("other"))).rejects.toMatchObject({ reasonCode: "OBJECT_EXISTS" });
  await storage.move(staging, file);
  expect(await storage.stat(staging)).toBeNull();
  expect(await storage.stat(file)).toEqual({ key: file, size: 9, sha256 });
  expect((await buffer(await storage.get(file, { start: 2, end: 5 }))).toString()).toBe("nthe");
  await expect(storage.get(file, { start: 0, end: 9 })).rejects.toMatchObject({ reasonCode: "INVALID_FILE_RANGE" });
  await storage.delete(file);
  expect(await storage.stat(file)).toBeNull();
});

it("abandons over-limit and interrupted streams without leaving public or temporary objects", async () => {
  const tooLarge = storage.newKey("staging");
  await expect(storage.put(tooLarge, Readable.from([Buffer.alloc(3), Buffer.alloc(4)]), { maxBytes: 6 }))
    .rejects.toMatchObject({ reasonCode: "FILE_TOO_LARGE" });
  const aborted = storage.newKey("staging");
  const started = Buffer.alloc(3);
  const broken = new Readable({
    read() {
      this.push(started);
      this.destroy(new Error("synthetic read interruption"));
    },
  });
  await expect(storage.put(aborted, broken)).rejects.toThrow("synthetic read interruption");
  expect(await readdir(join(storageDir, "staging"))).toEqual([]);
});

it("rejects traversal, malformed keys, symlink namespaces and linked leaves", async () => {
  for (const invalid of ["../outside", "/files/" + "a".repeat(32), `files/${"a".repeat(32)}\n`, `files\\${"a".repeat(32)}`]) {
    await expect(storage.stat(invalid)).rejects.toMatchObject({ reasonCode: "INVALID_OBJECT_KEY" });
  }
  await storage.checkRoot();
  await symlink(root, join(storageDir, "exports"), "dir");
  await expect(storage.put(storage.newKey("exports"), Buffer.from("synthetic"))).rejects.toThrow();
  const genuine = storage.newKey("files");
  const linked = storage.newKey("files");
  const foreign = join(root, "foreign");
  await storage.put(genuine, Buffer.from("synthetic"));
  await writeFile(foreign, "unchanged", { mode: 0o600 });
  await link(foreign, join(storageDir, linked));
  await expect(storage.get(linked)).rejects.toMatchObject({ reasonCode: "STORAGE_UNSAFE" });
  await expect(storage.delete(linked)).rejects.toMatchObject({ reasonCode: "STORAGE_UNSAFE" });
  const throughLink = storage.newKey("files");
  await symlink(foreign, join(storageDir, throughLink));
  await expect(storage.get(throughLink)).rejects.toThrow();
  await expect(storage.move(throughLink, storage.newKey("files"))).rejects.toThrow();
  await expect(storage.delete(throughLink)).rejects.toThrow();
});
