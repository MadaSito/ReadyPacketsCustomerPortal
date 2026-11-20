/**
 * Safe one-line secret reader shared by the operator scripts (create-admin, seed-demo).
 *
 * Reads through a single descriptor (no check-then-open race): the file must be a regular file owned by the
 * invoking user (or root), not readable/writable by group or others (mode & 0o077 == 0), and 1..1024 bytes.
 * Exactly one trailing newline (LF or CRLF) is removed — any other whitespace is part of the secret.
 * Neither the path nor the content is ever printed; failures throw a fixed, content-free error.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export class UnsafeSecretFileError extends Error {
  constructor() {
    super("unsafe secret file");
    this.name = "UnsafeSecretFileError";
  }
}

export const SECRET_FILE_MAX_BYTES = 1024;

export function readSecretFile(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    throw new UnsafeSecretFileError();
  }
  try {
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (stat.uid !== uid && stat.uid !== 0) ||
      stat.size === 0 ||
      stat.size > SECRET_FILE_MAX_BYTES
    ) {
      throw new UnsafeSecretFileError();
    }
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    const value = buffer.subarray(0, read).toString("utf8").replace(/\r?\n$/, "");
    buffer.fill(0);
    if (value.length === 0) throw new UnsafeSecretFileError();
    return value;
  } finally {
    closeSync(fd);
  }
}
