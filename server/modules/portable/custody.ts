import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FieldCrypto, ObjectStorage, StoredObjectInfo } from "../../core/types.js";

export class CustodyError extends Error {
  constructor() { super("PORTABLE_CUSTODY_MISMATCH"); }
}

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Canonical JSON: package-owned object keys are sorted; arrays preserve reviewed ordering. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new CustodyError();
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== undefined);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
}

export async function inPrivateWorkspace<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "rp-portable-"));
  try { return await fn(root); }
  finally {
    // Cleanup errors cannot override a committed business result; an operator must handle crash/orphan spools.
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function matchBytes(actual: { size: number; sha256: string }, expected: { size: number; sha256: string }): void {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new CustodyError();
}

/** Read actual bytes, not a metadata checksum. Fast refusal happens before passing anything to a consumer. */
export async function copyExact(
  storage: ObjectStorage,
  key: string,
  path: string,
  expected: { size: number; sha256: string },
) {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > expected.size) callback(new CustodyError());
      else { hash.update(chunk); callback(null, chunk); }
    },
  });
  await pipeline(await storage.get(key), meter, createWriteStream(path, { mode: 0o600, flags: "wx" }));
  matchBytes({ size, sha256: hash.digest("hex") }, expected);
}

export async function readExactObject(storage: ObjectStorage, expected: StoredObjectInfo): Promise<void> {
  const source = await storage.get(expected.key);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > expected.size) throw new CustodyError();
    hash.update(chunk);
  }
  matchBytes({ size, sha256: hash.digest("hex") }, expected);
}

/** Copy only authenticated ciphertext from a sealed workspace into private storage. */
export async function storeValidated(
  storage: ObjectStorage,
  key: string,
  path: string,
  expected: { size: number; sha256: string },
) {
  const info = await storage.put(key, createReadStream(path), { maxBytes: expected.size });
  matchBytes(info, expected);
  return info;
}

/**
 * Local escrow is separate from the portable package and never uses its passphrase.
 * Stream framing is local only: 12-byte nonce, encrypted bytes, then 16-byte GCM tag.
 * Each object binds its immutable import ID, content digest and length. The independent
 * portable reader verified the plaintext once; the local decryptor also checks those bytes
 * before the storage adapter atomically admits the prepared object.
 */
export function newEscrowKey(crypto: FieldCrypto, importId: string) {
  const key = randomBytes(32);
  try { return crypto.encrypt(key.toString("base64"), `portable.import.escrow:${importId}`); }
  finally { key.fill(0); }
}

function openEscrowKey(crypto: FieldCrypto, protectedKey: string, importId: string) {
  const decoded = Buffer.from(crypto.decrypt(protectedKey, `portable.import.escrow:${importId}`), "base64");
  if (decoded.length !== 32) { decoded.fill(0); throw new CustodyError(); }
  return decoded;
}

export function encryptEscrow(source: AsyncIterable<Buffer>, crypto: FieldCrypto, protectedKey: string, importId: string,
  expected: { sha256: string; size: number }) {
  return Readable.from((async function* () {
    const key = openEscrowKey(crypto, protectedKey, importId);
    const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(canonical([importId, expected.sha256, expected.size])));
      yield nonce;
      let size = 0;
      const hash = createHash("sha256");
      for await (const chunk of source) {
        size += chunk.length;
        if (size > expected.size) throw new CustodyError();
        hash.update(chunk);
        yield cipher.update(chunk);
      }
      matchBytes({ size, sha256: hash.digest("hex") }, expected);
      yield cipher.final();
      yield cipher.getAuthTag();
    } finally { key.fill(0); }
  })(), { objectMode: false });
}

export function decryptEscrow(source: AsyncIterable<Buffer>, crypto: FieldCrypto, protectedKey: string, importId: string,
  expected: { sha256: string; size: number; ciphertextSha256: string }) {
  return Readable.from((async function* () {
    const key = openEscrowKey(crypto, protectedKey, importId);
    const encryptedHash = createHash("sha256");
    const hash = createHash("sha256");
    let pending = Buffer.alloc(0);
    let decipher: ReturnType<typeof createDecipheriv> & { setAuthTag(tag: Buffer): void; setAAD(aad: Buffer): void } | undefined;
    let size = 0;
    let encryptedSize = 0;
    try {
      for await (const chunk of source) {
        encryptedSize += chunk.length;
        if (encryptedSize > expected.size + 28) throw new CustodyError();
        encryptedHash.update(chunk);
        pending = Buffer.concat([pending, chunk]);
        if (!decipher && pending.length >= 12) {
          decipher = createDecipheriv("aes-256-gcm", key, pending.subarray(0, 12));
          decipher.setAAD(Buffer.from(canonical([importId, expected.sha256, expected.size])));
          pending = pending.subarray(12);
        }
        if (decipher && pending.length > 16) {
          const bytes = decipher.update(pending.subarray(0, -16));
          hash.update(bytes);
          size += bytes.length;
          pending = pending.subarray(-16);
          if (bytes.length) yield bytes;
        }
      }
      if (!decipher || pending.length !== 16) throw new CustodyError();
      decipher.setAuthTag(pending);
      const end = decipher.final();
      hash.update(end);
      matchBytes({ size: size + end.length, sha256: hash.digest("hex") }, expected);
      matchBytes({ size: encryptedSize, sha256: encryptedHash.digest("hex") },
        { size: expected.size + 28, sha256: expected.ciphertextSha256 });
      if (end.length) yield end;
    } finally { key.fill(0); }
  })(), { objectMode: false });
}
