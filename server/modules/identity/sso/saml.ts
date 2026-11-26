/**
 * Microsoft Entra ID SAML 2.0 service-provider primitives (increment 07, D10; ADR 0062). Owner: identity engineer.
 *
 * `@node-saml/node-saml` 5.2.0 (pinned; xml-crypto 6.4.0, @xmldom/xmldom 0.8.15) verifies the XML signature against
 * the PINNED certificates only. This wrapper does not rely on library defaults: before the library runs it refuses
 * DTDs, oversize input, encrypted or multiple assertions and weak algorithms; afterwards it re-reads ONLY the
 * verified assertion XML returned by the library and enforces issuer, tenant, audience, recipient, bearer method,
 * InResponseTo presence, time bounds (deps.clock, 2 minutes skew; the library's own clock checks are disabled
 * with acceptedClockSkewMs = -1) and the object id claim itself. node-saml 5.2.0 only warns on a wrong
 * Destination / Recipient and does not check InResponseTo unless asked — both are enforced here and in the service.
 *
 * SP-initiated only. No single logout. No encrypted assertions. No signed AuthnRequests (v1).
 */
import { X509Certificate, createHash } from "node:crypto";
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata } from "@node-saml/node-saml";
// The library's own pinned parser (xmldom 0.8.15 with fatal error handling). Deep import is safe: exact pin.
import { parseDomFromString } from "@node-saml/node-saml/lib/xml.js";
import { ENTRA_LOGIN_HOST, isTenantGuid } from "./oidc.js";

export const SAML_METADATA_PATH = "/api/identity/saml/metadata";
export const SAML_START_PATH = "/api/identity/saml/start";
export const SAML_ACS_PATH = "/api/identity/saml/acs";

/** Form field limit (base64 characters). The ingress cap on the whole body is also 256 KiB. */
export const MAX_SAML_RESPONSE_CHARS = 256 * 1024;
export const SAML_CLOCK_SKEW_MS = 2 * 60_000;
/** An assertion issued longer ago than this (plus skew) is refused even if NotOnOrAfter is later. */
export const SAML_MAX_ASSERTION_AGE_MS = 5 * 60_000;
export const MAX_METADATA_BYTES = 512 * 1024;
export const MAX_TRUSTED_CERTIFICATES = 2;

const NS = {
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  dsig: "http://www.w3.org/2000/09/xmldsig#",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
} as const;
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

export const SAML_CLAIMS = {
  tenantId: "http://schemas.microsoft.com/identity/claims/tenantid",
  objectId: "http://schemas.microsoft.com/identity/claims/objectidentifier",
  methods: "http://schemas.microsoft.com/claims/authnmethodsreferences",
  displayName: "http://schemas.microsoft.com/identity/claims/displayname",
  email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  givenName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  surname: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  role: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
} as const;
/** The value Entra puts in authnmethodsreferences when the sign-in satisfied MFA. */
export const ENTRA_MULTIPLE_AUTHN = "http://schemas.microsoft.com/claims/multipleauthn";
/** Claims the setup page lists as required. */
export const REQUIRED_SAML_CLAIMS = [SAML_CLAIMS.objectId, SAML_CLAIMS.tenantId, SAML_CLAIMS.methods] as const;

const STRONG_SIGNATURE_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
]);
const STRONG_DIGEST_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmldsig-more#sha384",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

export class SamlValidationError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "SamlValidationError";
  }
}
const fail = (code: string): never => {
  throw new SamlValidationError(code);
};

export const samlEndpoints = (tenantId: string) => {
  if (!isTenantGuid(tenantId)) throw new Error("tenant id must be a GUID");
  return {
    signOn: `https://${ENTRA_LOGIN_HOST}/${tenantId}/saml2`,
    issuer: `https://sts.windows.net/${tenantId}/`,
    metadata: `https://${ENTRA_LOGIN_HOST}/${tenantId}/federationmetadata/2007-06/federationmetadata.xml`,
  };
};

export interface SpUrls {
  entityId: string;
  acsUrl: string;
  signOnUrl: string;
  metadataUrl: string;
}

export function spUrls(canonicalOrigin: string, entityIdOverride: string | null): SpUrls {
  const origin = canonicalOrigin.replace(/\/$/, "");
  return {
    entityId: entityIdOverride ?? `${origin}${SAML_METADATA_PATH}`,
    acsUrl: `${origin}${SAML_ACS_PATH}`,
    signOnUrl: `${origin}${SAML_START_PATH}`,
    metadataUrl: `${origin}${SAML_METADATA_PATH}`,
  };
}

/** Admin-supplied Identifier: an absolute https URL or a urn / api:// value, bounded, no whitespace or controls. */
export function isValidEntityId(value: string): boolean {
  if (value.length < 8 || value.length > 255 || /[\s\p{Cc}<>"']/u.test(value)) return false;
  if (/^(urn:|api:\/\/)/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** Metadata URL import is https on login.microsoftonline.com, for exactly the configured tenant. */
export function isAllowedMetadataUrl(raw: string, tenantId: string): boolean {
  if (raw.length > 512) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === ENTRA_LOGIN_HOST && url.port === "" && !url.username && !url.password
      && url.pathname.toLowerCase().startsWith(`/${tenantId}/`) && !url.hash;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ certificates */

export interface ParsedCertificate {
  pem: string;
  fingerprintSha256: string;
  subject: string | null;
  notBefore: Date;
  notAfter: Date;
}

/** Accepts a PEM or the bare base64 body (as in metadata). Public RSA ≥ 2048 bits only. */
export function parseCertificate(input: string): ParsedCertificate {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (body.length < 200 || body.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) fail("CERTIFICATE_INVALID");
  const der = Buffer.from(body, "base64");
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(der);
  } catch {
    return fail("CERTIFICATE_INVALID");
  }
  const details = cert.publicKey.asymmetricKeyDetails;
  if (cert.publicKey.asymmetricKeyType !== "rsa" || (details?.modulusLength ?? 0) < 2048) fail("CERTIFICATE_KEY_WEAK");
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  const cn = /(?:^|\n)CN=([^\n]{1,200})/.exec(cert.subject)?.[1] ?? null;
  return {
    pem: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
    fingerprintSha256: createHash("sha256").update(der).digest("hex"),
    subject: cn ? cn.replace(/[\p{Cc}<>]/gu, "").slice(0, 200) : null,
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
  };
}

/* ------------------------------------------------------------------ DOM helpers (verified documents only) */

type El = Element;
const childrenNs = (parent: El, ns: string, local: string): El[] => {
  const out: El[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as El).namespaceURI === ns && (n as El).localName === local) out.push(n as El);
  }
  return out;
};
const childNs = (parent: El, ns: string, local: string): El | null => childrenNs(parent, ns, local)[0] ?? null;
const text = (el: El | null): string | null => {
  const value = el?.textContent?.trim();
  return value ? value : null;
};
const attr = (el: El | null, name: string): string | null => {
  const value = el?.getAttribute(name);
  return value ? value : null;
};
const parseInstant = (value: string | null, code: string): number => {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value)) return fail(code);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fail(code);
};

async function parseXml(xml: string, code: string): Promise<Document> {
  // DTDs and entity declarations are never legitimate in a SAML message or Entra metadata (XXE / bombs).
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("DTD_REFUSED");
  try {
    return await parseDomFromString(xml);
  } catch {
    return fail(code);
  }
}

function assertStrongSignatures(doc: Document): void {
  const signatures = doc.getElementsByTagNameNS(NS.dsig, "Signature");
  for (let i = 0; i < signatures.length; i += 1) {
    const signedInfo = childNs(signatures[i]!, NS.dsig, "SignedInfo");
    const method = attr(signedInfo && childNs(signedInfo, NS.dsig, "SignatureMethod"), "Algorithm");
    if (!method || !STRONG_SIGNATURE_ALGORITHMS.has(method)) fail("SIGNATURE_ALGORITHM_REFUSED");
    const references = signedInfo ? childrenNs(signedInfo, NS.dsig, "Reference") : [];
    if (references.length !== 1) fail("SIGNATURE_REFERENCE_INVALID");
    const digest = attr(childNs(references[0]!, NS.dsig, "DigestMethod"), "Algorithm");
    if (!digest || !STRONG_DIGEST_ALGORITHMS.has(digest)) fail("DIGEST_ALGORITHM_REFUSED");
  }
}

/* ------------------------------------------------------------------ AuthnRequest */

export async function buildAuthnRequestUrl(input: {
  tenantId: string;
  sp: SpUrls;
  certificates: readonly string[];
  requestId: string;
  forceAuthn: boolean;
}): Promise<string> {
  if (!/^_[A-Za-z0-9_-]{20,80}$/.test(input.requestId)) throw new Error("request id must be an NCName");
  const saml = new SAML({
    entryPoint: samlEndpoints(input.tenantId).signOn,
    issuer: input.sp.entityId,
    callbackUrl: input.sp.acsUrl,
    idpCert: [...input.certificates],
    identifierFormat: null,
    // RequestedAuthnContext would force password authentication at Entra (breaks passwordless and MFA).
    disableRequestedAuthnContext: true,
    forceAuthn: input.forceAuthn,
    generateUniqueId: () => input.requestId,
    validateInResponseTo: ValidateInResponseTo.never,
    acceptedClockSkewMs: -1,
  });
  // No RelayState: the request is found by its (signed) InResponseTo; the next path stays server-side.
  const url = await saml.getAuthorizeUrlAsync("", undefined, {});
  const parsed = new URL(url);
  parsed.searchParams.delete("RelayState");
  return parsed.toString();
}

/* ------------------------------------------------------------------ Response validation */

export interface VerifiedSamlAssertion {
  assertionId: string;
  inResponseTo: string;
  issueInstantMs: number;
  authnInstantMs: number;
  authnContextClassRef: string | null;
  tenantId: string;
  objectId: string;
  methods: string[];
  roles: string[];
  email: string | null;
  name: string | null;
  /** D1: givenname / surname claims (name hints only). */
  givenName: string | null;
  familyName: string | null;
  /** Attribute names present (never values) — for "Test sign-in". */
  attributeNames: string[];
}

export interface SamlValidationContext {
  tenantId: string;
  sp: SpUrls;
  certificates: readonly string[];
  nowMs: number;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,253}$/;

export async function verifySamlResponse(samlResponse: unknown, ctx: SamlValidationContext): Promise<VerifiedSamlAssertion> {
  if (ctx.certificates.length === 0) fail("NO_TRUSTED_CERTIFICATE");
  if (typeof samlResponse !== "string" || samlResponse.length < 100 || samlResponse.length > MAX_SAML_RESPONSE_CHARS) fail("RESPONSE_SIZE_INVALID");
  const compact = (samlResponse as string).replace(/[\r\n]/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) fail("RESPONSE_ENCODING_INVALID");
  const xml = Buffer.from(compact, "base64").toString("utf8");
  const raw = await parseXml(xml, "XML_MALFORMED");
  const root = raw.documentElement;
  if (!root || root.namespaceURI !== NS.protocol || root.localName !== "Response") fail("NOT_A_RESPONSE");
  const statusCode = attr(childNs(childNs(root!, NS.protocol, "Status") ?? root!, NS.protocol, "StatusCode"), "Value");
  if (statusCode !== STATUS_SUCCESS) fail("IDP_STATUS_NOT_SUCCESS");
  // Exactly one assertion anywhere in the document, as a direct child of the Response (XSW defence).
  if (raw.getElementsByTagNameNS(NS.assertion, "EncryptedAssertion").length > 0) fail("ENCRYPTED_ASSERTION_UNSUPPORTED");
  if (raw.getElementsByTagNameNS(NS.assertion, "Assertion").length !== 1 || childrenNs(root!, NS.assertion, "Assertion").length !== 1) {
    fail("ASSERTION_COUNT_INVALID");
  }
  const rawAssertion = childNs(root!, NS.assertion, "Assertion")!;
  if (childrenNs(rawAssertion, NS.dsig, "Signature").length !== 1) fail("ASSERTION_NOT_SIGNED");
  assertStrongSignatures(raw);
  // The Response itself is usually unsigned (Entra signs the assertion); if a Destination is sent it must be ours.
  const destination = attr(root!, "Destination");
  if (destination !== null && destination !== ctx.sp.acsUrl) fail("DESTINATION_MISMATCH");

  const issuer = samlEndpoints(ctx.tenantId).issuer;
  const saml = new SAML({
    idpCert: [...ctx.certificates],
    issuer: ctx.sp.entityId,
    audience: ctx.sp.entityId,
    callbackUrl: ctx.sp.acsUrl,
    idpIssuer: issuer,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    identifierFormat: null,
    validateInResponseTo: ValidateInResponseTo.never,
    acceptedClockSkewMs: -1,
  });
  let assertionXml: string;
  try {
    const result = await saml.validatePostResponseAsync({ SAMLResponse: compact });
    if (result.loggedOut || !result.profile?.getAssertionXml) return fail("SIGNATURE_OR_ASSERTION_INVALID");
    assertionXml = result.profile.getAssertionXml();
  } catch (error) {
    if (error instanceof SamlValidationError) throw error;
    return fail("SIGNATURE_OR_ASSERTION_INVALID");
  }

  // From here on, read ONLY the bytes the signature covers.
  const verified = await parseXml(assertionXml, "VERIFIED_XML_MALFORMED");
  const a = verified.documentElement;
  if (!a || a.namespaceURI !== NS.assertion || a.localName !== "Assertion") fail("VERIFIED_XML_MALFORMED");
  const assertion = a!;
  const assertionId = attr(assertion, "ID");
  if (!assertionId || assertionId.length > 256) fail("ASSERTION_ID_MISSING");
  if (text(childNs(assertion, NS.assertion, "Issuer")) !== issuer) fail("ISSUER_MISMATCH");

  const skew = SAML_CLOCK_SKEW_MS;
  const now = ctx.nowMs;
  const issueInstantMs = parseInstant(attr(assertion, "IssueInstant"), "ISSUE_INSTANT_INVALID");
  if (issueInstantMs > now + skew || now - issueInstantMs > SAML_MAX_ASSERTION_AGE_MS + skew) fail("ASSERTION_TOO_OLD_OR_FUTURE");

  const conditions = childNs(assertion, NS.assertion, "Conditions");
  if (!conditions) return fail("CONDITIONS_MISSING");
  const notBefore = attr(conditions, "NotBefore");
  const notOnOrAfter = attr(conditions, "NotOnOrAfter");
  if (!notOnOrAfter) fail("CONDITIONS_UNBOUNDED");
  if (notBefore !== null && now + skew < parseInstant(notBefore, "CONDITIONS_TIME_INVALID")) fail("ASSERTION_NOT_YET_VALID");
  if (now - skew >= parseInstant(notOnOrAfter, "CONDITIONS_TIME_INVALID")) fail("ASSERTION_EXPIRED");
  const restrictions = childrenNs(conditions, NS.assertion, "AudienceRestriction");
  if (restrictions.length === 0) fail("AUDIENCE_MISSING");
  for (const restriction of restrictions) {
    if (!childrenNs(restriction, NS.assertion, "Audience").some((el) => text(el) === ctx.sp.entityId)) fail("AUDIENCE_MISMATCH");
  }

  const subject = childNs(assertion, NS.assertion, "Subject");
  if (!subject) return fail("SUBJECT_MISSING");
  const bearers = childrenNs(subject, NS.assertion, "SubjectConfirmation").filter((sc) => attr(sc, "Method") === BEARER);
  const answered = new Set<string>();
  for (const sc of bearers) {
    const data = childNs(sc, NS.assertion, "SubjectConfirmationData");
    if (attr(data, "Recipient") !== ctx.sp.acsUrl) continue;
    const until = attr(data, "NotOnOrAfter");
    if (!until || now - skew >= parseInstant(until, "CONFIRMATION_TIME_INVALID")) continue;
    const scNotBefore = attr(data, "NotBefore");
    if (scNotBefore !== null) fail("CONFIRMATION_NOT_BEFORE_PRESENT"); // forbidden for bearer (profiles §4.1.4.2)
    const irt = attr(data, "InResponseTo");
    if (irt) answered.add(irt);
  }
  if (answered.size === 0) fail("BEARER_CONFIRMATION_INVALID");
  if (answered.size > 1) fail("IN_RESPONSE_TO_AMBIGUOUS");
  const inResponseTo = [...answered][0]!;
  if (!/^_[A-Za-z0-9_-]{20,80}$/.test(inResponseTo)) fail("IN_RESPONSE_TO_INVALID");

  const authn = childrenNs(assertion, NS.assertion, "AuthnStatement");
  if (authn.length !== 1) fail("AUTHN_STATEMENT_INVALID");
  const authnInstantMs = parseInstant(attr(authn[0]!, "AuthnInstant"), "AUTHN_INSTANT_INVALID");
  if (authnInstantMs > now + skew) fail("AUTHN_INSTANT_FUTURE");
  const contextEl = childNs(authn[0]!, NS.assertion, "AuthnContext");
  const authnContextClassRef = contextEl ? text(childNs(contextEl, NS.assertion, "AuthnContextClassRef")) : null;

  const attributes = new Map<string, string[]>();
  for (const statement of childrenNs(assertion, NS.assertion, "AttributeStatement")) {
    for (const el of childrenNs(statement, NS.assertion, "Attribute")) {
      const name = attr(el, "Name");
      if (!name || name.length > 256) continue;
      if (attributes.size >= 100 && !attributes.has(name)) fail("TOO_MANY_ATTRIBUTES");
      const values = attributes.get(name) ?? [];
      for (const v of childrenNs(el, NS.assertion, "AttributeValue")) {
        const value = text(v);
        if (value !== null && value.length <= 1024 && values.length < 100) values.push(value);
      }
      attributes.set(name, values);
    }
  }
  const one = (claim: string): string | null => {
    const values = attributes.get(claim) ?? [];
    return values.length === 1 ? values[0]! : null;
  };
  const tenantId = one(SAML_CLAIMS.tenantId)?.toLowerCase() ?? null;
  if (tenantId !== ctx.tenantId) fail(tenantId === null ? "TENANT_CLAIM_MISSING" : "TENANT_MISMATCH");
  const objectId = one(SAML_CLAIMS.objectId)?.toLowerCase() ?? null;
  if (!objectId || !GUID.test(objectId)) fail("OBJECT_ID_MISSING");
  const emailCandidate = one(SAML_CLAIMS.email) ?? one(SAML_CLAIMS.name);
  const email = emailCandidate && EMAIL.test(emailCandidate) ? emailCandidate.toLowerCase() : null;
  const name = (one(SAML_CLAIMS.displayName) ?? null)?.replace(/[\p{Cc}<>]/gu, "").slice(0, 120) ?? null;
  return {
    assertionId: assertionId!,
    inResponseTo,
    issueInstantMs,
    authnInstantMs,
    authnContextClassRef: authnContextClassRef && authnContextClassRef.length <= 256 ? authnContextClassRef : null,
    tenantId: tenantId!,
    objectId: objectId!,
    methods: (attributes.get(SAML_CLAIMS.methods) ?? []).slice(0, 20),
    roles: (attributes.get(SAML_CLAIMS.role) ?? []).filter((r) => /^[A-Za-z0-9._-]{1,120}$/.test(r)).slice(0, 50),
    email,
    name: name || null,
    givenName: one(SAML_CLAIMS.givenName)?.replace(/[\p{Cc}<>]/gu, "").slice(0, 120) || null,
    familyName: one(SAML_CLAIMS.surname)?.replace(/[\p{Cc}<>]/gu, "").slice(0, 120) || null,
    attributeNames: [...attributes.keys()].slice(0, 50),
  };
}

/* ------------------------------------------------------------------ metadata */

/** Entra federation metadata → signing certificates of the IdP SSO descriptor for exactly this tenant. */
export async function parseFederationMetadata(xml: string, tenantId: string): Promise<ParsedCertificate[]> {
  if (Buffer.byteLength(xml) > MAX_METADATA_BYTES) fail("METADATA_TOO_LARGE");
  const doc = await parseXml(xml, "METADATA_MALFORMED");
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== NS.metadata || root.localName !== "EntityDescriptor") fail("METADATA_MALFORMED");
  if (attr(root!, "entityID") !== samlEndpoints(tenantId).issuer) fail("METADATA_TENANT_MISMATCH");
  const idp = childNs(root!, NS.metadata, "IDPSSODescriptor");
  if (!idp) return fail("METADATA_NO_IDP_DESCRIPTOR");
  const out: ParsedCertificate[] = [];
  for (const kd of childrenNs(idp, NS.metadata, "KeyDescriptor")) {
    const use = attr(kd, "use");
    if (use !== null && use !== "signing") continue;
    const keyInfo = childNs(kd, NS.dsig, "KeyInfo");
    const data = keyInfo && childNs(keyInfo, NS.dsig, "X509Data");
    const body = text(data && childNs(data, NS.dsig, "X509Certificate"));
    if (!body) continue;
    const parsed = parseCertificate(body);
    if (!out.some((c) => c.fingerprintSha256 === parsed.fingerprintSha256)) out.push(parsed);
    if (out.length > 5) fail("METADATA_TOO_MANY_CERTIFICATES");
  }
  if (out.length === 0) fail("METADATA_NO_SIGNING_CERTIFICATE");
  return out;
}

/** Public SP metadata (no keys: requests are unsigned and assertions are not encrypted). */
export function serviceProviderMetadata(sp: SpUrls): string {
  return generateServiceProviderMetadata({
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    identifierFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    wantAssertionsSigned: true,
  });
}

/** MFA facts from a verified assertion (values never leave the server). */
export function samlMfaFacts(assertion: Pick<VerifiedSamlAssertion, "methods" | "authnContextClassRef">, acceptedContexts: readonly string[]) {
  return {
    // Exact membership of the claim value in the verified list; never a substring test on a URL.
    multipleAuthn: assertion.methods.some((method) => method === ENTRA_MULTIPLE_AUTHN),
    acceptedContext: assertion.authnContextClassRef !== null && acceptedContexts.includes(assertion.authnContextClassRef),
  };
}
