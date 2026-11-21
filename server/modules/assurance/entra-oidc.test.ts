import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { entraEndpoints, verifyIdToken } from "../identity/sso/oidc.js";
import { assessEntraSignIn, isFreshEntraAuthentication } from "./entra.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const oid = "44444444-4444-4444-8444-444444444444";
const nonce = "synthetic-nonce";
const nowSeconds = 1_800_000_000;
const expected = { tenantId, clientId, nonce, nowSeconds };
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
const claims = {
  iss: entraEndpoints(tenantId).issuer, tid: tenantId, aud: clientId, oid, sub: "synthetic-subject",
  exp: nowSeconds + 300, iat: nowSeconds, auth_time: nowSeconds, nonce, amr: ["pwd", "mfa"],
};
function token(overrides: Record<string, unknown> = {}, alg = "RS256", signed = true): string {
  const payload = `${encode({ alg, kid: "synthetic" })}.${encode({ ...claims, ...overrides })}`;
  const signature = signed ? sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url") : "";
  return `${payload}.${signature}`;
}

describe("Entra ID assurance claim boundary", () => {
  it("rejects a correctly signed token from another tenant or for another application", () => {
    expect(() => verifyIdToken(token({ tid: otherTenant }), jwk, expected)).toThrow("TOKEN_TENANT_MISMATCH");
    expect(() => verifyIdToken(token({ tid: otherTenant, iss: entraEndpoints(otherTenant).issuer }), jwk, expected))
      .toThrow("TOKEN_ISSUER_MISMATCH");
    expect(() => verifyIdToken(token({ aud: "other-app" }), jwk, expected)).toThrow("TOKEN_AUDIENCE_MISMATCH");
  });

  it("rejects unsigned tokens and the none algorithm before accepting any authentication claims", () => {
    expect(() => verifyIdToken(token({}, "RS256", false), jwk, expected)).toThrow("TOKEN_MALFORMED");
    expect(() => verifyIdToken(token({}, "none", false), jwk, expected)).toThrow("TOKEN_ALG_NOT_ALLOWED");
  });

  it("allows validated trusted MFA at ordinary sign-in, but never uses a fresh issue time as fresh authentication", () => {
    const verified = verifyIdToken(token({ auth_time: nowSeconds - 1 }), jwk, expected);
    const now = new Date(nowSeconds * 1000);
    expect(assessEntraSignIn(verified.amr, false).mfaVerified).toBe(false);
    expect(assessEntraSignIn(verified.amr, true).mfaVerified).toBe(true);
    expect(isFreshEntraAuthentication(verified.authTime!, now, now)).toBe(false);
    expect(isFreshEntraAuthentication(verifyIdToken(token(), jwk, expected).authTime!, now, now)).toBe(true);
  });
});
