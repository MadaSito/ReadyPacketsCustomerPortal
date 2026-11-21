/**
 * Microsoft Entra ID OpenID Connect primitives (pure, no I/O). Owner: identity engineer.
 *
 * ID-token verification uses node:crypto only (approved by /root — no JOSE dependency):
 *  - algorithm allow-list: RS256 only. `none`, HS*, ES*, PS* and any `crit` header are refused;
 *  - the signing key is looked up by `kid` in the tenant JWKS (RSA, `use` sig when present);
 *  - issuer, audience, tenant, exp / nbf / iat (bounded skew), nonce and the subject claims are checked.
 */
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from "node:crypto";

export const ENTRA_LOGIN_HOST = "login.microsoftonline.com";
export const ALLOWED_ALGORITHMS = ["RS256"] as const;
/** Clock skew tolerated on exp / nbf / iat (seconds). */
export const CLOCK_SKEW_SECONDS = 120;
/** ID tokens older than this (by iat) are refused even if exp is later. */
export const MAX_TOKEN_AGE_SECONDS = 10 * 60;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN_LENGTH = 16_384;

export function isTenantGuid(value: string): boolean {
  return GUID.test(value);
}

export const entraEndpoints = (tenantId: string) => {
  if (!isTenantGuid(tenantId)) throw new Error("tenant id must be a GUID");
  const base = `https://${ENTRA_LOGIN_HOST}/${tenantId}`;
  return {
    authorize: `${base}/oauth2/v2.0/authorize`,
    token: `${base}/oauth2/v2.0/token`,
    jwks: `${base}/discovery/v2.0/keys`,
    issuer: `${base}/v2.0`,
  };
};

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function authorizationUrl(input: {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  verifier: string;
  /** Force a fresh interactive authentication (step-up): `prompt=login` + `max_age=0`. */
  forceReauthentication: boolean;
  loginHint?: string;
}): string {
  const url = new URL(entraEndpoints(input.tenantId).authorize);
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    state: input.state,
    nonce: input.nonce,
    code_challenge: pkceChallenge(input.verifier),
    code_challenge_method: "S256",
  });
  if (input.forceReauthentication) {
    params.set("prompt", "login");
    params.set("max_age", "0");
  } else {
    params.set("prompt", "select_account");
  }
  url.search = params.toString();
  return url.href;
}

export class OidcValidationError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "OidcValidationError";
  }
}
const fail = (reason: string): never => {
  throw new OidcValidationError(reason);
};

export interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

export interface VerifiedEntraClaims {
  tenantId: string;
  objectId: string;
  /** Authentication methods references (`mfa`, `pwd`, …) exactly as asserted; may be absent. */
  amr: string[] | undefined;
  /** OIDC NumericDate seconds; undefined when Entra did not include it. */
  authTime: number | undefined;
  issuedAt: number;
  /** Mutable, unverified hints — NEVER used for linking or authorization. */
  email: string | null;
  name: string | null;
  /** App roles assigned in the enterprise application. */
  roles: string[];
}

function decodeSegment(segment: string, reason: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) fail(reason);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(reason);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OidcValidationError) throw error;
    return fail(reason);
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const int = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** Header only — used to pick the key before verification. */
export function peekKeyId(idToken: string): string {
  if (typeof idToken !== "string" || idToken.length > MAX_TOKEN_LENGTH) fail("TOKEN_MALFORMED");
  const parts = idToken.split(".");
  if (parts.length !== 3) fail("TOKEN_MALFORMED");
  const header = decodeSegment(parts[0]!, "TOKEN_MALFORMED");
  const alg = str(header.alg);
  if (!alg || !(ALLOWED_ALGORITHMS as readonly string[]).includes(alg)) fail("TOKEN_ALG_NOT_ALLOWED");
  if (header.crit !== undefined) fail("TOKEN_CRIT_UNSUPPORTED");
  const kid = str(header.kid);
  if (!kid || kid.length > 256) fail("TOKEN_KID_MISSING");
  return kid!;
}

export function selectKey(keys: readonly Jwk[], kid: string): Jwk | null {
  const key = keys.find((k) => k.kid === kid);
  if (!key) return null;
  if (key.kty !== "RSA" || (key.use !== undefined && key.use !== "sig")) return null;
  if (key.alg !== undefined && key.alg !== "RS256") return null;
  if (typeof key.n !== "string" || typeof key.e !== "string") return null;
  return key;
}

/**
 * Full validation of an Entra v2.0 ID token. Throws OidcValidationError with a fixed reason code; never
 * includes token content in the error.
 */
export function verifyIdToken(
  idToken: string,
  key: Jwk,
  expected: { tenantId: string; clientId: string; nonce: string; nowSeconds: number },
): VerifiedEntraClaims {
  peekKeyId(idToken);
  const [h, p, s] = idToken.split(".") as [string, string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(s)) fail("TOKEN_MALFORMED");
  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e } as JsonWebKey, format: "jwk" });
  } catch {
    return fail("TOKEN_KEY_INVALID");
  }
  const details = publicKey.asymmetricKeyDetails;
  if (publicKey.asymmetricKeyType !== "rsa" || !details?.modulusLength || details.modulusLength < 2048) fail("TOKEN_KEY_INVALID");
  const signature = Buffer.from(s, "base64url");
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`, "ascii"), publicKey, signature);
  if (!ok) fail("TOKEN_SIGNATURE_INVALID");

  const claims = decodeSegment(p, "TOKEN_MALFORMED");
  const { issuer } = entraEndpoints(expected.tenantId);
  if (str(claims.iss) !== issuer) fail("TOKEN_ISSUER_MISMATCH");
  const aud = claims.aud;
  if (Array.isArray(aud) ? aud.length !== 1 || aud[0] !== expected.clientId : aud !== expected.clientId) fail("TOKEN_AUDIENCE_MISMATCH");
  if (claims.azp !== undefined && claims.azp !== expected.clientId) fail("TOKEN_AUDIENCE_MISMATCH");
  if (str(claims.tid) !== expected.tenantId) fail("TOKEN_TENANT_MISMATCH");
  const now = expected.nowSeconds;
  const exp = int(claims.exp);
  const iat = int(claims.iat);
  const nbf = claims.nbf === undefined ? undefined : int(claims.nbf);
  if (exp === undefined || iat === undefined || (claims.nbf !== undefined && nbf === undefined)) fail("TOKEN_TIME_INVALID");
  if (exp! <= now - CLOCK_SKEW_SECONDS) fail("TOKEN_EXPIRED");
  if (nbf !== undefined && nbf > now + CLOCK_SKEW_SECONDS) fail("TOKEN_NOT_YET_VALID");
  if (iat! > now + CLOCK_SKEW_SECONDS || iat! < now - MAX_TOKEN_AGE_SECONDS) fail("TOKEN_TIME_INVALID");
  const nonce = str(claims.nonce);
  if (!nonce || !constantTimeEqual(nonce, expected.nonce)) fail("TOKEN_NONCE_MISMATCH");
  const oid = str(claims.oid)?.toLowerCase();
  if (!oid || !GUID.test(oid)) fail("TOKEN_SUBJECT_INVALID");
  if (!str(claims.sub)) fail("TOKEN_SUBJECT_INVALID");

  const authTimeRaw = claims.auth_time;
  const authTime = authTimeRaw === undefined ? undefined : int(authTimeRaw);
  if (authTimeRaw !== undefined && authTime === undefined) fail("TOKEN_TIME_INVALID");
  const amrRaw = claims.amr;
  let amr: string[] | undefined;
  if (amrRaw !== undefined) {
    if (!Array.isArray(amrRaw) || amrRaw.length > 16 || !amrRaw.every((v) => typeof v === "string" && v.length <= 32)) fail("TOKEN_CLAIM_INVALID");
    amr = amrRaw as string[];
  }
  const rolesRaw = claims.roles;
  const roles = Array.isArray(rolesRaw) ? rolesRaw.filter((v): v is string => typeof v === "string" && v.length <= 120).slice(0, 50) : [];
  const email = str(claims.email) ?? str(claims.preferred_username) ?? null;
  return {
    tenantId: expected.tenantId,
    objectId: oid!,
    amr,
    authTime,
    issuedAt: iat!,
    email: email && email.length <= 320 && email.includes("@") ? email.toLowerCase() : null,
    name: str(claims.name)?.slice(0, 120) ?? null,
    roles,
  };
}

export function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
export function isValidDomain(value: string): boolean {
  return DOMAIN.test(value);
}
