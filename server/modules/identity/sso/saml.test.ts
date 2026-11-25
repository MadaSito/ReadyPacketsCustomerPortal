/** SAML 2.0 validation (increment 07, D10): signature, XSW, algorithms, audience / recipient / issuer / tenant, time, DTD. */
import { describe, expect, it } from "vitest";
import {
  buildAuthnRequestUrl, isAllowedMetadataUrl, isValidEntityId, parseCertificate, parseFederationMetadata, samlMfaFacts, SamlValidationError,
  serviceProviderMetadata, spUrls, verifySamlResponse, ENTRA_MULTIPLE_AUTHN,
} from "./saml.js";
import { buildFederationMetadata, buildSignedResponse, createTestIdpKey, randomRequestId, TEST_IDP, TEST_SAML_TENANT } from "./samlTesting.js";
import { inflateRawSync } from "node:zlib";

const sp = spUrls("https://portal.example.test", null);
const NOW = Date.UTC(2026, 10, 24, 15, 0, 0);
const ctx = { tenantId: TEST_SAML_TENANT, sp, certificates: [TEST_IDP.certificatePem], nowMs: NOW };

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ACCEPTED";
  } catch (error) {
    if (error instanceof SamlValidationError) return error.reasonCode;
    throw error;
  }
}

describe("verifySamlResponse", () => {
  it("accepts a valid Entra-shaped response and returns only verified values", async () => {
    const irt = randomRequestId();
    const result = await verifySamlResponse(buildSignedResponse({ sp, inResponseTo: irt, nowMs: NOW, roles: ["Portal.Staff"] }), ctx);
    expect(result.inResponseTo).toBe(irt);
    expect(result.tenantId).toBe(TEST_SAML_TENANT);
    expect(result.objectId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result.email).toBe("person@example.test");
    expect(result.roles).toEqual(["Portal.Staff"]);
    expect(result.methods).toContain(ENTRA_MULTIPLE_AUTHN);
    expect(result.attributeNames.length).toBeGreaterThan(3);
  });

  it("refuses XML signature wrapping (a second assertion, sibling or hidden in Extensions)", async () => {
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, wrap: "sibling" }), ctx))).toBe("ASSERTION_COUNT_INVALID");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, wrap: "extensions" }), ctx))).toBe("ASSERTION_COUNT_INVALID");
  });

  it("refuses unsigned, tampered and foreign-key signed assertions", async () => {
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, unsigned: true }), ctx))).toBe("ASSERTION_NOT_SIGNED");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, tamperAfterSigning: true }), ctx))).toBe("SIGNATURE_OR_ASSERTION_INVALID");
    const other = createTestIdpKey({ cn: "Attacker" });
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, key: other }), ctx))).toBe("SIGNATURE_OR_ASSERTION_INVALID");
  });

  it("refuses SHA-1 signatures", async () => {
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, algorithm: "sha1" }), ctx))).toBe("SIGNATURE_ALGORITHM_REFUSED");
  });

  it("refuses a wrong audience, recipient, destination, issuer or tenant", async () => {
    const irt = () => randomRequestId();
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: irt(), nowMs: NOW, audience: "https://other.example.test/sp" }), ctx))).toMatch(/AUDIENCE_MISMATCH|SIGNATURE_OR_ASSERTION_INVALID/);
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: irt(), nowMs: NOW, recipient: "https://evil.example.test/acs" }), ctx))).toBe("BEARER_CONFIRMATION_INVALID");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: irt(), nowMs: NOW, destination: "https://evil.example.test/acs" }), ctx))).toBe("DESTINATION_MISMATCH");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: irt(), nowMs: NOW, issuer: "https://sts.windows.net/99999999-2222-3333-4444-555555555555/" }), ctx))).toMatch(/ISSUER_MISMATCH|SIGNATURE_OR_ASSERTION_INVALID/);
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: irt(), nowMs: NOW, tenantClaim: "99999999-2222-3333-4444-555555555555" }), ctx))).toBe("TENANT_MISMATCH");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: irt(), nowMs: NOW, tenantClaim: null }), ctx))).toBe("TENANT_CLAIM_MISSING");
  });

  it("refuses expired, stale and future assertions (2-minute skew)", async () => {
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), issueInstantMs: NOW - 10 * 60_000, lifetimeMs: 5 * 60_000 }), ctx))).toMatch(/ASSERTION_TOO_OLD_OR_FUTURE|ASSERTION_EXPIRED/);
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), issueInstantMs: NOW + 5 * 60_000 }), ctx))).toBe("ASSERTION_TOO_OLD_OR_FUTURE");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), issueInstantMs: NOW + 60_000 }), ctx))).toBe("ACCEPTED");
  });

  it("refuses DTDs, encrypted assertions, a non-success status, a missing object id and bad request ids", async () => {
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, doctype: true }), ctx))).toBe("DTD_REFUSED");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, encrypted: true }), ctx))).toBe("ENCRYPTED_ASSERTION_UNSUPPORTED");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, statusCode: "urn:oasis:names:tc:SAML:2.0:status:Responder" }), ctx))).toBe("IDP_STATUS_NOT_SUCCESS");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW, objectId: null }), ctx))).toBe("OBJECT_ID_MISSING");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: "short", nowMs: NOW }), ctx))).toBe("IN_RESPONSE_TO_INVALID");
    expect(await reason(verifySamlResponse("not base64 !!", ctx))).toBe("RESPONSE_SIZE_INVALID");
    expect(await reason(verifySamlResponse(buildSignedResponse({ sp, inResponseTo: randomRequestId(), nowMs: NOW }), { ...ctx, certificates: [] }))).toBe("NO_TRUSTED_CERTIFICATE");
  });
});

describe("SAML helpers", () => {
  it("MFA facts: multipleauthn or an accepted context", () => {
    expect(samlMfaFacts({ methods: [ENTRA_MULTIPLE_AUTHN], authnContextClassRef: null }, [])).toEqual({ multipleAuthn: true, acceptedContext: false });
    expect(samlMfaFacts({ methods: [], authnContextClassRef: "urn:x:mfa" }, ["urn:x:mfa"])).toEqual({ multipleAuthn: false, acceptedContext: true });
    expect(samlMfaFacts({ methods: [], authnContextClassRef: "urn:x:pwd" }, ["urn:x:mfa"])).toEqual({ multipleAuthn: false, acceptedContext: false });
  });

  it("builds a redirect AuthnRequest with our request id, ACS and ForceAuthn, without RelayState", async () => {
    const requestId = randomRequestId();
    const url = new URL(await buildAuthnRequestUrl({ tenantId: TEST_SAML_TENANT, sp, certificates: [TEST_IDP.certificatePem], requestId, forceAuthn: true }));
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TEST_SAML_TENANT}/saml2`);
    expect(url.searchParams.has("RelayState")).toBe(false);
    const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
    expect(xml).toContain(`ID="${requestId}"`);
    expect(xml).toContain(`AssertionConsumerServiceURL="${sp.acsUrl}"`);
    expect(xml).toContain('ForceAuthn="true"');
    expect(xml).not.toContain("RequestedAuthnContext");
  });

  it("validates Identifiers and metadata URLs", () => {
    expect(isValidEntityId("https://portal.example.test/sp")).toBe(true);
    expect(isValidEntityId("urn:readypackets:portal")).toBe(true);
    expect(isValidEntityId("http://portal.example.test/sp")).toBe(false);
    expect(isValidEntityId("https://x y")).toBe(false);
    expect(isAllowedMetadataUrl(`https://login.microsoftonline.com/${TEST_SAML_TENANT}/federationmetadata/2007-06/federationmetadata.xml?appid=1`, TEST_SAML_TENANT)).toBe(true);
    expect(isAllowedMetadataUrl("https://evil.example.test/federationmetadata.xml", TEST_SAML_TENANT)).toBe(false);
    expect(isAllowedMetadataUrl(`https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/x`, TEST_SAML_TENANT)).toBe(false);
  });

  it("parses certificates and refuses weak keys", () => {
    const parsed = parseCertificate(TEST_IDP.certificatePem);
    expect(parsed.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseCertificate(TEST_IDP.certificateBody).fingerprintSha256).toBe(parsed.fingerprintSha256);
    const weak = createTestIdpKey({ bits: 1024 });
    expect(() => parseCertificate(weak.certificatePem)).toThrow("CERTIFICATE_KEY_WEAK");
    expect(() => parseCertificate("garbage")).toThrow("CERTIFICATE_INVALID");
  });

  it("reads signing certificates from federation metadata for exactly this tenant", async () => {
    const certs = await parseFederationMetadata(buildFederationMetadata(), TEST_SAML_TENANT);
    expect(certs).toHaveLength(1);
    await expect(parseFederationMetadata(buildFederationMetadata({ tenantId: "99999999-2222-3333-4444-555555555555" }), TEST_SAML_TENANT)).rejects.toThrow("METADATA_TENANT_MISMATCH");
    await expect(parseFederationMetadata(`<!DOCTYPE x>${buildFederationMetadata()}`, TEST_SAML_TENANT)).rejects.toThrow("DTD_REFUSED");
  });

  it("publishes SP metadata with our entity id and ACS", () => {
    const xml = serviceProviderMetadata(sp);
    expect(xml).toContain(`entityID="${sp.entityId}"`);
    expect(xml).toContain(`Location="${sp.acsUrl}"`);
    expect(xml).toContain('WantAssertionsSigned="true"');
  });
});
