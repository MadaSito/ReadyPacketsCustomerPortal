/**
 * Portable package encryption envelope ("RPPKG3").
 *
 *   magic  "RPPKG3\r\n"                         8 bytes
 *   hlen   uint32 BE                             4 bytes (64..4096)
 *   header canonical JSON (UTF-8)                hlen bytes
 *   hmac   HMAC-SHA256(macKey, magic‖hlen‖header) 32 bytes  → wrong passphrase / header tamper detected first
 *   chunk* uint32 BE ciphertext length L, L bytes ciphertext, 16 bytes GCM tag
 *
 * Keys: master = scrypt(NFC(passphrase), salt, 32, {N,r,p}); encKey/macKey = HKDF-SHA256(master, salt, info).
 * Chunk i: nonce = 0x00000000 ‖ uint64 BE i; AAD = SHA-256(magic‖hlen‖header) ‖ uint64 BE i ‖ final(1 byte).
 * A unique random salt per package makes the derived key unique, so counter nonces never repeat under a key.
 * Index in nonce+AAD detects reordering/duplication; the final flag detects truncation; bytes after the final
 * chunk are rejected (TRAILING_DATA). Plaintext of a chunk is released only after its tag verified.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import type { FileHandle } from "node:fs/promises";
import { z } from "zod";
import { PortableError } from "../errors.js";
import { canonicalJson, safeJsonParse } from "../json.js";
import type { PortableLimits } from "../limits.js";

export const MAGIC = Buffer.from("RPPKG3\r\n", "latin1");
export const TAG_BYTES = 16;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 1024 * 1024;
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

export const HeaderSchema = z.strictObject({
  format: z.literal("readypackets.portable-envelope"),
  envelopeVersion: z.literal(1),
  cipher: z.literal("AES-256-GCM"),
  kdf: z.strictObject({
    name: z.literal("scrypt"),
    N: z.int().min(2),
    r: z.int().min(1),
    p: z.int().min(1),
    keyLength: z.literal(32),
    salt: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // 32 bytes base64url
  }),
  hkdf: z.literal("HKDF-SHA256"),
  chunkSize: z.int().min(1024).max(MAX_CHUNK_SIZE),
  packageId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
});
export type EnvelopeHeader = z.infer<typeof HeaderSchema>;

export interface DerivedKeys {
  encKey: Buffer;
  macKey: Buffer;
}

function normPass(passphrase: string | Uint8Array): Buffer {
  return typeof passphrase === "string" ? Buffer.from(passphrase.normalize("NFC"), "utf8") : Buffer.from(passphrase);
}

export function assertPassphrase(passphrase: string | Uint8Array): void {
  const bytes = normPass(passphrase);
  if (bytes.length < 12 || bytes.length > 1024) {
    throw new PortableError("INPUT_INVALID", "The package passphrase must be between 12 and 1024 bytes.");
  }
}

export async function deriveKeys(passphrase: string | Uint8Array, kdf: EnvelopeHeader["kdf"]): Promise<DerivedKeys> {
  const salt = Buffer.from(kdf.salt, "base64url");
  const maxmem = 128 * kdf.N * kdf.r * kdf.p + 32 * 1024 * 1024;
  const master = await new Promise<Buffer>((resolve, reject) =>
    scrypt(normPass(passphrase), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem }, (err, key) =>
      err ? reject(new PortableError("KDF_PARAMS_REJECTED", "Key derivation parameters could not be used.")) : resolve(key),
    ),
  );
  const encKey = Buffer.from(hkdfSync("sha256", master, salt, "readypackets portable v3 chunk key", 32));
  const macKey = Buffer.from(hkdfSync("sha256", master, salt, "readypackets portable v3 header mac", 32));
  master.fill(0);
  return { encKey, macKey };
}

export function checkKdfParams(kdf: { N: number; r: number; p: number }, limits: PortableLimits): void {
  const powerOfTwo = (kdf.N & (kdf.N - 1)) === 0;
  if (!powerOfTwo || kdf.N < limits.kdfMinN || kdf.N > limits.kdfMaxN || kdf.r > limits.kdfMaxR || kdf.p > limits.kdfMaxP) {
    throw new PortableError("KDF_PARAMS_REJECTED", "Key derivation parameters are outside the accepted range.");
  }
}

export function encodeHeader(header: EnvelopeHeader): Buffer {
  const json = Buffer.from(canonicalJson(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, len, json]);
}

export function headerMac(macKey: Buffer, headerBytes: Buffer): Buffer {
  return createHmac("sha256", macKey).update(headerBytes).digest();
}

export function newHeader(packageId: string, kdf: { N: number; r: number; p: number }, chunkSize: number, random: (n: number) => Uint8Array = randomBytes): EnvelopeHeader {
  return {
    format: "readypackets.portable-envelope",
    envelopeVersion: 1,
    cipher: "AES-256-GCM",
    kdf: { name: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p, keyLength: 32, salt: Buffer.from(random(32)).toString("base64url") },
    hkdf: "HKDF-SHA256",
    chunkSize,
    packageId,
  };
}

function nonce(index: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(index, 4);
  return n;
}
function aad(headerHash: Buffer, index: bigint, final: boolean): Buffer {
  const a = Buffer.alloc(32 + 8 + 1);
  headerHash.copy(a, 0);
  a.writeBigUInt64BE(index, 32);
  a[40] = final ? 1 : 0;
  return a;
}

/** Streaming encryptor: emits header+mac, then authenticated chunks; the last chunk carries final=1. */
export class EncryptStream extends Transform {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private index = 0n;
  private readonly headerHash: Buffer;
  constructor(
    private readonly keys: DerivedKeys,
    headerBytes: Buffer,
    private readonly chunkSize: number,
  ) {
    super();
    this.headerHash = createHash("sha256").update(headerBytes).digest();
    this.push(Buffer.concat([headerBytes, headerMac(keys.macKey, headerBytes)]));
  }
  private seal(plain: Buffer, final: boolean): void {
    const cipher = createCipheriv("aes-256-gcm", this.keys.encKey, nonce(this.index));
    cipher.setAAD(aad(this.headerHash, this.index, final));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length);
    this.push(Buffer.concat([len, ct, cipher.getAuthTag()]));
    this.index += 1n;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    // Keep at least one byte pending so the final chunk is never empty unless the whole stream is empty.
    while (this.pendingLen > this.chunkSize) {
      const all = Buffer.concat(this.pending);
      this.seal(all.subarray(0, this.chunkSize), false);
      const rest = all.subarray(this.chunkSize);
      this.pending = [rest];
      this.pendingLen = rest.length;
    }
    cb();
  }
  override _flush(cb: TransformCallback): void {
    this.seal(Buffer.concat(this.pending), true);
    this.pending = [];
    cb();
  }
}

async function readExact(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return off === length ? buf : buf.subarray(0, off);
}

export interface OpenedEnvelope {
  header: EnvelopeHeader;
  headerBytes: Buffer;
  keys: DerivedKeys;
  bodyOffset: number;
}

/** Parse + authenticate the header (constant-time MAC compare). Wrong passphrase ⇒ PASSPHRASE_REJECTED. */
export async function openEnvelopeHeader(fh: FileHandle, passphrase: string | Uint8Array, limits: PortableLimits): Promise<OpenedEnvelope> {
  const pre = await readExact(fh, 0, 12);
  if (pre.length < 12 || !pre.subarray(0, 8).equals(MAGIC)) throw new PortableError("UNSUPPORTED_ENVELOPE", "The file is not a ReadyPackets v3 package.");
  const hlen = pre.readUInt32BE(8);
  if (hlen < 64 || hlen > 4096) throw new PortableError("HEADER_INVALID", "The package header length is invalid.");
  const json = await readExact(fh, 12, hlen);
  if (json.length !== hlen) throw new PortableError("TRUNCATED", "The package header is truncated.");
  let header: EnvelopeHeader;
  try {
    header = HeaderSchema.parse(safeJsonParse(json.toString("utf8")));
  } catch {
    throw new PortableError("HEADER_INVALID", "The package header is malformed.");
  }
  const headerBytes = Buffer.concat([pre, json]);
  if (!encodeHeader(header).equals(headerBytes)) throw new PortableError("HEADER_INVALID", "The package header is not canonical.");
  checkKdfParams(header.kdf, limits);
  const mac = await readExact(fh, 12 + hlen, 32);
  if (mac.length !== 32) throw new PortableError("TRUNCATED", "The package header is truncated.");
  const keys = await deriveKeys(passphrase, header.kdf);
  if (!timingSafeEqual(mac, headerMac(keys.macKey, headerBytes))) {
    throw new PortableError("PASSPHRASE_REJECTED", "The passphrase is incorrect or the package header was altered.");
  }
  return { header, headerBytes, keys, bodyOffset: 12 + hlen + 32 };
}

/**
 * Decrypt every chunk in order, calling `sink` with authenticated plaintext only. Throws on any tag
 * failure, truncation, or trailing bytes. Returns total plaintext bytes.
 */
export async function decryptBody(
  fh: FileHandle,
  opened: OpenedEnvelope,
  fileSize: number,
  sink: (plain: Buffer) => Promise<void>,
  maxPlainBytes: number,
): Promise<number> {
  const headerHash = createHash("sha256").update(opened.headerBytes).digest();
  let pos = opened.bodyOffset;
  let index = 0n;
  let total = 0;
  for (;;) {
    if (pos >= fileSize) throw new PortableError("TRUNCATED", "The package ends before its final chunk.");
    const lenBuf = await readExact(fh, pos, 4);
    if (lenBuf.length < 4) throw new PortableError("TRUNCATED", "The package ends inside a chunk header.");
    const len = lenBuf.readUInt32BE(0);
    if (len > opened.header.chunkSize) throw new PortableError("CHUNK_AUTH_FAILED", "A package chunk has an invalid length.");
    const body = await readExact(fh, pos + 4, len + TAG_BYTES);
    if (body.length < len + TAG_BYTES) throw new PortableError("TRUNCATED", "The package ends inside a chunk.");
    pos += 4 + len + TAG_BYTES;
    const isLast = pos === fileSize;
    // Try with the final flag implied by position; an attacker cannot forge either flag.
    const plain = tryOpen(opened.keys.encKey, headerHash, index, body, len, isLast) ;
    if (!plain) {
      // Distinguish truncation (non-final chunk now at EOF) and trailing data (final chunk not at EOF).
      if (isLast && tryOpen(opened.keys.encKey, headerHash, index, body, len, false)) {
        throw new PortableError("TRUNCATED", "The package ends before its final chunk.");
      }
      if (!isLast && tryOpen(opened.keys.encKey, headerHash, index, body, len, true)) {
        throw new PortableError("TRAILING_DATA", "The package has data after its final chunk.");
      }
      throw new PortableError("CHUNK_AUTH_FAILED", "A package chunk failed authentication (tampered, reordered or corrupted).");
    }
    total += plain.length;
    if (total > maxPlainBytes) throw new PortableError("SIZE_LIMIT", "The package plaintext exceeds the configured limit.");
    await sink(plain);
    index += 1n;
    if (isLast) return total;
  }
}

function tryOpen(key: Buffer, headerHash: Buffer, index: bigint, body: Buffer, len: number, final: boolean): Buffer | null {
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce(index));
    d.setAAD(aad(headerHash, index, final));
    d.setAuthTag(body.subarray(len, len + TAG_BYTES));
    return Buffer.concat([d.update(body.subarray(0, len)), d.final()]);
  } catch {
    return null;
  }
}
