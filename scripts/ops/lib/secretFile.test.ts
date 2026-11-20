import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSecretFile, UnsafeSecretFileError } from "./secretFile.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rp-secret-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function file(name: string, content: string | Buffer, mode = 0o600) {
  const path = join(dir, name);
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

describe("readSecretFile", () => {
  it("returns the content with exactly one trailing newline removed", async () => {
    expect(readSecretFile(await file("a", "  pass phrase \n\n"))).toBe("  pass phrase \n");
    expect(readSecretFile(await file("b", "secret\r\n"))).toBe("secret");
  });

  it("refuses group/other-accessible, empty, oversized, missing and non-regular files without echoing them", async () => {
    for (const path of [
      await file("c", "secret", 0o640),
      await file("d", "secret", 0o604),
      await file("e", ""),
      await file("f", "\n"),
      await file("g", Buffer.alloc(1025, 0x61)),
      join(dir, "missing"),
      dir,
    ]) {
      expect(() => readSecretFile(path)).toThrow(UnsafeSecretFileError);
      try {
        readSecretFile(path);
      } catch (error) {
        expect((error as Error).message).toBe("unsafe secret file");
      }
    }
  });
});
