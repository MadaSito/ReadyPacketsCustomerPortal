/**
 * SAML certificate store, Entra metadata import / refresh, certificate-expiry alerts and JIT role mappings
 * (increment 07, D10). Owner: identity engineer. Called only through the SSO service (lock order:
 * [policy] → sso_configuration → sso_saml_certificates / sso_role_mappings).
 */
import { asc, eq, isNull } from "drizzle-orm";
import type { ModuleDeps } from "../../../container.js";
import { conflict, DomainError, notFound, validation } from "../../../core/errors.js";
import { ulid } from "../../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../../core/types.js";
import {
  ssoConfiguration,
  ssoRoleMappings,
  ssoSamlCertificates,
  SSO_MAPPED_ROLES,
  type SsoConfigurationRow,
  type SsoMappedRole,
  type SsoSamlCertificateRow,
} from "../schema.js";
import { isTenantGuid } from "./oidc.js";
import {
  isAllowedMetadataUrl,
  MAX_METADATA_BYTES,
  MAX_TRUSTED_CERTIFICATES,
  parseCertificate,
  parseFederationMetadata,
  SAML_CLOCK_SKEW_MS,
  SamlValidationError,
  type ParsedCertificate,
} from "./saml.js";

const DAY_MS = 24 * 60 * 60_000;
export const MAX_ROLE_MAPPINGS = 20;
const CONFIG_ID = 1;

export type SamlCertificateState = "trusted" | "not_yet_valid" | "expired" | "retired";
export interface SamlCertificateView {
  id: string;
  fingerprintSha256: string;
  subject: string | null;
  notBefore: Date;
  notAfter: Date;
  source: "manual" | "metadata";
  state: SamlCertificateState;
  daysLeft: number;
}

export function certificateState(row: Pick<SsoSamlCertificateRow, "retiredAt" | "notBefore" | "notAfter">, now: Date): SamlCertificateState {
  if (row.retiredAt) return "retired";
  if (row.notAfter.getTime() <= now.getTime()) return "expired";
  if (row.notBefore.getTime() - SAML_CLOCK_SKEW_MS > now.getTime()) return "not_yet_valid";
  return "trusted";
}

/** Expiry thresholds → alert severity (dedup key suffix). */
const EXPIRY_LEVELS = [
  { key: "expired", withinMs: 0, severity: "critical" },
  { key: "1d", withinMs: DAY_MS, severity: "critical" },
  { key: "7d", withinMs: 7 * DAY_MS, severity: "error" },
  { key: "30d", withinMs: 30 * DAY_MS, severity: "warning" },
] as const;

export interface SamlAdminContext {
  deps: ModuleDeps;
  lockConfig: (tx: Tx) => Promise<SsoConfigurationRow>;
  authorize: (tx: Tx, principal: SessionPrincipal) => Promise<unknown>;
  fetchMetadata: (url: string) => Promise<string>;
}

export function createSamlAdmin(c: SamlAdminContext) {
  const { deps } = c;
  const now = () => deps.clock.now();

  async function listRows(tx?: Tx): Promise<SsoSamlCertificateRow[]> {
    return (tx ?? deps.db).select().from(ssoSamlCertificates).orderBy(asc(ssoSamlCertificates.notAfter)).limit(50);
  }

  function view(row: SsoSamlCertificateRow): SamlCertificateView {
    const t = now();
    return {
      id: row.publicId, fingerprintSha256: row.fingerprintSha256, subject: row.subject, notBefore: row.notBefore, notAfter: row.notAfter,
      source: row.source, state: certificateState(row, t), daysLeft: Math.max(0, Math.floor((row.notAfter.getTime() - t.getTime()) / DAY_MS)),
    };
  }

  /** PEMs usable for signature verification right now (never retired, expired or not yet valid). */
  async function trustedPems(tx?: Tx): Promise<string[]> {
    const t = now();
    const rows = await (tx ?? deps.db).select().from(ssoSamlCertificates).where(isNull(ssoSamlCertificates.retiredAt));
    return rows.filter((r) => certificateState(r, t) === "trusted").slice(0, MAX_TRUSTED_CERTIFICATES).map((r) => r.certificatePem);
  }

  /** Inserts new certificates; at most two non-retired, non-expired rows may exist. Returns the number added. */
  async function addParsed(tx: Tx, certs: ParsedCertificate[], source: "manual" | "metadata", userId: number | null): Promise<{ added: number; blocked: number }> {
    const t = now();
    const existing = await tx.select().from(ssoSamlCertificates).for("update");
    const known = new Set(existing.map((r) => r.fingerprintSha256));
    let live = existing.filter((r) => !r.retiredAt && r.notAfter.getTime() > t.getTime()).length;
    let added = 0;
    let blocked = 0;
    for (const cert of certs) {
      if (known.has(cert.fingerprintSha256) || cert.notAfter.getTime() <= t.getTime()) continue;
      if (live >= MAX_TRUSTED_CERTIFICATES) {
        blocked += 1;
        continue;
      }
      await tx.insert(ssoSamlCertificates).values({
        publicId: ulid(t.getTime()), fingerprintSha256: cert.fingerprintSha256, certificatePem: cert.pem, subject: cert.subject,
        notBefore: cert.notBefore, notAfter: cert.notAfter, source, addedByUserId: userId,
      });
      known.add(cert.fingerprintSha256);
      live += 1;
      added += 1;
      await deps.audit.record({
        category: "admin", eventName: "identity.sso.saml_certificate_added", action: "create", outcome: "completed",
        actor: userId ? undefined : { role: "system" }, resource: { type: "sso_saml_certificate" }, provider: "entra",
        attributes: { source, fingerprint_prefix: cert.fingerprintSha256.slice(0, 12), not_after: cert.notAfter.toISOString() },
      }, tx);
    }
    return { added, blocked };
  }

  const bump = (tx: Tx, row: SsoConfigurationRow, principal: SessionPrincipal | null, patch: Partial<SsoConfigurationRow> = {}) =>
    tx.update(ssoConfiguration).set({ ...patch, version: row.version + 1, ...(principal ? { updatedByUserId: principal.userId } : {}) }).where(eq(ssoConfiguration.id, CONFIG_ID));

  const checkVersion = (row: SsoConfigurationRow, expected: number) => {
    if (row.version !== expected) throw conflict("STALE_VERSION", "Single sign-on settings were changed by someone else. Reload and try again.");
  };

  const asDomain = (error: unknown, field: string): never => {
    if (error instanceof SamlValidationError) {
      const messages: Record<string, string> = {
        CERTIFICATE_INVALID: "This is not a valid X.509 certificate. Paste the Base64 certificate from Entra ID.",
        CERTIFICATE_KEY_WEAK: "The certificate must use an RSA key of at least 2048 bits.",
        METADATA_TENANT_MISMATCH: "This metadata belongs to a different Entra tenant.",
        METADATA_TOO_LARGE: "The metadata file is too large.",
        DTD_REFUSED: "The metadata contains a document type declaration, which is not allowed.",
      };
      throw validation(`SAML_${error.reasonCode}`.slice(0, 60), messages[error.reasonCode] ?? "The federation metadata could not be read. Download it again from Entra ID.", { field });
    }
    throw error;
  };

  async function refreshFromUrl(trigger: "admin" | "job", principal: SessionPrincipal | null, expectedVersion?: number, urlOverride?: string) {
    const peek = await deps.db.select().from(ssoConfiguration).where(eq(ssoConfiguration.id, CONFIG_ID)).limit(1);
    const tenantId = peek[0]?.tenantId;
    const url = urlOverride ?? peek[0]?.samlMetadataUrl ?? null;
    if (!tenantId || !isTenantGuid(tenantId)) throw validation("SSO_CONFIG_INCOMPLETE", "Enter the tenant ID first.", { field: "tenantId" });
    if (!url || !isAllowedMetadataUrl(url, tenantId)) {
      throw validation("SAML_METADATA_URL_INVALID", "Use the App Federation Metadata Url from Entra ID (https://login.microsoftonline.com/<tenant>/…).", { field: "url" });
    }
    let parsed: ParsedCertificate[] | null = null;
    let status = "OK";
    try {
      parsed = await parseFederationMetadata(await c.fetchMetadata(url), tenantId);
    } catch (error) {
      status = error instanceof SamlValidationError ? error.reasonCode.slice(0, 40) : "FETCH_FAILED";
      if (trigger === "admin") {
        if (error instanceof SamlValidationError) asDomain(error, "url");
        throw new DomainError("UNAVAILABLE", "SAML_METADATA_FETCH_FAILED", "The metadata could not be downloaded from Microsoft. Try again or upload the XML file.");
      }
    }
    return deps.db.transaction(async (tx) => {
      const row = await c.lockConfig(tx);
      if (principal) await c.authorize(tx, principal);
      if (expectedVersion !== undefined) checkVersion(row, expectedVersion);
      if (row.tenantId !== tenantId) throw conflict("STALE_VERSION", "Single sign-on settings were changed by someone else. Reload and try again.");
      const result = parsed ? await addParsed(tx, parsed, "metadata", principal?.userId ?? null) : { added: 0, blocked: 0 };
      if (parsed && result.blocked > 0) status = "ROLLOVER_BLOCKED";
      await bump(tx, row, principal, { samlMetadataUrl: url, samlMetadataStatus: status, ...(parsed ? { samlMetadataRefreshedAt: now() } : {}) });
      await deps.audit.record({
        category: "admin", eventName: trigger === "admin" ? "identity.sso.saml_metadata_imported" : parsed ? "identity.sso.saml_metadata_refreshed" : "identity.sso.saml_metadata_refresh_failed",
        action: "update", outcome: parsed ? "completed" : "failed", ...(parsed ? {} : { severity: "WARN" as const, reasonCode: status }),
        actor: principal ? undefined : { role: "system" }, resource: { type: "sso_configuration" }, provider: "entra",
        safeCounts: { added: result.added, blocked: result.blocked }, attributes: { source: "url", status },
      }, tx);
      return { added: result.added, blocked: result.blocked, status };
    });
  }

  async function emitExpiryAlerts(): Promise<number> {
    const t = now();
    const rows = await listRows();
    let emitted = 0;
    for (const row of rows) {
      const fp = row.fingerprintSha256.slice(0, 16);
      const left = row.notAfter.getTime() - t.getTime();
      const level = row.retiredAt ? null : EXPIRY_LEVELS.find((l) => left <= l.withinMs) ?? null;
      for (const l of EXPIRY_LEVELS) {
        const dedupKey = `saml_cert:${fp}:${l.key}`;
        if (level && l.key === level.key) {
          await deps.services.opsAlerts.emit({
            source: "certificate", severity: level.severity, dedupKey, code: level.key === "expired" ? "SAML_CERTIFICATE_EXPIRED" : "SAML_CERTIFICATE_EXPIRING",
            title: level.key === "expired" ? "Entra SAML signing certificate expired" : "Entra SAML signing certificate expires soon",
            text: `Certificate ${fp} ${level.key === "expired" ? "has expired" : `expires within ${level.key.replace("d", " day(s)")}`}. Add the new certificate in Single sign-on settings.`,
          });
          emitted += 1;
        } else {
          await deps.services.opsAlerts.resolve({ source: "certificate", dedupKey });
        }
      }
    }
    return emitted;
  }

  return {
    trustedPems,

    async listCertificates(tx?: Tx): Promise<SamlCertificateView[]> {
      return (await listRows(tx)).map(view);
    },

    async addCertificate(principal: SessionPrincipal, input: { expectedVersion: number; pem: string }): Promise<void> {
      let parsed: ParsedCertificate;
      try {
        parsed = parseCertificate(input.pem);
      } catch (error) {
        return asDomain(error, "pem");
      }
      if (parsed.notAfter.getTime() <= now().getTime()) throw validation("SAML_CERTIFICATE_EXPIRED", "This certificate has already expired.", { field: "pem" });
      await deps.db.transaction(async (tx) => {
        const row = await c.lockConfig(tx);
        await c.authorize(tx, principal);
        checkVersion(row, input.expectedVersion);
        const result = await addParsed(tx, [parsed], "manual", principal.userId);
        if (result.blocked > 0) throw conflict("SAML_CERTIFICATE_LIMIT", "Two certificates are already trusted. Retire one before adding another.");
        if (result.added === 0) throw conflict("SAML_CERTIFICATE_EXISTS", "This certificate is already in the list.");
        await bump(tx, row, principal);
      });
    },

    async importMetadata(principal: SessionPrincipal, input: { expectedVersion: number; url?: string; xml?: string }) {
      if ((input.url === undefined) === (input.xml === undefined)) throw validation("INVALID_INPUT", "Provide either the metadata URL or the XML file.");
      if (input.url !== undefined) return refreshFromUrl("admin", principal, input.expectedVersion, input.url.trim());
      if (Buffer.byteLength(input.xml!) > MAX_METADATA_BYTES) throw validation("SAML_METADATA_TOO_LARGE", "The metadata file is too large.", { field: "xml" });
      const config = await deps.db.select().from(ssoConfiguration).where(eq(ssoConfiguration.id, CONFIG_ID)).limit(1);
      const tenantId = config[0]?.tenantId;
      if (!tenantId) throw validation("SSO_CONFIG_INCOMPLETE", "Enter the tenant ID first.", { field: "tenantId" });
      let parsed: ParsedCertificate[];
      try {
        parsed = await parseFederationMetadata(input.xml!, tenantId);
      } catch (error) {
        return asDomain(error, "xml");
      }
      return deps.db.transaction(async (tx) => {
        const row = await c.lockConfig(tx);
        await c.authorize(tx, principal);
        checkVersion(row, input.expectedVersion);
        if (row.tenantId !== tenantId) throw conflict("STALE_VERSION", "Single sign-on settings were changed by someone else. Reload and try again.");
        const result = await addParsed(tx, parsed, "metadata", principal.userId);
        await bump(tx, row, principal, { samlMetadataStatus: result.blocked > 0 ? "ROLLOVER_BLOCKED" : "OK", samlMetadataRefreshedAt: now() });
        await deps.audit.record({
          category: "admin", eventName: "identity.sso.saml_metadata_imported", action: "update", outcome: "completed",
          resource: { type: "sso_configuration" }, provider: "entra", safeCounts: { added: result.added, blocked: result.blocked }, attributes: { source: "xml" },
        }, tx);
        return { added: result.added, blocked: result.blocked, status: result.blocked > 0 ? "ROLLOVER_BLOCKED" : "OK" };
      });
    },

    async retireCertificate(principal: SessionPrincipal, input: { expectedVersion: number; certificateId: string }): Promise<void> {
      await deps.db.transaction(async (tx) => {
        const row = await c.lockConfig(tx);
        await c.authorize(tx, principal);
        checkVersion(row, input.expectedVersion);
        const [cert] = await tx.select().from(ssoSamlCertificates).where(eq(ssoSamlCertificates.publicId, input.certificateId)).limit(1).for("update");
        if (!cert) throw notFound("SAML_CERTIFICATE_NOT_FOUND");
        if (cert.retiredAt) return;
        const t = now();
        const remaining = (await tx.select().from(ssoSamlCertificates).where(isNull(ssoSamlCertificates.retiredAt)))
          .filter((r) => r.id !== cert.id && certificateState(r, t) === "trusted");
        // An enabled SAML configuration may not lose its last trusted certificate (it would lock everyone out of SSO).
        if (row.enabled && row.protocol === "saml" && remaining.length === 0) {
          throw conflict("SAML_LAST_CERTIFICATE", "This is the only trusted certificate. Add the new certificate first, or turn single sign-on off.");
        }
        await tx.update(ssoSamlCertificates).set({ retiredAt: t, retiredByUserId: principal.userId }).where(eq(ssoSamlCertificates.id, cert.id));
        await bump(tx, row, principal);
        await deps.audit.record({
          category: "admin", eventName: "identity.sso.saml_certificate_retired", action: "update", outcome: "completed",
          resource: { type: "sso_saml_certificate", publicId: cert.publicId }, provider: "entra", attributes: { fingerprint_prefix: cert.fingerprintSha256.slice(0, 12) },
        }, tx);
      });
      await emitExpiryAlerts().catch(() => 0);
    },

    async roleMappings(tx?: Tx): Promise<Array<{ appRoleValue: string; role: SsoMappedRole }>> {
      const rows = await (tx ?? deps.db).select().from(ssoRoleMappings).orderBy(asc(ssoRoleMappings.id)).limit(MAX_ROLE_MAPPINGS);
      return rows.map((r) => ({ appRoleValue: r.appRoleValue, role: r.role }));
    },

    async setRoleMappings(principal: SessionPrincipal, input: { expectedVersion: number; mappings: Array<{ appRoleValue: string; role: SsoMappedRole }> }): Promise<void> {
      if (input.mappings.length > MAX_ROLE_MAPPINGS) throw validation("SSO_MAPPINGS_TOO_MANY", `Add at most ${MAX_ROLE_MAPPINGS} mappings.`, { field: "mappings" });
      const seen = new Set<string>();
      for (const [index, m] of input.mappings.entries()) {
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(m.appRoleValue)) throw validation("SSO_APP_ROLE_INVALID", "App role values may contain letters, digits, dots, dashes and underscores.", { field: `mappings.${index}.appRoleValue` });
        if (!(SSO_MAPPED_ROLES as readonly string[]).includes(m.role)) throw validation("SSO_MAPPED_ROLE_INVALID", "Map app roles to staff or customer only.", { field: `mappings.${index}.role` });
        if (seen.has(m.appRoleValue)) throw validation("SSO_APP_ROLE_DUPLICATE", "Each app role value may appear once.", { field: `mappings.${index}.appRoleValue` });
        seen.add(m.appRoleValue);
      }
      await deps.db.transaction(async (tx) => {
        const row = await c.lockConfig(tx);
        await c.authorize(tx, principal);
        checkVersion(row, input.expectedVersion);
        await tx.delete(ssoRoleMappings);
        if (input.mappings.length > 0) {
          await tx.insert(ssoRoleMappings).values(input.mappings.map((m) => ({ appRoleValue: m.appRoleValue, role: m.role, createdByUserId: principal.userId })));
        }
        await bump(tx, row, principal);
        await deps.audit.record({
          category: "admin", eventName: "identity.sso.role_mappings_updated", action: "update", outcome: "completed",
          resource: { type: "sso_configuration" }, provider: "entra",
          safeCounts: { staff: input.mappings.filter((m) => m.role === "staff").length, customer: input.mappings.filter((m) => m.role === "customer").length },
        }, tx);
      });
    },

    /** Daily job: idempotent (fingerprint-unique inserts, dedup-keyed alerts). No-op unless protocol = saml. */
    async dailyCheck(): Promise<{ added: number; alerts: number; skipped: boolean }> {
      const [row] = await deps.db.select().from(ssoConfiguration).where(eq(ssoConfiguration.id, CONFIG_ID)).limit(1);
      if (!row || row.protocol !== "saml") return { added: 0, alerts: 0, skipped: true };
      let added = 0;
      if (row.samlMetadataUrl && row.tenantId) {
        const result = await refreshFromUrl("job", null).catch(() => ({ added: 0, blocked: 0, status: "FETCH_FAILED" }));
        added = result.added;
        const dedupKey = "saml_metadata:refresh";
        if (result.status === "OK") await deps.services.opsAlerts.resolve({ source: "certificate", dedupKey });
        else {
          await deps.services.opsAlerts.emit({
            source: "certificate", severity: "warning", dedupKey, code: result.status === "ROLLOVER_BLOCKED" ? "SAML_ROLLOVER_BLOCKED" : "SAML_METADATA_REFRESH_FAILED",
            title: result.status === "ROLLOVER_BLOCKED" ? "New Entra signing certificate needs a free slot" : "Entra SAML metadata refresh failed",
            text: result.status === "ROLLOVER_BLOCKED"
              ? "Entra published a new signing certificate but two are already trusted. Retire the old one in Single sign-on settings."
              : "The daily metadata refresh could not complete. Check the metadata URL and the Entra egress switch.",
          });
        }
      }
      const alerts = await emitExpiryAlerts();
      return { added, alerts, skipped: false };
    },
  };
}

export type SamlAdmin = ReturnType<typeof createSamlAdmin>;
