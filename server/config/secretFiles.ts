/**
 * Secret-file loading for `<NAME>_FILE` variables. Owner: platform engineer.
 *
 * Secret files are DATA: read as UTF-8 text, trimmed, never sourced or executed. A file is accepted only if
 * it is a regular file (after resolving symlinks), at most 64 KiB, owned by the service user or root, not
 * writable by group/others and not readable by others (0600 / 0640 / 0400 / 0440).
 * Failures are reported by variable name and rule only — never the path contents.
 */
import { closeSync, fstatSync, openSync, readSync, constants as fsConstants } from "node:fs";

export const MAX_SECRET_FILE_BYTES = 64 * 1024;

export type SecretFileRule =
  | "file is unreadable or missing"
  | "file must be a regular file"
  | "file is larger than 64 KiB"
  | "file permissions are too broad (must not be group/other writable or other readable)"
  | "file must be owned by the service user or root"
  | "file is empty";

export class SecretFileError extends Error {
  constructor(
    public readonly variable: string,
    public readonly rule: SecretFileRule,
  ) {
    super(`${variable}: ${rule}`);
    this.name = "SecretFileError";
  }
}

export interface SecretFileOptions {
  /** Process uid (injectable for tests). `undefined` on platforms without uids skips the owner check. */
  uid?: number;
}

/** Reads a protected secret file. Throws SecretFileError (never includes the content). */
export function readSecretFile(variable: string, path: string, options: SecretFileOptions = {}): string {
  let fd: number;
  try {
    // O_NOFOLLOW is intentionally not used: systemd credentials / container secrets are often symlinked.
    // fstat on the opened descriptor checks the object actually read (no TOCTOU between stat and read).
    fd = openSync(path, fsConstants.O_RDONLY);
  } catch {
    throw new SecretFileError(variable, "file is unreadable or missing");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SecretFileError(variable, "file must be a regular file");
    if (stat.size > MAX_SECRET_FILE_BYTES) throw new SecretFileError(variable, "file is larger than 64 KiB");
    if ((stat.mode & 0o022) !== 0 || (stat.mode & 0o004) !== 0) {
      throw new SecretFileError(variable, "file permissions are too broad (must not be group/other writable or other readable)");
    }
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid !== undefined && stat.uid !== uid && stat.uid !== 0) {
      throw new SecretFileError(variable, "file must be owned by the service user or root");
    }
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_SECRET_FILE_BYTES) + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_SECRET_FILE_BYTES) throw new SecretFileError(variable, "file is larger than 64 KiB");
      if (total === buffer.length) break;
    }
    const value = buffer.subarray(0, total).toString("utf8").trim();
    buffer.fill(0);
    if (value.length === 0) throw new SecretFileError(variable, "file is empty");
    return value;
  } finally {
    closeSync(fd);
  }
}
