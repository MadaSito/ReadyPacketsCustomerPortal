import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRegularFileNoFollow } from "./archiveFile.js";

describe("openRegularFileNoFollow", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rp-archive-file-"));
    await writeFile(path.join(dir, "archive.rpbk"), "archive-bytes");
    await symlink(path.join(dir, "archive.rpbk"), path.join(dir, "link.rpbk"));
    await mkdir(path.join(dir, "folder"));
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a handle on the regular file it inspected", async () => {
    const handle = await openRegularFileNoFollow(path.join(dir, "archive.rpbk"), "refused");
    try {
      expect(await handle.readFile("utf8")).toBe("archive-bytes");
    } finally {
      await handle.close();
    }
  });

  it.each([
    ["a symbolic link", "link.rpbk"],
    ["a missing path", "absent.rpbk"],
    ["a directory", "folder"],
    ["a named pipe, without waiting for a writer", "pipe"],
    ["a path below a regular file", "archive.rpbk/child"],
  ])("refuses %s", async (_label, name) => {
    await expect(openRegularFileNoFollow(path.join(dir, name), "refused")).rejects.toMatchObject({
      reasonCode: "INVALID_ARCHIVE_PATH",
    });
  });
});
