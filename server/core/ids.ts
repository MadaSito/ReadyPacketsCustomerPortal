import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID (26 chars, Crockford base32, lexicographically time-sortable). Used for stable portable
 * `public_id` values, request IDs, event IDs and job IDs. Not a secret; never use as a bearer token.
 */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[bytes[i]! % 32]!;
  return time + rand;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 256-bit URL-safe random secret for bearer tokens (sessions, reset links). Store only its hash. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
