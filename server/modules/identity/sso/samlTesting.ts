/**
 * TEST-ONLY SAML fixtures (increment 07, D10). Never imported by production code.
 *
 * A fake Entra IdP: an RSA key pair and a self-signed X.509 certificate generated IN MEMORY at load time (no key
 * material is committed), and `buildSignedResponse(opts)` which returns a base64 SAMLResponse whose Assertion is
 * signed exactly like Entra does it (enveloped, exclusive c14n, RSA-SHA256, signature after the Issuer). Options
 * let tests produce the attacks the validator must refuse (XSW, unsigned, SHA-1, wrong audience, …).
 *
 * Shared with http_security_engineer's ingress tests.
 */
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { signXml } from "@node-saml/node-saml/lib/xml.js";
import { ENTRA_MULTIPLE_AUTHN, SAML_CLAIMS, samlEndpoints, type SpUrls } from "./saml.js";

/* ------------------------------------------------------------------ minimal DER (self-signed certificate) */

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const oid = (dotted: string): Buffer => {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    do { chunk.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const integer = (bytes: Buffer): Buffer => tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utcTime = (d: Date): Buffer => {
  const p = (n: number) => String(n).padStart(2, "0");
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));
const SHA256_RSA = seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));

export interface TestIdpKey {
  privateKey: KeyObject;
  /** PEM certificate (what an administrator would paste / metadata would carry). */
  certificatePem: string;
  /** Bare base64 DER body (metadata form). */
  certificateBody: string;
}

/** A fresh RSA-2048 key and self-signed certificate (validity notBefore … notAfter). */
export function createTestIdpKey(opts: { cn?: string; notBefore?: Date; notAfter?: Date; bits?: number } = {}): TestIdpKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: opts.bits ?? 2048 });
  const notBefore = opts.notBefore ?? new Date(Date.UTC(2026, 0, 1));
  const notAfter = opts.notAfter ?? new Date(Date.UTC(2036, 0, 1));
  const subject = name(opts.cn ?? "ReadyPackets Test IdP (test only)");
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(12)),
    SHA256_RSA,
    subject,
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signer = createSign("sha256");
  signer.update(tbs);
  const signature = signer.sign(privateKey);
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der.toString("base64");
  return {
    privateKey,
    certificatePem: `-----BEGIN CERTIFICATE-----\n${(body.match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`,
    certificateBody: body,
  };
}

/** The default fake Entra signing key (generated once per test process). */
export const TEST_IDP: TestIdpKey = createTestIdpKey();

/* ------------------------------------------------------------------ responses */

export const TEST_SAML_TENANT = "11111111-2222-3333-4444-555555555555";

export interface SignedResponseOptions {
  sp: SpUrls;
  inResponseTo: string;
  /** Default: now (Date.now()). */
  nowMs?: number;
  tenantId?: string;
  /** Tenant claim value; default tenantId. null omits the claim. */
  tenantClaim?: string | null;
  objectId?: string | null;
  email?: string | null;
  displayName?: string | null;
  /** D1: givenname / surname claims (omitted when undefined or null). */
  givenName?: string | null;
  surname?: string | null;
  roles?: string[];
  /** authnmethodsreferences values; default password + multipleauthn. */
  methods?: string[];
  authnContextClassRef?: string;
  authnInstantMs?: number;
  issuer?: string;
  audience?: string;
  recipient?: string;
  destination?: string | null;
  /** Assertion lifetime (Conditions NotOnOrAfter = issue + lifetime). */
  lifetimeMs?: number;
  /** Overrides IssueInstant / Conditions NotBefore base time. */
  issueInstantMs?: number;
  assertionId?: string;
  statusCode?: string;
  key?: TestIdpKey;
  /** "sha256" (default) or "sha1" (must be refused). */
  algorithm?: "sha256" | "sha1";
  /** Attacks / malformations. */
  unsigned?: boolean;
  /** XSW: inject a second, unsigned assertion (as a sibling, or wrapped inside an Extensions element). */
  wrap?: "sibling" | "extensions";
  /** Prefix a DOCTYPE (XXE / entity bomb). */
  doctype?: boolean;
  /** Replace the Assertion with an EncryptedAssertion placeholder. */
  encrypted?: boolean;
  /** Tamper with a signed value after signing. */
  tamperAfterSigning?: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attribute = (claim: string, values: string[]) =>
  `<saml:Attribute Name="${esc(claim)}">${values.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join("")}</saml:Attribute>`;

export function randomRequestId(): string {
  return `_${randomBytes(24).toString("base64url")}`;
}

/** Builds an Entra-shaped SAMLResponse (base64), signed over the Assertion unless told otherwise. */
export function buildSignedResponse(o: SignedResponseOptions): string {
  const now = o.nowMs ?? Date.now();
  const tenant = o.tenantId ?? TEST_SAML_TENANT;
  const issue = o.issueInstantMs ?? now;
  const lifetime = o.lifetimeMs ?? 60 * 60_000;
  const assertionId = o.assertionId ?? `_${randomBytes(16).toString("hex")}`;
  const issuer = o.issuer ?? samlEndpoints(tenant).issuer;
  const attrs: string[] = [];
  const tenantClaim = o.tenantClaim === undefined ? tenant : o.tenantClaim;
  if (tenantClaim !== null) attrs.push(attribute(SAML_CLAIMS.tenantId, [tenantClaim]));
  const objectId = o.objectId === undefined ? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" : o.objectId;
  if (objectId !== null) attrs.push(attribute(SAML_CLAIMS.objectId, [objectId]));
  if (o.email !== null) attrs.push(attribute(SAML_CLAIMS.email, [o.email ?? "person@example.test"]));
  if (o.displayName !== null) attrs.push(attribute(SAML_CLAIMS.displayName, [o.displayName ?? "Test Person"]));
  if (o.givenName) attrs.push(attribute(SAML_CLAIMS.givenName, [o.givenName]));
  if (o.surname) attrs.push(attribute(SAML_CLAIMS.surname, [o.surname]));
  if (o.roles?.length) attrs.push(attribute(SAML_CLAIMS.role, o.roles));
  attrs.push(attribute(SAML_CLAIMS.methods, o.methods ?? ["http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password", ENTRA_MULTIPLE_AUTHN]));

  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${iso(issue)}" Version="2.0">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">subject-${esc(objectId ?? "none")}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData InResponseTo="${esc(o.inResponseTo)}" NotOnOrAfter="${iso(issue + 5 * 60_000)}" Recipient="${esc(o.recipient ?? o.sp.acsUrl)}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(issue - 5 * 60_000)}" NotOnOrAfter="${iso(issue + lifetime)}">` +
    `<saml:AudienceRestriction><saml:Audience>${esc(o.audience ?? o.sp.entityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AttributeStatement>${attrs.join("")}</saml:AttributeStatement>` +
    `<saml:AuthnStatement AuthnInstant="${iso(o.authnInstantMs ?? issue - 1_000)}" SessionIndex="${assertionId}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>${esc(o.authnContextClassRef ?? "urn:oasis:names:tc:SAML:2.0:ac:classes:Password")}</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement></saml:Assertion>`;

  const key = o.key ?? TEST_IDP;
  let signedAssertion = assertion;
  if (!o.unsigned) {
    const algorithm = o.algorithm ?? "sha256";
    const signed = signXml(
      assertion,
      "//*[local-name(.)='Assertion']",
      { reference: "//*[local-name(.)='Issuer']", action: "after" },
      {
        privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicCert: key.certificatePem,
        signatureAlgorithm: algorithm,
        digestAlgorithm: algorithm,
      },
    );
    signedAssertion = signed;
  }
  if (o.tamperAfterSigning) signedAssertion = signedAssertion.replace(objectId ?? "", "99999999-8888-7777-6666-555555555555");

  const status = o.statusCode ?? "urn:oasis:names:tc:SAML:2.0:status:Success";
  const destination = o.destination === undefined ? o.sp.acsUrl : o.destination;
  const evil = assertion
    .replace(/ID="[^"]+"/, `ID="_evil${randomBytes(8).toString("hex")}"`)
    .replace(/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/g, "00000000-0000-0000-0000-000000000001");
  let body = o.encrypted
    ? `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"/></saml:EncryptedAssertion>`
    : signedAssertion;
  if (o.wrap === "sibling") body = `${evil}${body}`;
  const extensions = o.wrap === "extensions" ? `<samlp:Extensions>${evil}</samlp:Extensions>` : "";
  const xml =
    (o.doctype ? `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "x">]>` : "") +
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${iso(issue)}"` +
    `${destination ? ` Destination="${esc(destination)}"` : ""} InResponseTo="${esc(o.inResponseTo)}">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${esc(issuer)}</saml:Issuer>` +
    extensions +
    `<samlp:Status><samlp:StatusCode Value="${esc(status)}"/></samlp:Status>` +
    body +
    `</samlp:Response>`;
  return Buffer.from(xml, "utf8").toString("base64");
}

/** Entra-shaped federation metadata carrying the given signing certificate bodies. */
export function buildFederationMetadata(opts: { tenantId?: string; certificates?: string[]; entityId?: string } = {}): string {
  const tenant = opts.tenantId ?? TEST_SAML_TENANT;
  const certs = opts.certificates ?? [TEST_IDP.certificateBody];
  const keys = certs.map((c) =>
    `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${c}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" ID="_m" entityID="${esc(opts.entityId ?? samlEndpoints(tenant).issuer)}">` +
    `<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${keys}` +
    `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${samlEndpoints(tenant).signOn}"/>` +
    `</IDPSSODescriptor></EntityDescriptor>`;
}
