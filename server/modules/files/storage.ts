import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, rename, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { AppConfig } from "../../config/env.js";
import { conflict, DomainError, validation } from "../../core/errors.js";
import type { Logger, ObjectStorage } from "../../core/types.js";

const namespaces = ["files", "staging", "exports", "backups", "quarantine"] as const;
const keyPattern = /^(files|staging|exports|backups|quarantine)\/([0-9a-f]{32})$/;
// Staging is also used by portable transfers. The reserved upload partition retains 120 random
// bits and is issued only by this adapter's upload-specific generator, never from request data.
const uploadPartition = "f1";
const uploadOwnedLeaf = /^(?:\.partial-)?f1[0-9a-f]{30}$/u;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface LocalObjectStorage extends ObjectStorage {
  newUploadKey(): string;
  checkRoot(): Promise<void>;
  sweepStaging(before: Date, signal?: AbortSignal): Promise<number>;
  inspect<T>(key: string, inspect: (read: (offset: number, length: number) => Promise<Buffer>, size: number) => Promise<T>): Promise<T>;
  withConversionDirectory<T>(work: (path: string) => Promise<T>): Promise<T>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function safeCustody() {
  return new DomainError("UNAVAILABLE", "STORAGE_UNSAFE", "Private storage is unavailable.");
}

function fdPath(handle: FileHandle, name?: string): string {
  const base = `/proc/self/fd/${handle.fd}`;
  return name === undefined ? base : `${base}/${name}`;
}

function parseKey(key: string): [string, string] {
  const match = keyPattern.exec(key);
  if (!match || match[0] !== key) throw validation("INVALID_OBJECT_KEY", "The object reference is invalid.");
  return [match[1]!, match[2]!];
}

async function privateDirectory(handle: FileHandle) {
  const stat = await handle.stat();
  if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) throw safeCustody();
}

async function ensureDirectory(parent: FileHandle, name: string, create: boolean): Promise<FileHandle> {
  const next = fdPath(parent, name);
  if (create) {
    try {
      await mkdir(next, { mode: 0o700 });
      await parent.sync();
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
  return open(next, directoryFlags);
}

async function openRegular(path: string): Promise<FileHandle> {
  const handle = await open(path, readFlags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o600) {
      throw safeCustody();
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function createObjectStorage({ config, logger }: { config: Pick<AppConfig, "storageDir">; logger: Logger }): LocalObjectStorage {
  const root = resolve(config.storageDir);
  if (!isAbsolute(config.storageDir) || root === sep || process.platform !== "linux") throw safeCustody();
  // All traversal below uses already-open directory descriptors. The private leaf and namespaces reject
  // non-owner access, special modes, and symlinks. Parent directories are never rewritten.
  const parts = root.split(sep).filter(Boolean);
  const busyKeys = new Set<string>();

  async function openRoot(): Promise<FileHandle> {
    let current = await open(sep, directoryFlags);
    try {
      for (const [index, part] of parts.entries()) {
        const child = await ensureDirectory(current, part, index === parts.length - 1);
        await current.close();
        current = child;
      }
      await privateDirectory(current);
      return current;
    } catch (error) {
      await current.close();
      throw error;
    }
  }

  async function namespace(name: string): Promise<FileHandle> {
    const rootHandle = await openRoot();
    try {
      const directory = await ensureDirectory(rootHandle, name, true);
      try {
        await privateDirectory(directory);
        return directory;
      } catch (error) {
        await directory.close();
        throw error;
      }
    } finally {
      await rootHandle.close();
    }
  }

  async function locked<T>(keys: string[], work: () => Promise<T>): Promise<T> {
    if (keys.some((key) => busyKeys.has(key))) throw conflict("OBJECT_BUSY", "The storage object is busy.");
    for (const key of keys) busyKeys.add(key);
    try {
      return await work();
    } finally {
      for (const key of keys) busyKeys.delete(key);
    }
  }

  async function absent(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    throw conflict("OBJECT_EXISTS", "The storage object already exists.");
  }

  async function cleanupPartial(path: string) {
    try {
      await unlink(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) logger.error("Private storage temporary cleanup failed");
    }
  }

  return {
    async withConversionDirectory(work) {
      const parent = await namespace("quarantine");
      let path: string | undefined;
      try {
        path = await mkdtemp(fdPath(parent, "audio-"));
        const directory = await open(path, directoryFlags);
        try {
          await privateDirectory(directory);
          return await work(`/proc/${process.pid}/fd/${directory.fd}`);
        } finally { await directory.close(); }
      } finally {
        if (path) await rm(path, { recursive: true, force: true }).catch(() => logger.warn("Audio quarantine cleanup failed"));
        await parent.close();
      }
    },
    newKey(name) {
      if (!namespaces.includes(name)) throw validation("INVALID_OBJECT_NAMESPACE", "The object namespace is invalid.");
      let leaf: string;
      do { leaf = randomBytes(16).toString("hex"); } while (name === "staging" && leaf.startsWith(uploadPartition));
      return `${name}/${leaf}`;
    },
    newUploadKey() {
      return `staging/${uploadPartition}${randomBytes(15).toString("hex")}`;
    },
    async checkRoot() {
      const fd = await openRoot();
      await fd.close();
    },
    async put(key, body, options) {
      const [name, leaf] = parseKey(key);
      const maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw validation("INVALID_FILE_LIMIT", "The file limit is invalid.");
      return locked([key], async () => {
        const dir = await namespace(name);
        const target = fdPath(dir, leaf);
        const partialName = `.partial-${leaf}`;
        const temporary = fdPath(dir, partialName);
        let handle: FileHandle | undefined;
        let ownTemporary = false;
        busyKeys.add(`${name}/${partialName}`);
        try {
          await absent(target);
          handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          ownTemporary = true;
          let size = 0;
          const hash = createHash("sha256");
          for await (const raw of Buffer.isBuffer(body) ? Readable.from([body]) : body) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
            if (size + chunk.length > maxBytes) throw validation("FILE_TOO_LARGE", "The file exceeds the allowed size.");
            hash.update(chunk);
            let cursor = 0;
            while (cursor < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, cursor, chunk.length - cursor, size + cursor);
              if (bytesWritten === 0) throw safeCustody();
              cursor += bytesWritten;
            }
            size += cursor;
          }
          await handle.sync();
          await handle.close();
          handle = undefined;
          await absent(target);
          await rename(temporary, target);
          await dir.sync();
          return { key, size, sha256: hash.digest("hex") };
        } finally {
          await handle?.close().catch(() => logger.error("Private storage descriptor close failed"));
          if (ownTemporary) await cleanupPartial(temporary);
          busyKeys.delete(`${name}/${partialName}`);
          await dir.close();
        }
      });
    },
    async inspect(key, inspect) {
      const [name, leaf] = parseKey(key);
      const dir = await namespace(name);
      const file = await openRegular(fdPath(dir, leaf)).finally(() => dir.close());
      try {
        const { size } = await file.stat();
        return await inspect(async (offset, length) => {
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
              length > 32768 || offset + length > size) throw validation("INVALID_FILE_RANGE", "The requested byte range is invalid.");
          const buf = Buffer.alloc(length);
          let done = 0;
          while (done < length) {
            const { bytesRead } = await file.read(buf, done, length - done, offset + done);
            if (bytesRead === 0) throw safeCustody();
            done += bytesRead;
          }
          return buf;
        }, size);
      } finally {
        await file.close();
      }
    },
    async get(key, range) {
      const [name, leaf] = parseKey(key);
      const dir = await namespace(name);
      const file = await openRegular(fdPath(dir, leaf)).finally(() => dir.close());
      try {
        if (range) {
          const { size } = await file.stat();
          if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
              range.start < 0 || range.end < range.start || range.end >= size) {
            throw validation("INVALID_FILE_RANGE", "The requested byte range is invalid.");
          }
        }
        return file.createReadStream(range);
      } catch (error) {
        await file.close();
        throw error;
      }
    },
    async stat(key) {
      const [name, leaf] = parseKey(key);
      const dir = await namespace(name);
      try {
        const file = await openRegular(fdPath(dir, leaf));
        const original = await file.stat().catch(async (error: unknown) => {
          await file.close();
          throw error;
        });
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of file.createReadStream() as AsyncIterable<Buffer>) {
          hash.update(chunk);
          size += chunk.length;
        }
        if (original.size !== size) throw safeCustody();
        return { key, size, sha256: hash.digest("hex") };
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      } finally {
        await dir.close();
      }
    },
    async delete(key) {
      const [name, leaf] = parseKey(key);
      await locked([key], async () => {
        const dir = await namespace(name);
        try {
          const path = fdPath(dir, leaf);
          const file = await openRegular(path);
          try {
            await unlink(path);
            await dir.sync();
          } finally {
            await file.close();
          }
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        } finally {
          await dir.close();
        }
      });
    },
    async move(fromKey, toKey) {
      const [fromName, fromLeaf] = parseKey(fromKey);
      const [toName, toLeaf] = parseKey(toKey);
      await locked([fromKey, toKey], async () => {
        const from = await namespace(fromName);
        try {
          const to = await namespace(toName);
          try {
            const source = fdPath(from, fromLeaf);
            const destination = fdPath(to, toLeaf);
            const file = await openRegular(source);
            try {
              await absent(destination);
              await rename(source, destination);
              await to.sync();
              if (fromName !== toName) await from.sync();
            } finally {
              await file.close();
            }
          } finally {
            await to.close();
          }
        } finally {
          await from.close();
        }
      });
    },
    async sweepStaging(before, signal) {
      const directory = await namespace("staging");
      let removed = 0;
      try {
        for await (const entry of await opendir(fdPath(directory))) {
          signal?.throwIfAborted();
          const leaf = entry.name;
          if (!entry.isFile() || !uploadOwnedLeaf.test(leaf)) continue;
          if (busyKeys.has(`staging/${leaf}`)) continue;
          const path = fdPath(directory, leaf);
          try {
            const file = await openRegular(path);
            try {
              const stat = await file.stat();
              if (stat.mtimeMs >= before.getTime() || stat.ctimeMs >= before.getTime()) continue;
              await unlink(path);
              removed++;
            } finally {
              await file.close();
            }
          } catch (error) {
            if (!isErrno(error, "ENOENT")) logger.warn("Refused unsafe staging cleanup entry");
          }
          if (removed >= 1000) break;
        }
        if (removed) await directory.sync();
        return removed;
      } finally {
        await directory.close();
      }
    },
  };
}
