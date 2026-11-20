import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError } from "../../core/errors.js";
import { createFieldCrypto } from "../../security/fieldCrypto.js";

// Synthetic keys (sequential bytes) — test vectors only.
const K1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const INDEX = "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=";
const rand = () => randomBytes(32).toString("base64");
const FIXED_IV = Buffer.from("000102030405060708090a0b", "hex");

function crypto(overrides: { current?: string; keys?: Record<string, string>; previousIndexKey?: string; indexKey?: string } = {}, ivSource?: () => Buffer) {
  return createFieldCrypto(
    {
      dataKeyring: { current: overrides.current ?? "k1", keys: overrides.keys ?? { k1: K1 } },
      indexKey: overrides.indexKey ?? INDEX,
      previousIndexKey: overrides.previousIndexKey,
      pseudonymKey: PSEUDO,
      tokenHashKey: TOKEN,
    },
    ivSource ? { ivSource } : {},
  );
}
const PSEUDO = rand();
const TOKEN = rand();

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    return (error as CryptoError).reasonCode;
  }
  throw new Error("expected CryptoError");
}

/** Flip one base64url character in envelope part `index`. */
function flip(envelope: string, index: number): string {
  const parts = envelope.split(":");
  const part = parts[index]!;
  const pos = Math.floor(part.length / 2);
  parts[index] = part.slice(0, pos) + (part[pos] === "A" ? "B" : "A") + part.slice(pos + 1);
  return parts.join(":");
}

describe("FieldCrypto: AES-256-GCM envelopes", () => {
  it("matches the independently computed test vector", () => {
    const fc = crypto({}, () => Buffer.from(FIXED_IV));
    const envelope = fc.encrypt("alice@example.test", "users.email:01HZX");
    expect(envelope).toBe("rpenc:v1:k1:AAECAwQFBgcICQoL:Jm6_eKClp2PsLOfn1McMCPCi:NGqARRbxwccx_OuMTM1WuA");
    expect(fc.decrypt(envelope, "users.email:01HZX")).toBe("alice@example.test");
  });

  it("matches the blind-index HMAC vector (length-prefixed purpose)", () => {
    expect(crypto().blindIndex("alice@example.test", "user.email")).toBe("0573a9275c9cef430a2e963f03722415cff67a07336c1366eed80b0f35b1b216");
  });

  it("uses a fresh IV for every encryption", () => {
    const fc = crypto();
    const a = fc.encrypt("same", "t.c:1");
    const b = fc.encrypt("same", "t.c:1");
    expect(a).not.toBe(b);
    expect(a.split(":")[3]).not.toBe(b.split(":")[3]);
  });

  it("roundtrips unicode and empty plaintext", () => {
    const fc = crypto();
    for (const text of ["", "Zoë – 東京 – 🚚", "x".repeat(10_000)]) expect(fc.decrypt(fc.encrypt(text, "t.c:1"), "t.c:1")).toBe(text);
  });

  it("detects tampering of IV, ciphertext and tag", () => {
    const fc = crypto();
    const envelope = fc.encrypt("secret-value", "t.c:1");
    for (const index of [3, 4, 5]) expect(reason(() => fc.decrypt(flip(envelope, index), "t.c:1"))).toMatch(/TAMPERED|MALFORMED/);
    const parts = envelope.split(":");
    parts[4] = parts[4]!.slice(0, -2);
    expect(reason(() => fc.decrypt(parts.join(":"), "t.c:1"))).toBe("TAMPERED");
  });

  it("refuses AAD mismatch (moved to another row, column or table)", () => {
    const fc = crypto();
    const envelope = fc.encrypt("secret-value", "users.email:01A");
    for (const aad of ["users.email:01B", "users.phone:01A", "contacts.email:01A", "users.email:01A "]) {
      expect(reason(() => fc.decrypt(envelope, aad))).toBe("TAMPERED");
    }
  });

  it("refuses a relabelled key id even when the other key exists", () => {
    const k2 = rand();
    const fc = crypto({ current: "k1", keys: { k1: K1, k2 } });
    const envelope = fc.encrypt("secret-value", "t.c:1");
    expect(reason(() => fc.decrypt(envelope.replace(":k1:", ":k2:"), "t.c:1"))).toBe("TAMPERED");
  });

  it("reports unknown keys and malformed envelopes with fixed reason codes and no data", () => {
    const fc = crypto();
    const other = crypto({ current: "k9", keys: { k9: rand() } }).encrypt("secret-value", "t.c:1");
    expect(reason(() => fc.decrypt(other, "t.c:1"))).toBe("UNKNOWN_KEY");
    for (const bad of ["", "plain", "rpenc:v2:k1:a:b:c", "rpenc:v1:K1:AAECAwQFBgcICQoL:AA:NGqARRbxwccx_OuMTM1WuA", "rpenc:v1:k1:AAEC:AA:AA", "rpenc:v1:k1:AAECAwQFBgcICQoL:A+A:NGqARRbxwccx_OuMTM1WuA"]) {
      expect(reason(() => fc.decrypt(bad, "t.c:1"))).toBe("MALFORMED");
    }
    expect(reason(() => fc.encrypt("x", ""))).toBe("MALFORMED");
    expect(reason(() => fc.encrypt("x", "a".repeat(513)))).toBe("MALFORMED");
    try {
      fc.decrypt(fc.encrypt("very-secret-plaintext", "t.c:1"), "t.c:2");
    } catch (error) {
      expect(String(error)).not.toContain("very-secret");
      expect(String(error)).not.toContain("t.c:");
    }
  });

  it("rejects authentic ciphertexts that decrypt to invalid UTF-8", () => {
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(K1, "base64"), FIXED_IV, { authTagLength: 16 });
    cipher.setAAD(Buffer.from("rpenc:v1:k1:t.c:1"));
    const ct = Buffer.concat([cipher.update(Buffer.from([0xff, 0xfe])), cipher.final()]);
    const envelope = ["rpenc", "v1", "k1", FIXED_IV.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(":");
    expect(reason(() => crypto().decrypt(envelope, "t.c:1"))).toBe("TAMPERED");
  });

  it("fails closed on keyring configuration problems", () => {
    expect(reason(() => crypto({ current: "k2", keys: { k1: K1 } }))).toBe("KEY_UNAVAILABLE");
    expect(reason(() => crypto({ keys: { k1: Buffer.alloc(16, 1).toString("base64") } }))).toBe("KEY_UNAVAILABLE");
    expect(reason(() => crypto({ current: "Bad_Id", keys: { Bad_Id: K1 } }))).toBe("KEY_UNAVAILABLE");
    expect(reason(() => crypto({}, () => Buffer.alloc(8)).encrypt("x", "t.c:1"))).toBe("KEY_UNAVAILABLE");
  });
});

describe("FieldCrypto: rotation mechanics", () => {
  const k2 = rand();
  const old = crypto({ current: "k1", keys: { k1: K1 } });
  const rotated = crypto({ current: "k2", keys: { k1: K1, k2 } });

  it("dual-reads retired-but-retained keys and writes under the current key", () => {
    const legacy = old.encrypt("v", "t.c:1");
    expect(rotated.decrypt(legacy, "t.c:1")).toBe("v");
    expect(rotated.keyIdOf(rotated.encrypt("v", "t.c:1"))).toBe("k2");
    expect(rotated.needsReencryption(legacy)).toBe(true);
  });

  it("re-encrypts under the current key with the same AAD, idempotently", () => {
    const legacy = old.encrypt("v", "t.c:1");
    const fresh = rotated.reencrypt(legacy, "t.c:1");
    expect(rotated.keyIdOf(fresh)).toBe("k2");
    expect(rotated.decrypt(fresh, "t.c:1")).toBe("v");
    expect(rotated.reencrypt(fresh, "t.c:1")).toBe(fresh);
    expect(reason(() => rotated.reencrypt(legacy, "t.c:2"))).toBe("TAMPERED");
  });

  it("refuses data once the retired key is removed (retirement is explicit)", () => {
    const legacy = old.encrypt("v", "t.c:1");
    const retired = crypto({ current: "k2", keys: { k2 } });
    expect(reason(() => retired.decrypt(legacy, "t.c:1"))).toBe("UNKNOWN_KEY");
  });

  it("reports keyring status without key material", () => {
    const status = rotated.keyringStatus();
    expect(status).toEqual({ currentKeyId: "k2", keyIds: ["k1", "k2"], retiredKeyCount: 1, blindIndexTransition: false });
    expect(JSON.stringify(status)).not.toContain(K1);
  });

  it("offers previous-key blind-index candidates only during a transition", () => {
    const newIndex = rand();
    const before = crypto();
    const during = crypto({ indexKey: newIndex, previousIndexKey: INDEX });
    const after = crypto({ indexKey: newIndex });
    const old = before.blindIndex("alice@example.test", "user.email");
    expect(during.blindIndexCandidates("alice@example.test", "user.email")).toEqual([during.blindIndex("alice@example.test", "user.email"), old]);
    expect(after.blindIndexCandidates("alice@example.test", "user.email")).toHaveLength(1);
    expect(during.keyringStatus().blindIndexTransition).toBe(true);
  });
});

describe("FieldCrypto: HMAC separation", () => {
  const fc = crypto();

  it("domain-separates purposes and keys", () => {
    expect(fc.blindIndex("x", "a.b")).not.toBe(fc.blindIndex("x", "a.c"));
    expect(fc.blindIndex("x", "a")).not.toBe(fc.pseudonym("x", "a"));
    // length prefix: purpose "a" + value ":b" must differ from purpose "a:" + value "b"
    expect(fc.blindIndex(":b", "a")).not.toBe(fc.blindIndex("b", "a:"));
    expect(fc.pseudonym("x", "audit.user")).toHaveLength(32);
    expect(reason(() => fc.blindIndex("x", "Bad Purpose"))).toBe("MALFORMED");
  });

  it("verifies token hashes in constant time and refuses malformed candidates", () => {
    const hash = fc.hashToken("tok");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fc.verifyTokenHash("tok", hash)).toBe(true);
    expect(fc.verifyTokenHash("tok2", hash)).toBe(false);
    expect(fc.verifyTokenHash("tok", hash.toUpperCase())).toBe(false);
    expect(fc.verifyTokenHash("tok", "")).toBe(false);
    expect(fc.verifyTokenHash("tok", "0".repeat(64))).toBe(false);
  });
});
