/**
 * Field encryption, blind indexes, pseudonyms and token hashing. Owner: platform engineer.
 * (Integrator-seeded working baseline; the owner hardens it, adds rotation/dual-read tooling and tests.)
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { CryptoError } from "../core/errors.js";
import type { FieldCrypto } from "../core/types.js";

type CryptoConfig = Pick<AppConfig, "dataKeyring" | "indexKey" | "pseudonymKey" | "tokenHashKey">;

export function createFieldCrypto(config: CryptoConfig): FieldCrypto {
  const dataKeys = new Map(Object.entries(config.dataKeyring.keys).map(([id, key]) => [id, Buffer.from(key, "base64")]));
  const indexKey = Buffer.from(config.indexKey, "base64");
  const pseudonymKey = Buffer.from(config.pseudonymKey, "base64");
  const tokenKey = Buffer.from(config.tokenHashKey, "base64");
  const mac = (key: Buffer, purpose: string, value: string) =>
    createHmac("sha256", key).update(`${purpose.length}:${purpose}:`).update(value, "utf8").digest("hex");

  return {
    encrypt(plaintext, aad) {
      const keyId = config.dataKeyring.current;
      const key = dataKeys.get(keyId);
      if (!key) throw new CryptoError("KEY_UNAVAILABLE");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["rpenc", "v1", keyId, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(":");
    },
    decrypt(envelope, aad) {
      const parts = envelope.split(":");
      if (parts.length !== 6 || parts[0] !== "rpenc" || parts[1] !== "v1") throw new CryptoError("MALFORMED");
      const key = dataKeys.get(parts[2]!);
      if (!key) throw new CryptoError("UNKNOWN_KEY");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[3]!, "base64url"));
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(parts[5]!, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(parts[4]!, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new CryptoError("TAMPERED");
      }
    },
    blindIndex: (value, purpose) => mac(indexKey, purpose, value),
    pseudonym: (value, purpose) => mac(pseudonymKey, purpose, value).slice(0, 32),
    hashToken: (token) => mac(tokenKey, "token", token),
  };
}
