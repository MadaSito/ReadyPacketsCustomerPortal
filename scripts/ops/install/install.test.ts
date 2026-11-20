import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertNoSecretsInArgv } from "../backup/_runtime.js";

const execFileAsync = promisify(execFile);
const INSTALL_DIR = path.resolve(import.meta.dirname);

async function makeReleaseTarball(workDir: string, releaseId: string): Promise<{ archivePath: string; sha256: string }> {
  const srcDir = path.join(workDir, `src-${releaseId}`);
  await mkdir(path.join(srcDir, "dist", "server"), { recursive: true });
  await writeFile(path.join(srcDir, "dist", "server", "main.js"), `// synthetic release ${releaseId}\n`, "utf8");
  await writeFile(path.join(srcDir, "RELEASE"), `${releaseId}\n`, "utf8");

  const archivePath = path.join(workDir, `readypackets-${releaseId}.tar.gz`);
  await execFileAsync("tar", ["-czf", archivePath, "-C", srcDir, "."]);
  const bytes = await readFile(archivePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { archivePath, sha256 };
}

async function runScript(scriptName: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const res = await execFileAsync("bash", [path.join(INSTALL_DIR, scriptName), ...args], {
      timeout: 15_000,
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("VPS install / upgrade / rollback scripts & CLI secret guards", () => {
  it("refuses secret flags on CLI argv", () => {
    expect(() => assertNoSecretsInArgv(["--trigger", "cli"])).not.toThrow();
    expect(() => assertNoSecretsInArgv(["--password=synthetic"])).toThrow();
    expect(() => assertNoSecretsInArgv(["--backup-key", "synthetic"])).toThrow();
    expect(() => assertNoSecretsInArgv(["--database-url=mysql://example.test/rp"])).toThrow();
  });

  it("refuses checksum mismatch, world-readable env files, and command substitution without executing shell code", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "rp-install-sec-"));
    try {
      const root = path.join(work, "rootfs");
      await mkdir(path.join(root, "etc", "readypackets"), { recursive: true });
      const envFile = path.join(root, "etc", "readypackets", "portal.env");
      const markerFile = path.join(work, "must-never-exist");

      const rel = await makeReleaseTarball(work, "v1.0.0");

      // 1. Tampered SHA-256 refused before touching config.
      await writeFile(envFile, "NODE_ENV=production\n", { mode: 0o600 });
      const badSha = await runScript("install-vps.sh", [
        "--archive",
        rel.archivePath,
        "--sha256",
        "0".repeat(64),
        "--release-id",
        "v1.0.0",
        "--root",
        root,
        "--sandbox-mode",
      ]);
      expect(badSha.code).toBe(65);

      // 2. World-readable 0644 env file refused.
      await chmod(envFile, 0o644);
      const badMode = await runScript("install-vps.sh", [
        "--archive",
        rel.archivePath,
        "--sha256",
        rel.sha256,
        "--release-id",
        "v1.0.0",
        "--root",
        root,
        "--sandbox-mode",
      ]);
      expect(badMode.code).toBe(78);

      // 3. Command substitution in env file is rejected as data and NEVER executed.
      await writeFile(envFile, `RP_SERVICE_NAME=$(touch ${markerFile})\n`, "utf8");
      await chmod(envFile, 0o600);
      const cmdSub = await runScript("install-vps.sh", [
        "--archive",
        rel.archivePath,
        "--sha256",
        rel.sha256,
        "--release-id",
        "v1.0.0",
        "--root",
        root,
        "--sandbox-mode",
      ]);
      expect(cmdSub.code).toBe(78);
      await expect(stat(markerFile)).rejects.toThrow();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("performs idempotent install, pre-upgrade backup gating, automatic health-failure rollback, and explicit rollback", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "rp-install-flow-"));
    try {
      const root = path.join(work, "rootfs");
      await mkdir(path.join(root, "etc", "readypackets"), { recursive: true });
      const storageDir = path.join(root, "var", "lib", "readypackets", "storage");
      const sandboxDir = path.join(root, "var", "lib", "readypackets-recovery");
      const envFile = path.join(root, "etc", "readypackets", "portal.env");
      await writeFile(
        envFile,
        `NODE_ENV=production\nRP_STORAGE_DIR="${storageDir}"\nRP_RECOVERY_SANDBOX_DIR="${sandboxDir}"\n`,
        { mode: 0o600 },
      );
      await chmod(envFile, 0o600);

      const v1 = await makeReleaseTarball(work, "2026.11.1");
      const v2 = await makeReleaseTarball(work, "2026.11.2");
      const v3 = await makeReleaseTarball(work, "2026.11.3");

      // Initial install + idempotent re-run.
      for (let run = 0; run < 2; run += 1) {
        const res = await runScript("install-vps.sh", [
          "--archive",
          v1.archivePath,
          "--sha256",
          v1.sha256,
          "--release-id",
          "2026.11.1",
          "--root",
          root,
          "--sandbox-mode",
        ]);
        expect(res.code).toBe(0);
      }

      const currentLink = path.join(root, "opt", "readypackets", "current");
      expect(await readlink(currentLink)).toContain("2026.11.1");
      const storageStat = await stat(storageDir);
      expect(storageStat.mode & 0o777).toBe(0o700);

      // Failing pre-upgrade backup aborts upgrade BEFORE flipping symlink.
      const failHook = path.join(work, "fail-hook.sh");
      const passHook = path.join(work, "pass-hook.sh");
      await writeFile(failHook, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
      await writeFile(passHook, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
      await chmod(failHook, 0o700);
      await chmod(passHook, 0o700);

      const abortedUpgrade = await runScript("upgrade-vps.sh", [
        "--archive",
        v2.archivePath,
        "--sha256",
        v2.sha256,
        "--release-id",
        "2026.11.2",
        "--root",
        root,
        "--sandbox-mode",
        "--sandbox-backup-cmd",
        failHook,
      ]);
      expect(abortedUpgrade.code).toBe(75);
      expect(await readlink(currentLink)).toContain("2026.11.1");

      // Healthy upgrade flips current -> 2026.11.2 and records previous -> 2026.11.1.
      const okUpgrade = await runScript("upgrade-vps.sh", [
        "--archive",
        v2.archivePath,
        "--sha256",
        v2.sha256,
        "--release-id",
        "2026.11.2",
        "--root",
        root,
        "--sandbox-mode",
        "--sandbox-backup-cmd",
        passHook,
        "--sandbox-health-cmd",
        passHook,
      ]);
      expect(okUpgrade.code).toBe(0);
      expect(await readlink(currentLink)).toContain("2026.11.2");

      // Post-switch health failure automatically rolls code symlink back to 2026.11.2!
      const badHealthUpgrade = await runScript("upgrade-vps.sh", [
        "--archive",
        v3.archivePath,
        "--sha256",
        v3.sha256,
        "--release-id",
        "2026.11.3",
        "--root",
        root,
        "--sandbox-mode",
        "--sandbox-backup-cmd",
        passHook,
        "--sandbox-health-cmd",
        failHook,
      ]);
      expect(badHealthUpgrade.code).toBe(70);
      expect(badHealthUpgrade.stderr).toContain("forward-only DB migrations are NOT reversed automatically");
      expect(await readlink(currentLink)).toContain("2026.11.2");

      // Explicit rollback-vps.sh to 2026.11.1.
      const manualRollback = await runScript("rollback-vps.sh", [
        "--root",
        root,
        "--to-release",
        "2026.11.1",
        "--sandbox-mode",
      ]);
      expect(manualRollback.code).toBe(0);
      expect(await readlink(currentLink)).toContain("2026.11.1");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
