/**
 * RPBK0001 — Streamed, chunk-authenticated AES-256-GCM backup envelope.
 *
 * Wire format:
 *   [8B]  Magic "RPBK0001"
 *   [4B]  Header byte length (uint32 BE, 1..4096)
 *   [NB]  Canonical JSON header (UTF-8)
 *   Repeated chunks (seq = 0, 1, 2, ...):
 *     [1B]  flags (0x00 = data chunk, 0x01 = final chunk)
 *     [4B]  plaintextLen (uint32 BE, 0..chunkSize)
 *     [PB]  AES-256-GCM ciphertext (PB === plaintextLen)
 *     [16B] GCM authentication tag
 *
 * Cryptographic properties:
 *  - Fresh 32-byte salt and 8-byte nonce prefix per archive.
 *  - Per-archive 32-byte DEK derived via HKDF-SHA256 (raw 32B key) or scrypt(N=32768,r=8,p=1) + HKDF-SHA256 (passphrase),
 *    bound to `rp.backup.envelope/1:<backupPublicId>`.
 *  - Per-chunk 12-byte nonce = `noncePrefix (8B) || seq (uint32 BE)`.
 *  - Per-chunk AAD = `RPBK0001 (8B) || sha256(headerBytes) (32B) || seq (4B BE) || flags (1B) || plaintextLen (4B BE)`.
 *  - Detects bit flips in header or ciphertext, chunk reordering/omission, truncation (missing 0x01 final chunk),
 *    trailing bytes after final chunk, and backupPublicId substitution.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { CryptoError } from "../../core/errors.js";
import type { BackupKeyMaterial, ResolvedBackupKeyring } from "./keys.js";

export const RPBK_MAGIC = Buffer.from("RPBK0001", "ascii");
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const GCM_TAG_BYTES = 16;
const FLAG_DATA = 0x00;
const FLAG_FINAL = 0x01;

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const envelopeHeaderSchema = z
  .object({
    format: z.literal("rp.backup.envelope/1"),
    backupPublicId: z.string().min(10).max(64),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    kdf: z.enum(["hkdf-sha256", "scrypt"]),
    kdfParams: z
      .object({
        N: z.literal(32768),
        r: z.literal(8),
        p: z.literal(1),
      })
      .strict()
      .optional(),
    salt: z.string().min(40).max(48),
    noncePrefix: z.string().min(10).max(16),
    chunkSize: z.number().int().min(1024).max(MAX_CHUNK_SIZE),
  })
  .strict();

export type BackupEnvelopeHeader = z.infer<typeof envelopeHeaderSchema>;

function scryptAsync(passphrase: string, salt: Buffer, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      Buffer.from(passphrase, "utf8"),
      salt,
      keyLen,
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_MAXMEM },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

async function deriveArchiveDek(
  keyMaterial: BackupKeyMaterial,
  salt: Buffer,
  backupPublicId: string,
  expectedKdf?: "hkdf-sha256" | "scrypt",
): Promise<{ dek: Buffer; kdf: "hkdf-sha256" | "scrypt" }> {
  const info = Buffer.from(`rp.backup.envelope/1:${backupPublicId}`, "utf8");
  if (keyMaterial.kind === "raw") {
    if (expectedKdf && expectedKdf !== "hkdf-sha256") {
      throw new CryptoError("MALFORMED");
    }
    const dek = Buffer.from(hkdfSync("sha256", keyMaterial.rawKey, salt, info, 32));
    return { dek, kdf: "hkdf-sha256" };
  }
  if (expectedKdf && expectedKdf !== "scrypt") {
    throw new CryptoError("MALFORMED");
  }
  const master = await scryptAsync(keyMaterial.passphrase, salt, 32);
  const dek = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
  master.fill(0);
  return { dek, kdf: "scrypt" };
}

function buildChunkNonce(noncePrefix: Buffer, seq: number): Buffer {
  const nonce = Buffer.allocUnsafe(12);
  noncePrefix.copy(nonce, 0, 0, 8);
  nonce.writeUInt32BE(seq >>> 0, 8);
  return nonce;
}

function buildChunkAad(headerSha256: Buffer, seq: number, flags: number, plaintextLen: number): Buffer {
  const aad = Buffer.allocUnsafe(8 + 32 + 4 + 1 + 4);
  RPBK_MAGIC.copy(aad, 0);
  headerSha256.copy(aad, 8);
  aad.writeUInt32BE(seq >>> 0, 40);
  aad.writeUInt8(flags, 44);
  aad.writeUInt32BE(plaintextLen >>> 0, 45);
  return aad;
}

function encryptChunk(
  dek: Buffer,
  noncePrefix: Buffer,
  headerSha256: Buffer,
  seq: number,
  flags: number,
  plaintext: Buffer,
): Buffer {
  const nonce = buildChunkNonce(noncePrefix, seq);
  const aad = buildChunkAad(headerSha256, seq, flags, plaintext.length);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ct1 = cipher.update(plaintext);
  const ct2 = cipher.final();
  const tag = cipher.getAuthTag();

  const frame = Buffer.allocUnsafe(5 + ct1.length + ct2.length + GCM_TAG_BYTES);
  frame.writeUInt8(flags, 0);
  frame.writeUInt32BE(plaintext.length, 1);
  ct1.copy(frame, 5);
  ct2.copy(frame, 5 + ct1.length);
  tag.copy(frame, 5 + ct1.length + ct2.length);
  return frame;
}

export interface EncryptedStreamHandle {
  stream: Readable;
  stats(): { encryptedBytes: number; archiveSha256: string; chunks: number };
}

/**
 * Encrypts an arbitrary plaintext stream into an `RPBK0001` authenticated stream.
 */
export function encryptBackupStream(
  plaintextSource: AsyncIterable<Buffer> | Readable,
  options: {
    backupPublicId: string;
    keyMaterial: BackupKeyMaterial;
    chunkSize?: number;
  },
): EncryptedStreamHandle {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  let encryptedBytes = 0;
  let chunks = 0;
  let finalizedDigest: string | null = null;
  const outerHash = createHash("sha256");

  function recordOut(buf: Buffer): Buffer {
    encryptedBytes += buf.length;
    outerHash.update(buf);
    return buf;
  }

  async function* generate(): AsyncGenerator<Buffer> {
    const salt = randomBytes(32);
    const noncePrefix = randomBytes(8);
    const { dek, kdf } = await deriveArchiveDek(options.keyMaterial, salt, options.backupPublicId);
    try {
      const headerObj: BackupEnvelopeHeader = {
        format: "rp.backup.envelope/1",
        backupPublicId: options.backupPublicId,
        keyId: options.keyMaterial.keyId,
        kdf,
        ...(kdf === "scrypt" ? { kdfParams: SCRYPT_PARAMS } : {}),
        salt: salt.toString("base64"),
        noncePrefix: noncePrefix.toString("base64"),
        chunkSize,
      };
      const headerBytes = Buffer.from(JSON.stringify(headerObj), "utf8");
      const headerSha256 = createHash("sha256").update(headerBytes).digest();

      const preamble = Buffer.allocUnsafe(8 + 4 + headerBytes.length);
      RPBK_MAGIC.copy(preamble, 0);
      preamble.writeUInt32BE(headerBytes.length, 8);
      headerBytes.copy(preamble, 12);
      yield recordOut(preamble);

      let seq = 0;
      let pending: Buffer = Buffer.alloc(0);

      for await (const rawPiece of plaintextSource as AsyncIterable<Buffer | string>) {
        const piece = Buffer.isBuffer(rawPiece) ? rawPiece : Buffer.from(rawPiece);
        if (piece.length === 0) continue;
        pending = pending.length === 0 ? piece : Buffer.concat([pending, piece]);

        // Keep at least 1 byte buffered so we can mark the true final chunk with FLAG_FINAL.
        while (pending.length > chunkSize) {
          const slice = pending.subarray(0, chunkSize);
          pending = pending.subarray(chunkSize);
          if (seq >= 0xffffffff) throw new Error("BACKUP_STREAM_TOO_MANY_CHUNKS");
          const frame = encryptChunk(dek, noncePrefix, headerSha256, seq, FLAG_DATA, slice);
          seq += 1;
          chunks += 1;
          yield recordOut(frame);
        }
      }

      // Emit the final chunk (may be 0..chunkSize bytes if input was empty or exact multiple).
      const finalFrame = encryptChunk(dek, noncePrefix, headerSha256, seq, FLAG_FINAL, pending);
      chunks += 1;
      yield recordOut(finalFrame);
      finalizedDigest = outerHash.digest("hex");
    } finally {
      dek.fill(0);
    }
  }

  return {
    stream: Readable.from(generate()),
    stats() {
      if (finalizedDigest === null) {
        throw new Error("Encrypted stream has not completed.");
      }
      return { encryptedBytes, archiveSha256: finalizedDigest, chunks };
    },
  };
}

/** Byte accumulator for deterministic framing reads across arbitrary stream chunk boundaries. */
class ByteQueue {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(buf: Buffer): void {
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.buffered += buf.length;
  }

  get length(): number {
    return this.buffered;
  }

  peek(count: number): Buffer {
    if (this.buffered < count) throw new Error("BYTE_QUEUE_UNDERFLOW");
    if (this.chunks[0]!.length >= count) {
      return this.chunks[0]!.subarray(0, count);
    }
    const merged = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [merged];
    return merged.subarray(0, count);
  }

  consume(count: number): Buffer {
    if (this.buffered < count) throw new Error("BYTE_QUEUE_UNDERFLOW");
    if (count === 0) return Buffer.alloc(0);
    if (this.chunks[0]!.length === count) {
      const exact = this.chunks.shift()!;
      this.buffered -= count;
      return exact;
    }
    if (this.chunks[0]!.length > count) {
      const head = this.chunks[0]!.subarray(0, count);
      this.chunks[0] = this.chunks[0]!.subarray(count);
      this.buffered -= count;
      return head;
    }
    const merged = Buffer.concat(this.chunks, this.buffered);
    const out = merged.subarray(0, count);
    const rest = merged.subarray(count);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }
}

export interface DecryptedBackupStats {
  header: BackupEnvelopeHeader;
  authenticatedBytes: number;
  encryptedBytes: number;
  archiveSha256: string;
  chunksVerified: number;
}

/**
 * Authenticates and decrypts an `RPBK0001` stream chunk-by-chunk.
 * Throws `CryptoError("TAMPERED" | "UNKNOWN_KEY" | "MALFORMED")` on any integrity violation.
 */
export function decryptBackupStream(
  encryptedSource: AsyncIterable<Buffer> | Readable,
  options: {
    keyring: ResolvedBackupKeyring;
    expectedBackupPublicId?: string;
  },
): {
  plaintext: AsyncGenerator<Buffer>;
  result(): DecryptedBackupStats;
} {
  let finalResult: DecryptedBackupStats | null = null;

  async function* decode(): AsyncGenerator<Buffer> {
    const queue = new ByteQueue();
    const outerHash = createHash("sha256");
    let encryptedBytes = 0;
    let authenticatedBytes = 0;

    const iter = (encryptedSource as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]();

    async function ensureBytes(needed: number): Promise<boolean> {
      while (queue.length < needed) {
        const next = await iter.next();
        if (next.done) return false;
        const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        if (buf.length > 0) {
          encryptedBytes += buf.length;
          outerHash.update(buf);
          queue.push(buf);
        }
      }
      return true;
    }

    if (!(await ensureBytes(12))) {
      throw new CryptoError("MALFORMED");
    }
    const magic = queue.consume(8);
    if (!magic.equals(RPBK_MAGIC)) {
      throw new CryptoError("MALFORMED");
    }
    const headerLen = queue.consume(4).readUInt32BE(0);
    if (headerLen < 2 || headerLen > MAX_HEADER_BYTES) {
      throw new CryptoError("MALFORMED");
    }
    if (!(await ensureBytes(headerLen))) {
      throw new CryptoError("MALFORMED");
    }
    const headerBytes = queue.consume(headerLen);
    const headerSha256 = createHash("sha256").update(headerBytes).digest();

    let rawHeader: unknown;
    try {
      rawHeader = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw new CryptoError("MALFORMED");
    }
    const parsedHeader = envelopeHeaderSchema.safeParse(rawHeader);
    if (!parsedHeader.success) {
      throw new CryptoError("MALFORMED");
    }
    const header = parsedHeader.data;
    if (options.expectedBackupPublicId && header.backupPublicId !== options.expectedBackupPublicId) {
      throw new CryptoError("TAMPERED");
    }

    const keyMaterial = options.keyring.keys.get(header.keyId);
    if (!keyMaterial) {
      throw new CryptoError("UNKNOWN_KEY");
    }

    const salt = Buffer.from(header.salt, "base64");
    const noncePrefix = Buffer.from(header.noncePrefix, "base64");
    if (salt.length !== 32 || noncePrefix.length !== 8) {
      throw new CryptoError("MALFORMED");
    }

    const { dek } = await deriveArchiveDek(keyMaterial, salt, header.backupPublicId, header.kdf);
    try {
      let seq = 0;
      let sawFinal = false;

      while (!sawFinal) {
        if (!(await ensureBytes(5))) {
          // Stream ended before the final authenticated chunk -> truncated!
          throw new CryptoError("TAMPERED");
        }
        const frameHead = queue.consume(5);
        const flags = frameHead.readUInt8(0);
        const plaintextLen = frameHead.readUInt32BE(1);

        if ((flags !== FLAG_DATA && flags !== FLAG_FINAL) || plaintextLen > header.chunkSize) {
          throw new CryptoError("TAMPERED");
        }
        if (flags === FLAG_DATA && plaintextLen === 0) {
          throw new CryptoError("TAMPERED");
        }

        const bodyNeeded = plaintextLen + GCM_TAG_BYTES;
        if (!(await ensureBytes(bodyNeeded))) {
          throw new CryptoError("TAMPERED");
        }
        const ciphertextAndTag = queue.consume(bodyNeeded);
        const ciphertext = ciphertextAndTag.subarray(0, plaintextLen);
        const tag = ciphertextAndTag.subarray(plaintextLen);

        const nonce = buildChunkNonce(noncePrefix, seq);
        const aad = buildChunkAad(headerSha256, seq, flags, plaintextLen);

        let plain: Buffer;
        try {
          const decipher = createDecipheriv("aes-256-gcm", dek, nonce, { authTagLength: GCM_TAG_BYTES });
          decipher.setAAD(aad);
          decipher.setAuthTag(tag);
          const p1 = decipher.update(ciphertext);
          const p2 = decipher.final();
          plain = p2.length === 0 ? p1 : Buffer.concat([p1, p2]);
        } catch {
          throw new CryptoError("TAMPERED");
        }

        seq += 1;
        authenticatedBytes += plain.length;
        if (plain.length > 0) {
          yield plain;
        }
        if (flags === FLAG_FINAL) {
          sawFinal = true;
        }
      }

      // Ensure zero trailing bytes after the final chunk.
      while (true) {
        if (queue.length > 0) {
          throw new CryptoError("TAMPERED");
        }
        const extra = await iter.next();
        if (extra.done) break;
        const extraBuf = Buffer.isBuffer(extra.value) ? extra.value : Buffer.from(extra.value);
        if (extraBuf.length > 0) {
          throw new CryptoError("TAMPERED");
        }
      }

      finalResult = {
        header,
        authenticatedBytes,
        encryptedBytes,
        archiveSha256: outerHash.digest("hex"),
        chunksVerified: seq,
      };
    } finally {
      dek.fill(0);
    }
  }

  return {
    plaintext: decode(),
    result() {
      if (!finalResult) throw new Error("Decrypted backup stream was not fully consumed.");
      return finalResult;
    },
  };
}
