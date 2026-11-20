import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { ModuleDeps } from "../../container.js";
import { conflict } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { assuranceChallenges, assurancePasskeys } from "./schema.js";
import { getPasskeys, PASSKEY_LIMIT } from "./store.js";

const TTL_MS = 2 * 60_000;
const ALGORITHMS = [-7, -8, -257] as const;
type Ceremony = typeof assuranceChallenges.$inferSelect.purpose;
export type AuthenticationPurpose = Exclude<Ceremony, "register">;
type BoundSession = Pick<SessionPrincipal, "userId" | "sessionId">;

function binding(deps: ModuleDeps) {
  const canonical = new URL(deps.config.canonicalOrigin);
  return { rpID: canonical.hostname, origin: canonical.origin };
}

function challengeHash(deps: ModuleDeps, challenge: string): string {
  return deps.crypto.hashToken(`assurance-webauthn:${challenge}`);
}

function matches(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function scope(session: BoundSession, purpose: Ceremony) {
  return and(eq(assuranceChallenges.userId, session.userId),
    eq(assuranceChallenges.sessionId, session.sessionId), eq(assuranceChallenges.purpose, purpose));
}

async function saveChallenge(deps: ModuleDeps, tx: Tx, session: BoundSession, purpose: Ceremony, challenge: string) {
  const now = deps.clock.now();
  const publicId = ulid(+now);
  await tx.delete(assuranceChallenges).where(scope(session, purpose));
  await tx.insert(assuranceChallenges).values({
    ...session, purpose, publicId, challengeHash: challengeHash(deps, challenge),
    expiresAt: new Date(+now + TTL_MS), createdAt: now,
  });
  return publicId;
}

/** Called only while holding the per-account lock. Consumer commits deletion even for invalid proofs. */
async function takeChallenge(deps: ModuleDeps, tx: Tx, session: BoundSession, purpose: Ceremony, publicId: string) {
  const where = and(scope(session, purpose), eq(assuranceChallenges.publicId, publicId));
  const [row] = await tx.select().from(assuranceChallenges).where(where).limit(1).for("update");
  if (!row) return null;
  await tx.delete(assuranceChallenges).where(where);
  if (+row.expiresAt <= +deps.clock.now()) return null;
  return (value: string) => matches(row.challengeHash, challengeHash(deps, value));
}

function isSameOriginClientData(encoded: string): boolean {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null) return false;
    return (!("crossOrigin" in value) || value.crossOrigin === false) && !("topOrigin" in value);
  } catch {
    return false;
  }
}

export async function beginRegistration(deps: ModuleDeps, tx: Tx, session: SessionPrincipal, label: string) {
  const current = await getPasskeys(tx, session.userId);
  if (current.length >= PASSKEY_LIMIT) throw conflict("PASSKEY_LIMIT", "Remove an existing passkey before adding another.");
  const { rpID } = binding(deps);
  const options = await generateRegistrationOptions({
    rpName: "ReadyPackets", rpID, userID: Buffer.from(session.userPublicId, "utf8"), userName: label,
    attestationType: "none", timeout: TTL_MS,
    supportedAlgorithmIDs: [...ALGORITHMS],
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: current.map((key) => ({ id: key.credentialId })),
  });
  const challengeId = await saveChallenge(deps, tx, { userId: session.userId, sessionId: session.sessionId }, "register", options.challenge);
  return { challengeId, options };
}

export async function finishRegistration(
  deps: ModuleDeps, tx: Tx, session: SessionPrincipal, challengeId: string, response: RegistrationResponseJSON, name: string,
): Promise<string | null> {
  const expectedChallenge = await takeChallenge(deps, tx, session, "register", challengeId);
  if (!expectedChallenge || !isSameOriginClientData(response.response.clientDataJSON)) return null;
  const { rpID, origin } = binding(deps);
  const result = await verifyRegistrationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
    requireUserVerification: true, supportedAlgorithmIDs: [...ALGORITHMS],
  }).catch(() => null);
  if (!result?.verified || result.registrationInfo.fmt !== "none") return null;
  const { credential } = result.registrationInfo;
  // Both checks run inside the account lock. Global uniqueness is also enforced by MySQL.
  if ((await getPasskeys(tx, session.userId)).length >= PASSKEY_LIMIT) return null;
  const credentialIndex = deps.crypto.blindIndex(credential.id, "assurance-passkey-credential");
  const now = deps.clock.now();
  const publicId = ulid(+now);
  try {
    await tx.insert(assurancePasskeys).values({
      publicId, userId: session.userId, credentialId: credential.id, credentialIndex,
      counter: credential.counter, publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      nameEnc: deps.crypto.encrypt(name, `assurance_passkeys.name_enc:${publicId}`), createdAt: now, updatedAt: now,
    });
  } catch (error) {
    // Drizzle wraps the original MySQL error. A duplicated credential is not application state.
    if (error instanceof Error && typeof error.cause === "object" && error.cause !== null
      && "code" in error.cause && error.cause.code === "ER_DUP_ENTRY") return null;
    throw error;
  }
  return publicId;
}

export async function beginAuthentication(deps: ModuleDeps, tx: Tx, session: SessionPrincipal, purpose: AuthenticationPurpose) {
  const keys = await getPasskeys(tx, session.userId);
  if (keys.length === 0) throw conflict("PASSKEY_NOT_ENROLLED", "There is no passkey registered for this account.");
  const options = await generateAuthenticationOptions({
    rpID: binding(deps).rpID, timeout: TTL_MS, userVerification: "required",
    allowCredentials: keys.map((key) => ({ id: key.credentialId })),
  });
  const challengeId = await saveChallenge(deps, tx, { userId: session.userId, sessionId: session.sessionId }, purpose, options.challenge);
  return { challengeId, options };
}

export async function verifyAuthentication(
  deps: ModuleDeps, tx: Tx, session: BoundSession, purpose: AuthenticationPurpose,
  challengeId: string, response: AuthenticationResponseJSON, userPublicId?: string,
): Promise<"valid" | "invalid" | "counter_regression"> {
  const expectedChallenge = await takeChallenge(deps, tx, session, purpose, challengeId);
  if (!expectedChallenge || !isSameOriginClientData(response.response.clientDataJSON)
    || (response.response.userHandle !== undefined && userPublicId !== undefined
      && !matches(response.response.userHandle, Buffer.from(userPublicId).toString("base64url"))))
    return "invalid";
  const credentialIndex = deps.crypto.blindIndex(response.id, "assurance-passkey-credential");
  const [key] = await tx.select().from(assurancePasskeys).where(and(
    eq(assurancePasskeys.userId, session.userId), eq(assurancePasskeys.credentialIndex, credentialIndex),
  )).limit(1).for("update");
  if (!key || !matches(key.credentialId, response.id)) return "invalid";
  const { rpID, origin } = binding(deps);
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    // Compare the persisted counter only AFTER verifying the signature, so a regression audit
    // reflects a signed assertion. Both-zero is supported by counterless authenticators.
    credential: { id: key.credentialId, counter: 0, publicKey: Buffer.from(key.publicKey, "base64url") },
  }).catch(() => null);
  if (!result?.verified) return "invalid";
  const next = result.authenticationInfo.newCounter;
  if (key.counter > 0 && next <= key.counter) return "counter_regression";
  const now = deps.clock.now();
  await tx.update(assurancePasskeys).set({ counter: next, lastUsedAt: now, updatedAt: now }).where(eq(assurancePasskeys.id, key.id));
  return "valid";
}
