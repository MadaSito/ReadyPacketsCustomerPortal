/**
 * Field encryption, blind indexes, pseudonyms and token hashing. Owner: platform engineer.
 *
 * Envelope (v1): `rpenc:v1:<keyId>:<iv>:<ciphertext>:<tag>` — AES-256-GCM, 96-bit random IV, 128-bit tag,
 * base64url fields. The authenticated data is `rpenc:v1:<keyId>:<aad>` so the version, the key id and the
 * caller's record binding (`<table>.<column>:<publicId>`) are all authenticated: moving a ciphertext to
 * another row/column, relabelling its key id or truncating it fails with `CryptoError("TAMPERED")`.
 *
 * Keys (all independent, enforced distinct by config validation):
 *   dataKeyring   current id for new encryptions + retired-but-retained ids for dual-read
 *   indexKey      blind-index HMAC (+ optional previousIndexKey during a blind-index transition)
 *   pseudonymKey  audit/SIEM pseudonyms
 *   tokenHashKey  stored single-use token hashes
 *
 * Every failure is a CryptoError with a fixed reason code; plaintext, keys and AAD never appear in errors.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeKey, type AppConfig } from "../config/env.js";
import { CryptoError } from "../core/errors.js";
import type { FieldCrypto } from "../core/types.js";

type CryptoConfig = Pick<AppConfig, "dataKeyring" | "indexKey" | "pseudonymKey" | "tokenHashKey"> & {
  previousIndexKey?: string | undefined;
};

export const ENVELOPE_PREFIX = "rpenc";
export const ENVELOPE_VERSION = "v1";
export const MAX_PLAINTEXT_BYTES = 1024 * 1024;
export const MAX_AAD_LENGTH = 512;
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const PURPOSE = /^[a-z][a-z0-9_.:-]{0,95}$/;

export interface KeyringStatus {
  currentKeyId: string;
  keyIds: readonly string[];
  retiredKeyCount: number;
  blindIndexTransition: boolean;
}

/** FieldCrypto plus key-rotation mechanics (used by the re-encryption tool and platform health). */
export interface PlatformFieldCrypto extends FieldCrypto {
  /** Key id of a well-formed envelope (throws MALFORMED otherwise). Does not authenticate. */
  keyIdOf(envelope: string): string;
  /** True when the envelope was written under a key other than the current one. */
  needsReencryption(envelope: string): boolean;
  /** Decrypts under any retained key and re-encrypts under the current key with the same AAD. */
  reencrypt(envelope: string, aad: string): string;
  /** Blind indexes to try during lookup: current key first, then the previous key during a transition. */
  blindIndexCandidates(value: string, purpose: string): string[];
  /** True iff `candidate` equals hashToken(token), compared in constant time. */
  verifyTokenHash(token: string, candidate: string): boolean;
  keyringStatus(): KeyringStatus;
}

export interface FieldCryptoOptions {
  /** Test-vector hook: deterministic IVs. Never set in production code. */
  ivSource?: () => Buffer;
}

interface ParsedEnvelope {
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  if (typeof envelope !== "string" || envelope.length > MAX_PLAINTEXT_BYTES * 2) throw new CryptoError("MALFORMED");
  const parts = envelope.split(":");
  if (parts.length !== 6 || parts[0] !== ENVELOPE_PREFIX || parts[1] !== ENVELOPE_VERSION) throw new CryptoError("MALFORMED");
  const [, , keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string, string];
  if (!KEY_ID.test(keyId) || !B64URL.test(iv) || !B64URL.test(ciphertext) || !B64URL.test(tag)) throw new CryptoError("MALFORMED");
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== 12 || tagBytes.length !== 16 || iv.length !== 16 || tag.length !== 22) throw new CryptoError("MALFORMED");
  return { keyId, iv: ivBytes, ciphertext: Buffer.from(ciphertext, "base64url"), tag: tagBytes };
}

function boundAad(keyId: string, aad: string): Buffer {
  if (typeof aad !== "string" || aad.length === 0 || aad.length > MAX_AAD_LENGTH) throw new CryptoError("MALFORMED");
  return Buffer.from(`${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:${keyId}:${aad}`, "utf8");
}

function loadKey(value: string): Buffer {
  const key = decodeKey(value);
  if (key.length !== 32) throw new CryptoError("KEY_UNAVAILABLE");
  return key;
}

export function createFieldCrypto(config: CryptoConfig, options: FieldCryptoOptions = {}): PlatformFieldCrypto {
  const dataKeys = new Map<string, Buffer>();
  for (const [id, key] of Object.entries(config.dataKeyring.keys)) {
    if (!KEY_ID.test(id)) throw new CryptoError("KEY_UNAVAILABLE");
    dataKeys.set(id, loadKey(key));
  }
  const currentKeyId = config.dataKeyring.current;
  if (!dataKeys.has(currentKeyId)) throw new CryptoError("KEY_UNAVAILABLE");
  const indexKey = loadKey(config.indexKey);
  const previousIndexKey = config.previousIndexKey ? loadKey(config.previousIndexKey) : null;
  const pseudonymKey = loadKey(config.pseudonymKey);
  const tokenKey = loadKey(config.tokenHashKey);
  const ivSource = options.ivSource ?? (() => randomBytes(12));

  // Length-prefixed purpose gives unambiguous domain separation between purposes.
  const mac = (key: Buffer, purpose: string, value: string) => {
    if (!PURPOSE.test(purpose)) throw new CryptoError("MALFORMED");
    if (typeof value !== "string") throw new CryptoError("MALFORMED");
    return createHmac("sha256", key).update(`${purpose.length}:${purpose}:`).update(value, "utf8").digest("hex");
  };

  const encrypt = (plaintext: string, aad: string): string => {
    if (typeof plaintext !== "string" || Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES) throw new CryptoError("MALFORMED");
    const key = dataKeys.get(currentKeyId);
    if (!key) throw new CryptoError("KEY_UNAVAILABLE");
    const iv = ivSource();
    if (iv.length !== 12) throw new CryptoError("KEY_UNAVAILABLE");
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(boundAad(currentKeyId, aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      ENVELOPE_PREFIX,
      ENVELOPE_VERSION,
      currentKeyId,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(":");
  };

  const decrypt = (envelope: string, aad: string): string => {
    const parsed = parseEnvelope(envelope);
    const key = dataKeys.get(parsed.keyId);
    if (!key) throw new CryptoError("UNKNOWN_KEY");
    const additional = boundAad(parsed.keyId, aad);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv, { authTagLength: 16 });
      decipher.setAAD(additional);
      decipher.setAuthTag(parsed.tag);
      const plain = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
      // Reject invalid UTF-8 rather than silently substituting characters.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plain);
      plain.fill(0);
      return text;
    } catch {
      throw new CryptoError("TAMPERED");
    }
  };

  const hashToken = (token: string) => mac(tokenKey, "token", token);

  return {
    encrypt,
    decrypt,
    blindIndex: (value, purpose) => mac(indexKey, purpose, value),
    pseudonym: (value, purpose) => mac(pseudonymKey, purpose, value).slice(0, 32),
    hashToken,
    keyIdOf: (envelope) => parseEnvelope(envelope).keyId,
    needsReencryption: (envelope) => parseEnvelope(envelope).keyId !== currentKeyId,
    reencrypt(envelope, aad) {
      const plaintext = decrypt(envelope, aad);
      return parseEnvelope(envelope).keyId === currentKeyId ? envelope : encrypt(plaintext, aad);
    },
    blindIndexCandidates(value, purpose) {
      const current = mac(indexKey, purpose, value);
      return previousIndexKey ? [current, mac(previousIndexKey, purpose, value)] : [current];
    },
    verifyTokenHash(token, candidate) {
      const expected = Buffer.from(hashToken(token), "hex");
      const given = /^[0-9a-f]{64}$/.test(candidate) ? Buffer.from(candidate, "hex") : Buffer.alloc(32);
      return timingSafeEqual(expected, given) && /^[0-9a-f]{64}$/.test(candidate);
    },
    keyringStatus: () => ({
      currentKeyId,
      keyIds: Object.freeze([...dataKeys.keys()].sort()),
      retiredKeyCount: dataKeys.size - 1,
      blindIndexTransition: previousIndexKey !== null,
    }),
  };
}
