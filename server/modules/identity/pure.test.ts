/** Pure-function tests: password policy, transition derivation (every ordering), normalization, cursors. */
import { describe, expect, it } from "vitest";
import { TRANSITION_STEPS } from "../../../shared/domain.js";
import { decodeCursor, encodeCursor } from "./admin.js";
import { customerRefSchema, deviceSummary, emailSchema, namePrefixes, nameSchema, normalizeEmail } from "./normalize.js";
import { checkPassword } from "./password/policy.js";
import { generateCustomerRef } from "./users.js";
import { deriveSteps, type TransitionFacts } from "./transitions.js";

const STRONG = "copper lantern drifts beyond quiet harbor";

describe("password policy", () => {
  it("accepts a long passphrase with no composition rules", () => {
    expect(checkPassword(STRONG)).toBeNull();
    expect(checkPassword("zebra-violin-cactus-mosaic")).toBeNull();
  });
  it("counts Unicode code points after NFC (15 minimum, 128 maximum, never truncates)", () => {
    expect(checkPassword("a".repeat(5) + "bcdefghij")).toBe("PASSWORD_TOO_SHORT"); // 14
    const emoji = "🍀🌊🔥🎻🦓🌵🧩🛶🪐🍋🎈🧭🪁🐙🦉"; // 15 code points, 30 UTF-16 units
    expect([...emoji].length).toBe(15);
    expect(checkPassword(emoji)).toBeNull();
    // NFD "é" (2 code points) normalizes to 1: 14 after NFC ⇒ too short.
    expect(checkPassword("e\u0301".repeat(14))).toBe("PASSWORD_TOO_SHORT");
    expect(checkPassword(`${STRONG} ${"x".repeat(129 - STRONG.length - 1)}`)).toBe("PASSWORD_TOO_LONG");
    expect([...`${STRONG} ${"k".repeat(128 - STRONG.length - 1)}`].length).toBe(128);
    expect(checkPassword(`${STRONG} ${"k".repeat(128 - STRONG.length - 1)}`)).toBeNull();
  });
  it("rejects common passwords, trivial repetition and sequences", () => {
    expect(checkPassword("passwordpassword")).not.toBeNull();
    expect(checkPassword("aaaaaaaaaaaaaaaaaaaa")).toBe("PASSWORD_TOO_SIMPLE");
    expect(checkPassword("abcdefghijklmnopqrst")).toBe("PASSWORD_TOO_SIMPLE");
    expect(checkPassword("1234567890123456")).not.toBeNull();
  });
  it("rejects context words: brand, e-mail local part, name", () => {
    expect(checkPassword("readypackets2026!!")).not.toBeNull();
    expect(checkPassword("marigoldfernandez1", { email: "marigoldfernandez@example.test" })).toBe("PASSWORD_CONTEXT");
    expect(checkPassword("Marigold Fernandez 99", { name: "Marigold Fernandez" })).toBe("PASSWORD_CONTEXT");
    expect(checkPassword(STRONG, { name: "Marigold Fernandez", email: "mf@example.test" })).toBeNull();
  });
});

describe("transition derivation", () => {
  const base: TransitionFacts = { emailVerified: true, mustChangePassword: false, mfaEnrolled: true, recoveryCodesAcknowledged: true, sessionMfaVerified: true };
  const all = (): TransitionFacts[] => {
    const out: TransitionFacts[] = [];
    for (let mask = 0; mask < 32; mask++) {
      out.push({
        emailVerified: (mask & 1) !== 0,
        mustChangePassword: (mask & 2) !== 0,
        mfaEnrolled: (mask & 4) !== 0,
        recoveryCodesAcknowledged: (mask & 8) !== 0,
        sessionMfaVerified: (mask & 16) !== 0,
      });
    }
    return out;
  };

  it("fully satisfied facts yield no steps", () => expect(deriveSteps(base)).toEqual([]));

  it("every combination yields a subsequence of the canonical order with the expected members", () => {
    for (const facts of all()) {
      const steps = deriveSteps(facts);
      const indices = steps.map((step) => TRANSITION_STEPS.indexOf(step));
      expect([...indices].sort((a, b) => a - b)).toEqual(indices); // ordered
      expect(new Set(steps).size).toBe(steps.length);
      expect(steps.includes("verify_email")).toBe(!facts.emailVerified);
      expect(steps.includes("change_password")).toBe(facts.mustChangePassword);
      expect(steps.includes("enroll_mfa")).toBe(!facts.mfaEnrolled);
      expect(steps.includes("mfa_challenge")).toBe(facts.mfaEnrolled && !facts.sessionMfaVerified);
      expect(steps.includes("acknowledge_recovery_codes")).toBe(facts.mfaEnrolled && !facts.recoveryCodesAcknowledged);
      // Never both challenge and enroll.
      expect(steps.includes("mfa_challenge") && steps.includes("enroll_mfa")).toBe(false);
    }
  });

  it("completing the head step re-derives the next one until none remain (every starting state)", () => {
    for (const start of all()) {
      let facts = { ...start };
      let previous = deriveSteps(facts);
      for (let guard = 0; guard < 6 && previous.length > 0; guard++) {
        const head = previous[0]!;
        if (head === "verify_email") facts = { ...facts, emailVerified: true };
        if (head === "mfa_challenge") facts = { ...facts, sessionMfaVerified: true };
        if (head === "enroll_mfa") facts = { ...facts, mfaEnrolled: true, sessionMfaVerified: true, recoveryCodesAcknowledged: false };
        if (head === "acknowledge_recovery_codes") facts = { ...facts, recoveryCodesAcknowledged: true };
        if (head === "change_password") facts = { ...facts, mustChangePassword: false };
        const next = deriveSteps(facts);
        expect(next).not.toContain(head);
        // Remaining steps preserve canonical order; enrollment may introduce acknowledgement.
        if (head !== "enroll_mfa") expect(next).toEqual(previous.slice(1));
        previous = next;
      }
      expect(previous).toEqual([]);
    }
  });
});

describe("normalization", () => {
  it("canonicalizes e-mail", () => {
    expect(normalizeEmail("  Alice@Example.TEST ")).toBe("alice@example.test");
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(emailSchema.safeParse("a b@example.test").success).toBe(false);
    expect(emailSchema.parse("Bob@Example.Test")).toBe("bob@example.test");
  });
  it("validates names and customer references", () => {
    expect(nameSchema.parse("  Ana   María ")).toBe("Ana María");
    expect(nameSchema.safeParse("bad\u0007name").success).toBe(false);
    expect(nameSchema.safeParse("").success).toBe(false);
    expect(customerRefSchema.parse("rp-abc1234")).toBe("RP-ABC1234");
    for (const bad of ["AB", "-ABC", "ABC-", "AB--CD", "AB CD", "A".repeat(33)]) expect(customerRefSchema.safeParse(bad).success).toBe(false);
  });
  it("generates customer IDs as RPCUS- plus nine random characters from 0-9 and A-Z", () => {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    const total = 20_000;
    for (let i = 0; i < total; i += 1) {
      const ref = generateCustomerRef();
      expect(ref).toMatch(/^RPCUS-[0-9A-Z]{9}$/);
      expect(customerRefSchema.parse(ref)).toBe(ref);
      seen.add(ref);
      for (const ch of ref.slice(6)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    // No repeats in a sample this small (a repeat would point at a broken random source).
    expect(seen.size).toBe(total);
    // All 36 characters occur, each close to the expected share (5000 per character; wide tolerance).
    expect(counts.size).toBe(36);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(4300);
      expect(n).toBeLessThan(5700);
    }
    // Consecutive IDs are unrelated: never numerically adjacent in base 36.
    const a = BigInt(parseInt(generateCustomerRef().slice(6), 36));
    const b = BigInt(parseInt(generateCustomerRef().slice(6), 36));
    expect(a === b + 1n || b === a + 1n).toBe(false);
  });
  it("derives 3-letter name prefixes and coarse device summaries", () => {
    expect(namePrefixes("Ana María López")).toEqual({ first: "ana", last: "lóp" });
    expect(namePrefixes("Al")).toEqual({ first: null, last: null });
    expect(deviceSummary(undefined)).toBeNull();
    expect(deviceSummary("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")).not.toContain("537");
  });
  it("round-trips cursors and rejects tampered values", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor("!!!")).toThrow();
    expect(() => decodeCursor(Buffer.from("c1:-1").toString("base64url"))).toThrow();
  });
});
