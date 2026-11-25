/**
 * Microsoft Entra ID single sign-on (increment 03, package I). Owner: identity engineer.
 *
 * Flow (all state server-side; see API.md "Single sign-on"):
 *   sign-in   GET  /api/identity/sso/start?next=…            → pre-auth cookie + 303 to Entra
 *   link/…    tRPC identity.sso.prepare (session, CSRF)      → one-time start ticket bound to the session
 *             GET  /api/identity/sso/start?ticket=…          → ticket ↔ live session checked, cookie, 303
 *             GET  /api/identity/sso/callback?code&state     → state consumed atomically (browser-bound),
 *                                                              code exchanged, ID token verified, result
 *                                                              stored encrypted; 303 to /sso/complete
 *             POST /api/identity/sso/complete (CSRF)         → same browser cookie + (link/step-up/test)
 *                                                              the SAME live session; effect in one tx
 * Nothing in the callback URL is logged; nothing sensitive is ever placed in a redirect.
 */
import type { Gates } from "../gates.js";
import type { SignInLog } from "../sessionPolicy.js";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../../core/errors.js";
import { randomToken, ulid } from "../../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../../core/types.js";
import { roleHasCapability } from "../../../../shared/capabilities.js";
import { STEP_UP_MAX_AGE_MS, hasFreshStepUp } from "../../../trpc/trpc.js";
import type { EgressPurpose } from "../../integrations/egress.js";
import type { AuthService } from "../auth.js";
import type { IssuedSession, SessionService } from "../sessions.js";
import type { TransitionService } from "../transitions.js";
import type { UserRepo } from "../users.js";
import { toView } from "../users.js";
import { createSignInSignals } from "../signals.js";
import { USER_ROLES, type UserRole } from "../../../../shared/domain.js";
import {
  ENTRA_MFA_MODES,
  SSO_JIT_MODES,
  SSO_PROTOCOLS,
  ssoAuthRequests,
  ssoConfiguration,
  ssoIdentities,
  users,
  userSessions,
  type SsoAuthRequestRow,
  type EntraMfaMode,
  type SsoConfigurationRow,
  type SsoJitMode,
  type SsoMappedRole,
  type SsoProtocol,
  type SsoPurpose,
  type UserRow,
} from "../schema.js";
import {
  authorizationUrl,
  emailDomain,
  entraEndpoints,
  isTenantGuid,
  isValidDomain,
  OidcValidationError,
  peekKeyId,
  selectKey,
  verifyIdToken,
  type Jwk,
  type VerifiedEntraClaims,
} from "./oidc.js";
import {
  buildAuthnRequestUrl,
  isValidEntityId,
  REQUIRED_SAML_CLAIMS,
  SAML_CLOCK_SKEW_MS,
  SAML_START_PATH,
  samlEndpoints,
  samlMfaFacts,
  SamlValidationError,
  serviceProviderMetadata,
  spUrls,
  verifySamlResponse,
} from "./saml.js";
import { createSamlAdmin, type SamlCertificateView } from "./samlAdmin.js";

/** Egress purpose for login.microsoftonline.com (owned by integrations_engineer). */
export const ENTRA_EGRESS_PURPOSE: EgressPurpose = "entra_oidc";
export const SSO_CALLBACK_PATH = "/api/identity/sso/callback";
export const SSO_START_PATH = "/api/identity/sso/start";
export const PREPARED_TTL_MS = 2 * 60_000;
export const PENDING_TTL_MS = 10 * 60_000;
export const VERIFIED_TTL_MS = 2 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_REFETCH_MIN_MS = 5 * 60_000;
const CONFIG_ID = 1;

/** Public refusal codes rendered by /sso/refused (fixed set — the internal detail stays in the audit). */
export const SSO_REFUSALS = [
  "SSO_UNAVAILABLE",
  "SSO_EXPIRED",
  "SSO_CANCELLED",
  "SSO_FAILED",
  "SSO_NOT_LINKED",
  "SSO_ACCOUNT_INACTIVE",
  "SSO_DOMAIN_NOT_ALLOWED",
  "SSO_ACCOUNT_EXISTS",
  "SSO_LOCAL_SIGN_IN_REQUIRED",
  "SSO_IDENTITY_IN_USE",
  "SSO_WRONG_ACCOUNT",
  "SSO_SESSION_CHANGED",
  "SSO_MFA_REQUIRED",
  "SSO_PROVISIONING_LIMIT",
  "SSO_ROLE_NOT_ASSIGNED",
  "SSO_MAINTENANCE",
  "SSO_RESTRICTED",
  "SSO_ROLE_NOT_ALLOWED",
] as const;
export type SsoRefusal = (typeof SSO_REFUSALS)[number];

const REFUSAL_MESSAGES: Record<SsoRefusal, string> = {
  SSO_UNAVAILABLE: "Single sign-on is not available right now. Sign in with your password instead.",
  SSO_EXPIRED: "The sign-in attempt expired or was already used. Start again.",
  SSO_CANCELLED: "The sign-in was cancelled at Microsoft.",
  SSO_FAILED: "Microsoft sign-in could not be verified. Start again or sign in with your password.",
  SSO_NOT_LINKED: "This Microsoft account is not linked to a portal account.",
  SSO_ACCOUNT_INACTIVE: "This portal account is not active.",
  SSO_DOMAIN_NOT_ALLOWED: "Accounts from this e-mail domain cannot use single sign-on.",
  SSO_ACCOUNT_EXISTS: "A portal account already exists for this person. Sign in with your password and link Microsoft from Account settings.",
  SSO_LOCAL_SIGN_IN_REQUIRED: "Sign in with your password to finish securing your account.",
  SSO_IDENTITY_IN_USE: "This Microsoft account is already linked to a different portal account.",
  SSO_WRONG_ACCOUNT: "Use the Microsoft account that is linked to your portal account.",
  SSO_SESSION_CHANGED: "Your portal session changed during the Microsoft sign-in. Start again.",
  SSO_MFA_REQUIRED: "Microsoft did not confirm multi-factor authentication. Use your portal authenticator instead.",
  SSO_PROVISIONING_LIMIT: "New accounts cannot be created through single sign-on right now. Contact your administrator.",
  SSO_ROLE_NOT_ASSIGNED: "Your Microsoft account is not assigned to this application.",
  SSO_MAINTENANCE: "Customer sign-in is paused for scheduled maintenance. Please try again later.",
  SSO_RESTRICTED: "Sign-in is not allowed from your current network or location. Contact your administrator.",
  SSO_ROLE_NOT_ALLOWED: "Single sign-on is not offered for your account type. Sign in with your e-mail address and password.",
};

/** Typed confirmation required to select `entra` (the portal never asks SSO users for its factor). */
export const ENTRA_MODE_CONFIRMATION = "ENTRA MANAGES MFA";
/** Strictness order: a move to a higher rank revokes live Entra sessions. */
const MFA_MODE_RANK: Record<EntraMfaMode, number> = { entra: 0, claim: 1, portal: 2 };
export const NEW_CONFIG_ALLOWED_ROLES: readonly UserRole[] = ["admin", "staff"];

export const refusal = (code: SsoRefusal, detail?: string) =>
  new DomainError(code === "SSO_UNAVAILABLE" ? "UNAVAILABLE" : "FORBIDDEN", code, REFUSAL_MESSAGES[code], detail ? { detail } : undefined);

export function isSsoRefusal(error: unknown): error is DomainError & { reasonCode: SsoRefusal } {
  return error instanceof DomainError && (SSO_REFUSALS as readonly string[]).includes(error.reasonCode);
}

/** Server-side `next` guard — same rules as the client's safeNextPath, plus no API or SSO paths. */
export function safeServerNext(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || ch === "\\")) return null;
  const path = raw.split(/[?#]/)[0]!.toLowerCase();
  if (path.startsWith("/api") || path.startsWith("/sso/") || path === "/sign-in" || path === "/register") return null;
  return raw;
}

export interface SsoConfigInput {
  expectedVersion: number;
  tenantId: string | null;
  clientId: string | null;
  /** Write-only: undefined = keep, null = clear, string = replace. */
  clientSecret?: string | null;
  buttonLabel: string | null;
  allowedDomains: string[];
  jitMode: SsoJitMode;
  jitStaffAppRole: string | null;
  jitDailyLimit: number;
  /* increment 07 */
  protocol: SsoProtocol;
  samlEntityId: string | null;
  entraMfaMode: EntraMfaMode;
  entraModeConfirmation?: string;
  acceptedAuthnContexts: string[];
  allowedRoles: UserRole[];
}

/** Unprivileged status summary (see statusSummary). */
export interface SsoStatusSummary {
  configured: boolean;
  enabled: boolean;
  complete: boolean;
  availableInThisDeployment: boolean;
  protocol: SsoProtocol;
  entraMfaMode: EntraMfaMode;
  trustedCertificates: number;
  /** SAML only: earliest notAfter among trusted certificates. */
  nearestCertificateExpiry: Date | null;
  /** Safe outcome code of the last metadata/certificate check (OK, FETCH_FAILED, ROLLOVER_BLOCKED, …). */
  metadataStatus: string | null;
  metadataCheckedAt: Date | null;
  /** Most recent successful Entra sign-in by any linked account. */
  lastSignInAt: Date | null;
  settingsPath: "/admin/sso";
}

export interface SsoAdminView {
  enabled: boolean;
  tenantId: string | null;
  clientId: string | null;
  clientSecret: { configured: boolean; last4: string | null };
  buttonLabel: string | null;
  allowedDomains: string[];
  trustEntraMfa: boolean;
  jitMode: SsoJitMode;
  jitStaffAppRole: string | null;
  jitDailyLimit: number;
  redirectUri: string;
  version: number;
  complete: boolean;
  availableInThisDeployment: boolean;
  linkedAccounts: number;
  breakGlass: { localMfaAdministrators: number; soleLocalMfaAdministratorHasPasskey: boolean | null } | null;
  /* increment 07 */
  protocol: SsoProtocol;
  entraMfaMode: EntraMfaMode;
  acceptedAuthnContexts: string[];
  allowedRoles: UserRole[];
  saml: {
    entityId: string;
    entityIdIsDefault: boolean;
    acsUrl: string;
    signOnUrl: string;
    metadataUrl: string;
    idpIssuer: string | null;
    requiredClaims: string[];
    metadataSourceUrl: string | null;
    metadataRefreshedAt: Date | null;
    metadataStatus: string | null;
    certificates: SamlCertificateView[];
  };
  roleMappings: Array<{ appRoleValue: string; role: SsoMappedRole }>;
}

export interface SsoTestResult {
  signatureVerified: true;
  tenantMatches: true;
  audienceMatches: true;
  mfaClaimPresent: boolean;
  authTimePresent: boolean;
  emailDomain: string | null;
  domainAllowed: boolean;
  appRoles: number;
  staffRoleAssigned: boolean;
  linkedToYou: boolean;
  linkedToAnotherAccount: boolean;
  /* increment 07 */
  protocol: SsoProtocol;
  /** Claim / attribute NAMES present (never values). */
  claimNames: string[];
  mfaProven: boolean;
  mfaSkippedByMode: boolean;
  roleAllowed: boolean;
  jitRole: SsoMappedRole | null;
}

export interface SignInMethods {
  password: boolean;
  sso: "linked" | "pending" | null;
}

export type SsoCompletion =
  | { purpose: "sign_in"; next: string | null; nextStep: string | null; issued: IssuedSession; provisioned: boolean }
  | { purpose: "link"; next: string | null }
  | { purpose: "step_up"; next: string | null; issued: IssuedSession }
  | { purpose: "test"; next: string | null; test: SsoTestResult };

interface StoredResult {
  tid: string;
  oid: string;
  amr: string[] | null;
  authTime: number | null;
  email: string | null;
  name: string | null;
  roles: string[];
  /* SAML only (increment 07) */
  saml?: { multipleAuthn: boolean; authnContext: string | null; claimNames: string[] };
}

const resultAad = (publicId: string) => `sso_auth_requests.result:${publicId}`;
const verifierAad = (publicId: string) => `sso_auth_requests.verifier:${publicId}`;
const codeAad = (publicId: string) => `sso_auth_requests.code:${publicId}`;
const SECRET_AAD = "sso_configuration.client_secret";

const toStored = (claims: VerifiedEntraClaims): StoredResult => ({
  tid: claims.tenantId, oid: claims.objectId, amr: claims.amr ?? null, authTime: claims.authTime ?? null,
  email: claims.email, name: claims.name, roles: claims.roles,
});

export interface SsoInternals {
  deps: ModuleDeps;
  repo: UserRepo;
  sessions: SessionService;
  transitions: TransitionService;
  auth: AuthService;
  gates: Gates;
  signInLog: SignInLog;
  /** Admin-service in-tx actor guard (locks actor + target in id order, re-validates the session). */
  authorizeInTx: (tx: Tx, principal: SessionPrincipal, capability: "identity.sso.manage", targetPublicId?: string) => Promise<UserRow | null>;
}

export function createSsoService(i: SsoInternals) {
  const { deps, repo, sessions, transitions, auth } = i;
  const signInSignals = createSignInSignals(deps);
  const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number; lastForcedAt: number }>();
  const redirectUri = () => `${deps.config.canonicalOrigin.replace(/\/$/, "")}${SSO_CALLBACK_PATH}`;
  const availableInDeployment = () => deps.config.deploymentProfile !== "preview";
  const hash = (value: string) => deps.crypto.hashToken(value);
  const now = () => deps.clock.now();
  const egress = () => deps.services.integrations.egress;

  /* ------------------------------------------------------------------ configuration */

  async function loadConfig(tx?: Tx, forUpdate = false): Promise<SsoConfigurationRow | null> {
    const db = tx ?? deps.db;
    const query = db.select().from(ssoConfiguration).where(eq(ssoConfiguration.id, CONFIG_ID)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async function lockConfig(tx: Tx): Promise<SsoConfigurationRow> {
    // A NEW row is written with the increment-07 defaults; an existing (older) row keeps its NULLs (= old behaviour).
    await tx.insert(ssoConfiguration)
      .values({ id: CONFIG_ID, entraMfaMode: "claim", allowedRoles: JSON.stringify(NEW_CONFIG_ALLOWED_ROLES) })
      .onDuplicateKeyUpdate({ set: { id: sql`${ssoConfiguration.id}` } });
    return (await loadConfig(tx, true))!;
  }

  const domainsOf = (row: SsoConfigurationRow | null): string[] => {
    if (!row?.allowedDomains) return [];
    try {
      const parsed: unknown = JSON.parse(row.allowedDomains);
      return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
    } catch {
      return [];
    }
  };
  const isOidcComplete = (row: SsoConfigurationRow | null): row is SsoConfigurationRow & { tenantId: string; clientId: string; clientSecretEnc: string } =>
    !!row && !!row.tenantId && isTenantGuid(row.tenantId) && !!row.clientId && isTenantGuid(row.clientId) && !!row.clientSecretEnc;
  /** SAML additionally needs a trusted certificate; that (async) check is made at start, ACS and enable. */
  const isComplete = (row: SsoConfigurationRow | null): row is SsoConfigurationRow & { tenantId: string } =>
    !!row && (row.protocol === "saml" ? !!row.tenantId && isTenantGuid(row.tenantId) : isOidcComplete(row));
  const usable = (row: SsoConfigurationRow | null, purpose: SsoPurpose): row is SsoConfigurationRow & { tenantId: string } =>
    availableInDeployment() && isComplete(row) && (purpose === "test" || row.enabled);
  const jsonList = (raw: string | null | undefined): string[] | null => {
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
    } catch {
      return null;
    }
  };
  /** NULL on a pre-increment-07 row ⇒ the boolean it replaced. */
  const mfaModeOf = (row: SsoConfigurationRow | null): EntraMfaMode =>
    row?.entraMfaMode ?? (row ? (row.trustEntraMfa ? "claim" : "portal") : "claim");
  /** NULL on a pre-increment-07 row ⇒ every role (unchanged behaviour); a new row is written with admin + staff. */
  const allowedRolesOf = (row: SsoConfigurationRow | null): UserRole[] => {
    const list = jsonList(row?.allowedRoles);
    if (!row) return [...NEW_CONFIG_ALLOWED_ROLES];
    return list === null ? [...USER_ROLES] : USER_ROLES.filter((r) => list.includes(r));
  };
  const acceptedContextsOf = (row: SsoConfigurationRow | null): string[] => jsonList(row?.acceptedAuthnContexts) ?? [];
  const sp = (row: SsoConfigurationRow | null) => spUrls(deps.config.canonicalOrigin, row?.samlEntityId ?? null);
  /** Did Entra prove MFA for this sign-in (claim mode)? Values never leave the server. */
  const mfaProven = (row: SsoConfigurationRow, result: StoredResult): boolean =>
    result.saml
      ? result.saml.multipleAuthn || (result.saml.authnContext !== null && acceptedContextsOf(row).includes(result.saml.authnContext))
      : result.amr?.includes("mfa") === true;
  /** Portal MFA is skipped when the mode says so: claim ⇒ proven; entra ⇒ always; portal ⇒ never. */
  const entraMfaSatisfied = (row: SsoConfigurationRow, result: StoredResult): boolean => {
    const mode = mfaModeOf(row);
    return mode === "entra" ? true : mode === "claim" ? mfaProven(row, result) : false;
  };
  const domainAllowed = (row: SsoConfigurationRow, email: string | null) => {
    const allowed = domainsOf(row);
    if (allowed.length === 0) return true;
    const domain = emailDomain(email);
    return domain !== null && allowed.includes(domain);
  };

  const samlAdmin = createSamlAdmin({
    deps,
    lockConfig,
    authorize: (tx, principal) => i.authorizeInTx(tx, principal, "identity.sso.manage"),
    fetchMetadata: async (url) => {
      const response = await egress().fetchPinned(url, ENTRA_EGRESS_PURPOSE, {
        method: "GET", headers: { Accept: "application/samlmetadata+xml, application/xml, text/xml" }, timeoutMs: 10_000, maxResponseBytes: 512 * 1024,
      });
      if (response.status !== 200) throw new Error("metadata fetch failed");
      return response.body.toString("utf8");
    },
  });

  async function auditDenied(eventName: string, reasonCode: string, extra: Record<string, string> = {}) {
    try {
      await deps.audit.record({
        category: "security", eventName, action: "authenticate", outcome: "denied", severity: "WARN", reasonCode,
        actor: { role: "anonymous" }, resource: { type: "sso_request" }, provider: "entra", attributes: { ...extra, step: "sso" },
      });
    } catch {
      /* refusal stands regardless */
    }
    // D7: SSO callback/completion failures count towards automatic IP bans (no account reference is known).
    await signInSignals.publish({ kind: "sso_callback", outcome: "failure" });
  }

  function validateConfigInput(input: SsoConfigInput): void {
    const bad = (field: string, message: string) => validation("SSO_CONFIG_INVALID", message, { field });
    if (input.tenantId !== null) {
      const t = input.tenantId.trim().toLowerCase();
      if (["common", "organizations", "consumers"].includes(t)) throw bad("tenantId", "Enter your organization's tenant ID. Multi-tenant values such as common or organizations are not allowed.");
      if (!isTenantGuid(t)) throw bad("tenantId", "The tenant ID must be a directory (tenant) ID in GUID format.");
    }
    if (input.clientId !== null && !isTenantGuid(input.clientId.trim().toLowerCase())) throw bad("clientId", "The application (client) ID must be a GUID.");
    if (typeof input.clientSecret === "string" && (input.clientSecret.length < 16 || input.clientSecret.length > 512 || /[\s\p{Cc}]/u.test(input.clientSecret))) {
      throw bad("clientSecret", "The client secret value looks incomplete. Paste the secret's Value, not its ID.");
    }
    if (input.buttonLabel !== null && (input.buttonLabel.trim().length < 3 || input.buttonLabel.length > 40 || /[\p{Cc}<>]/u.test(input.buttonLabel))) {
      throw bad("buttonLabel", "The button label must be 3–40 characters.");
    }
    if (input.allowedDomains.length > 20 || !input.allowedDomains.every((d) => isValidDomain(d.trim().toLowerCase()))) {
      throw bad("allowedDomains", "Enter up to 20 domain names such as example.com.");
    }
    if (!SSO_JIT_MODES.includes(input.jitMode)) throw bad("jitMode", "Choose a provisioning mode.");
    if (input.jitMode === "staff" && (!input.jitStaffAppRole || !/^[A-Za-z0-9._-]{1,120}$/.test(input.jitStaffAppRole))) {
      throw bad("jitStaffAppRole", "Enter the app role value that staff members are assigned in Entra ID.");
    }
    if (input.jitStaffAppRole !== null && !/^[A-Za-z0-9._-]{1,120}$/.test(input.jitStaffAppRole)) throw bad("jitStaffAppRole", "App role values may contain letters, digits, dots, dashes and underscores.");
    if (!Number.isInteger(input.jitDailyLimit) || input.jitDailyLimit < 1 || input.jitDailyLimit > 500) throw bad("jitDailyLimit", "The daily limit must be between 1 and 500.");
    if (!SSO_PROTOCOLS.includes(input.protocol)) throw bad("protocol", "Choose OpenID Connect or SAML 2.0.");
    if (input.samlEntityId !== null && !isValidEntityId(input.samlEntityId.trim())) {
      throw bad("samlEntityId", "The Identifier must be an https URL, a urn: value or an api:// value (8–255 characters).");
    }
    if (!ENTRA_MFA_MODES.includes(input.entraMfaMode)) throw bad("entraMfaMode", "Choose how multi-factor authentication is handled.");
    if (input.acceptedAuthnContexts.length > 10 || !input.acceptedAuthnContexts.every((v) => /^(urn:|https?:\/\/)[\x21-\x7e]{3,250}$/.test(v.trim()))) {
      throw bad("acceptedAuthnContexts", "Enter up to 10 authentication context URIs.");
    }
    if (input.allowedRoles.length === 0 || !input.allowedRoles.every((r) => USER_ROLES.includes(r))) throw bad("allowedRoles", "Choose at least one role that may use single sign-on.");
  }

  async function adminView(tx?: Tx): Promise<SsoAdminView> {
    const row = await loadConfig(tx);
    const certificates = await samlAdmin.listCertificates(tx);
    const [linked] = await (tx ?? deps.db).select({ n: sql<number>`count(*)` }).from(ssoIdentities).where(eq(ssoIdentities.provider, "entra"));
    // Same transaction (never a second pool connection while locks are held). Advisory only: a failure hides the card.
    const breakGlass: SsoAdminView["breakGlass"] = await deps.services.assurance.breakGlassHealth(tx).catch(() => null);
    return {
      enabled: row?.enabled === true,
      tenantId: row?.tenantId ?? null,
      clientId: row?.clientId ?? null,
      clientSecret: { configured: !!row?.clientSecretEnc, last4: row?.clientSecretEnc ? row.clientSecretLast4 : null },
      buttonLabel: row?.buttonLabel ?? null,
      allowedDomains: domainsOf(row),
      trustEntraMfa: mfaModeOf(row) !== "portal",
      jitMode: row?.jitMode ?? "off",
      jitStaffAppRole: row?.jitStaffAppRole ?? null,
      jitDailyLimit: row?.jitDailyLimit ?? 25,
      redirectUri: redirectUri(),
      version: row?.version ?? 1,
      complete: isComplete(row) && (row.protocol !== "saml" || certificates.some((c) => c.state === "trusted")),
      availableInThisDeployment: availableInDeployment(),
      linkedAccounts: Number(linked?.n ?? 0),
      breakGlass,
      protocol: row?.protocol ?? "oidc",
      entraMfaMode: mfaModeOf(row),
      acceptedAuthnContexts: acceptedContextsOf(row),
      allowedRoles: allowedRolesOf(row),
      saml: {
        ...sp(row),
        entityIdIsDefault: !row?.samlEntityId,
        idpIssuer: row?.tenantId && isTenantGuid(row.tenantId) ? samlEndpoints(row.tenantId).issuer : null,
        requiredClaims: [...REQUIRED_SAML_CLAIMS],
        metadataSourceUrl: row?.samlMetadataUrl ?? null,
        metadataRefreshedAt: row?.samlMetadataRefreshedAt ?? null,
        metadataStatus: row?.samlMetadataStatus ?? null,
        certificates,
      },
      roleMappings: await samlAdmin.roleMappings(tx),
    };
  }

  /**
   * Read-only, unprivileged status summary for other modules' status cards / health (integrations hub).
   * Never contains secrets, tenant/client ids, certificate material or user identifiers. Not on tRPC/HTTP.
   */
  async function statusSummary(tx?: Tx): Promise<SsoStatusSummary> {
    const row = await loadConfig(tx);
    const certificates = await samlAdmin.listCertificates(tx);
    const trusted = certificates.filter((c) => c.state === "trusted");
    const nearest = trusted.reduce<Date | null>((min, c) => (min === null || c.notAfter < min ? c.notAfter : min), null);
    const [last] = await (tx ?? deps.db).select({ at: sql<Date | null>`max(${ssoIdentities.lastSignInAt})` }).from(ssoIdentities).where(eq(ssoIdentities.provider, "entra"));
    const lastAt = last?.at ? new Date(last.at) : null;
    const protocol = row?.protocol ?? "oidc";
    return {
      configured: (row?.tenantId ?? null) !== null,
      enabled: row?.enabled === true,
      complete: isComplete(row) && (protocol !== "saml" || trusted.length > 0),
      availableInThisDeployment: availableInDeployment(),
      protocol,
      entraMfaMode: mfaModeOf(row),
      trustedCertificates: trusted.length,
      nearestCertificateExpiry: protocol === "saml" ? nearest : null,
      metadataStatus: row?.samlMetadataStatus ?? null,
      metadataCheckedAt: row?.samlMetadataRefreshedAt ?? null,
      lastSignInAt: lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt : null,
      settingsPath: "/admin/sso",
    };
  }

  /* ------------------------------------------------------------------ Entra I/O */

  async function postToken(row: SsoConfigurationRow & { tenantId: string; clientId: string; clientSecretEnc: string }, code: string, verifier: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: row.clientId,
      client_secret: deps.crypto.decrypt(row.clientSecretEnc, SECRET_AAD),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
      scope: "openid profile email",
    }).toString();
    let response;
    try {
      response = await egress().fetchPinned(entraEndpoints(row.tenantId).token, ENTRA_EGRESS_PURPOSE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)), Accept: "application/json" },
        body,
        timeoutMs: 10_000,
        maxResponseBytes: 256_000,
      });
    } catch {
      throw new OidcValidationError("TOKEN_ENDPOINT_UNAVAILABLE");
    }
    if (response.status !== 200) throw new OidcValidationError(response.status >= 500 ? "TOKEN_ENDPOINT_UNAVAILABLE" : "TOKEN_EXCHANGE_REJECTED");
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new OidcValidationError("TOKEN_RESPONSE_INVALID");
    }
    const idToken = (parsed as { id_token?: unknown } | null)?.id_token;
    if (typeof idToken !== "string") throw new OidcValidationError("TOKEN_RESPONSE_INVALID");
    return idToken;
  }

  async function fetchJwks(tenantId: string): Promise<Jwk[]> {
    let response;
    try {
      response = await egress().fetchPinned(entraEndpoints(tenantId).jwks, ENTRA_EGRESS_PURPOSE, {
        method: "GET", headers: { Accept: "application/json" }, timeoutMs: 10_000, maxResponseBytes: 256_000,
      });
    } catch {
      throw new OidcValidationError("JWKS_UNAVAILABLE");
    }
    if (response.status !== 200) throw new OidcValidationError("JWKS_UNAVAILABLE");
    try {
      const parsed = JSON.parse(response.body.toString("utf8")) as { keys?: unknown };
      if (!Array.isArray(parsed.keys) || parsed.keys.length > 64) throw new Error("bad");
      return parsed.keys.filter((k): k is Jwk => !!k && typeof k === "object");
    } catch {
      throw new OidcValidationError("JWKS_INVALID");
    }
  }

  async function keyFor(tenantId: string, kid: string): Promise<Jwk> {
    const t = now().getTime();
    let entry = jwksCache.get(tenantId);
    if (!entry || t - entry.fetchedAt > JWKS_TTL_MS || t < entry.fetchedAt) {
      entry = { keys: await fetchJwks(tenantId), fetchedAt: t, lastForcedAt: entry?.lastForcedAt ?? 0 };
      jwksCache.set(tenantId, entry);
    }
    let key = selectKey(entry.keys, kid);
    // Unknown kid: Entra rotated keys. Refetch at most once per interval (bounded; no amplification).
    if (!key && t - entry.lastForcedAt >= JWKS_REFETCH_MIN_MS) {
      entry = { keys: await fetchJwks(tenantId), fetchedAt: t, lastForcedAt: t };
      jwksCache.set(tenantId, entry);
      key = selectKey(entry.keys, kid);
    }
    if (!key) throw new OidcValidationError("TOKEN_KEY_UNKNOWN");
    return key;
  }

  /* ------------------------------------------------------------------ request lifecycle */

  /** Protocol dispatch: SAML requests are found later by their (signed) InResponseTo, stored as stateHash. */
  async function newAuthorization(row: SsoConfigurationRow & { tenantId: string }, purpose: SsoPurpose, publicId: string) {
    const forceAuthn = purpose === "step_up" || purpose === "link";
    if (row.protocol === "saml") {
      const certificates = await samlAdmin.trustedPems();
      if (certificates.length === 0) throw refusal("SSO_UNAVAILABLE", "NO_TRUSTED_CERTIFICATE");
      const requestId = `_${randomToken(32)}`;
      const url = await buildAuthnRequestUrl({ tenantId: row.tenantId, sp: sp(row), certificates, requestId, forceAuthn });
      return { url, columns: { stateHash: hash(requestId), nonceHash: null, verifierEnc: null, protocol: "saml" as const, forceAuthn } };
    }
    if (!isOidcComplete(row)) throw refusal("SSO_UNAVAILABLE", "CONFIG_INCOMPLETE");
    return oidcAuthorization(row, purpose, publicId);
  }

  function oidcAuthorization(row: SsoConfigurationRow & { tenantId: string; clientId: string }, purpose: SsoPurpose, publicId: string) {
    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = randomToken(48); // 64 base64url chars (RFC 7636: 43–128)
    const url = authorizationUrl({
      tenantId: row.tenantId, clientId: row.clientId, redirectUri: redirectUri(), state, nonce, verifier,
      forceReauthentication: purpose === "step_up" || purpose === "link",
    });
    return {
      url,
      columns: {
        stateHash: hash(state), nonceHash: hash(nonce), verifierEnc: deps.crypto.encrypt(verifier, verifierAad(publicId)),
        protocol: "oidc" as const, forceAuthn: purpose === "step_up" || purpose === "link",
      },
    };
  }

  const service = {
    redirectUri,
    adminView,
    statusSummary,

    async publicConfig(): Promise<{ enabled: boolean; buttonLabel: string; providerName: string; protocol: SsoProtocol; startPath: string; customersAllowed: boolean }> {
      const row = await loadConfig();
      const protocol = row?.protocol ?? "oidc";
      return {
        enabled: usable(row, "sign_in"), buttonLabel: row?.buttonLabel ?? "Sign in with SSO", providerName: "Microsoft Entra ID",
        protocol, startPath: protocol === "saml" ? SAML_START_PATH : SSO_START_PATH, customersAllowed: allowedRolesOf(row).includes("customer"),
      };
    },

    /** Public SP metadata (only while SAML is the selected protocol). */
    async samlMetadata(): Promise<string | null> {
      const row = await loadConfig();
      return row?.protocol === "saml" ? serviceProviderMetadata(sp(row)) : null;
    },

    saml: samlAdmin,

    async updateConfig(principal: SessionPrincipal, input: SsoConfigInput): Promise<SsoAdminView> {
      validateConfigInput(input);
      return deps.db.transaction(async (tx) => {
        // Lock order: [policy] → sso_configuration → users (see complete()). The policy lock is taken only when
        // the break-glass rule must be re-checked (selecting `entra`).
        const peek = await loadConfig(tx);
        const choosingEntra = input.entraMfaMode === "entra" && mfaModeOf(peek) !== "entra";
        if (choosingEntra) await deps.services.assurance.lockLocalAdministratorPolicy(tx);
        const row = await lockConfig(tx);
        await i.authorizeInTx(tx, principal, "identity.sso.manage");
        if (row.version !== input.expectedVersion) {
          throw conflict("STALE_VERSION", "Single sign-on settings were changed by someone else. Reload and try again.");
        }
        const oldMode = mfaModeOf(row);
        if (input.entraMfaMode === "entra" && oldMode !== "entra") {
          if (input.entraModeConfirmation !== ENTRA_MODE_CONFIRMATION) {
            throw validation("SSO_ENTRA_MODE_CONFIRMATION", `Type ${ENTRA_MODE_CONFIRMATION} to confirm that Microsoft Entra ID enforces multi-factor authentication.`, { field: "entraModeConfirmation" });
          }
          // Break-glass: local sign-in keeps MFA; at least one local administrator with MFA must remain.
          await deps.services.assurance.assertLocalAdministratorRemains(tx);
        }
        const tenantId = input.tenantId?.trim().toLowerCase() ?? null;
        const clientId = input.clientId?.trim().toLowerCase() ?? null;
        const secretChanged = input.clientSecret !== undefined;
        const bindingChanged = tenantId !== row.tenantId || clientId !== row.clientId || secretChanged;
        const protocolChanged = input.protocol !== row.protocol;
        const entityId = input.samlEntityId?.trim() || null;
        const entityChanged = entityId !== row.samlEntityId;
        const stricterMfa = MFA_MODE_RANK[input.entraMfaMode] > MFA_MODE_RANK[oldMode];
        const oldRoles = allowedRolesOf(row);
        const newRoles = USER_ROLES.filter((r) => input.allowedRoles.includes(r));
        const removedRoles = oldRoles.filter((r) => !newRoles.includes(r));
        const oldContexts = acceptedContextsOf(row);
        const contexts = [...new Set(input.acceptedAuthnContexts.map((v) => v.trim()))];
        const contextsNarrowed = oldContexts.some((v) => !contexts.includes(v));
        const patch: Partial<SsoConfigurationRow> = {
          tenantId,
          clientId,
          buttonLabel: input.buttonLabel?.trim() || null,
          allowedDomains: JSON.stringify([...new Set(input.allowedDomains.map((d) => d.trim().toLowerCase()))]),
          // Deprecated column, still written so a rolled-back release reads a matching value.
          trustEntraMfa: input.entraMfaMode !== "portal",
          entraMfaMode: input.entraMfaMode,
          acceptedAuthnContexts: JSON.stringify(contexts),
          allowedRoles: JSON.stringify(newRoles),
          protocol: input.protocol,
          samlEntityId: entityId,
          jitMode: input.jitMode,
          jitStaffAppRole: input.jitStaffAppRole,
          jitDailyLimit: input.jitDailyLimit,
          updatedByUserId: principal.userId,
          version: row.version + 1,
          // In-flight attempts die with any binding, protocol or Identifier change; links do not.
          ...(bindingChanged || protocolChanged || entityChanged ? { epoch: row.epoch + 1 } : {}),
          ...(secretChanged
            ? input.clientSecret === null
              ? { clientSecretEnc: null, clientSecretLast4: null }
              : { clientSecretEnc: deps.crypto.encrypt(input.clientSecret!, SECRET_AAD), clientSecretLast4: input.clientSecret!.slice(-4) }
            : {}),
        };
        // A configuration without the essentials cannot stay enabled.
        const next = { ...row, ...patch } as SsoConfigurationRow;
        if (row.enabled && !isComplete(next)) patch.enabled = false;
        if (row.enabled && next.protocol === "saml" && (await samlAdmin.trustedPems(tx)).length === 0) patch.enabled = false;
        await tx.update(ssoConfiguration).set(patch).where(eq(ssoConfiguration.id, CONFIG_ID));
        let revoked = 0;
        // Entra sessions end when the tenant / application changes, or when the MFA rule becomes stricter
        // (sessions may rest on an Entra MFA the new rule no longer accepts). A protocol switch keeps them.
        if (bindingChanged || stricterMfa || (contextsNarrowed && input.entraMfaMode === "claim")) {
          const [result] = (await tx
            .update(userSessions)
            .set({ revokedAt: now(), revokeReason: "sso_config_changed" })
            .where(and(eq(userSessions.authMethod, "entra"), isNull(userSessions.revokedAt)))) as unknown as [{ affectedRows?: number }];
          revoked = result?.affectedRows ?? 0;
        } else if (removedRoles.length > 0) {
          const affected = await tx.select({ id: users.id }).from(users).where(inArray(users.role, removedRoles));
          if (affected.length > 0) {
            const [result] = (await tx
              .update(userSessions)
              .set({ revokedAt: now(), revokeReason: "sso_config_changed" })
              .where(and(eq(userSessions.authMethod, "entra"), isNull(userSessions.revokedAt), inArray(userSessions.userId, affected.map((u) => u.id))))) as unknown as [{ affectedRows?: number }];
            revoked = result?.affectedRows ?? 0;
          }
        }
        await deps.audit.record(
          {
            category: "admin", eventName: "identity.sso.config_updated", action: "update", outcome: "completed",
            resource: { type: "sso_configuration" }, provider: "entra",
            safeCounts: { allowed_domains: input.allowedDomains.length, entra_sessions_revoked: revoked, accepted_contexts: contexts.length },
            attributes: {
              binding_changed: bindingChanged, secret_changed: secretChanged, protocol: input.protocol, protocol_changed: protocolChanged,
              mfa_mode: input.entraMfaMode, allowed_roles: newRoles.join(","), jit_mode: input.jitMode, auto_disabled: patch.enabled === false,
            },
          },
          tx,
        );
        if (input.entraMfaMode !== oldMode) {
          await deps.audit.record(
            {
              category: "admin", eventName: "identity.sso.mfa_mode_changed", action: "update", outcome: "completed",
              severity: input.entraMfaMode === "entra" ? "WARN" : "INFO", reasonCode: input.entraMfaMode === "entra" ? "PORTAL_MFA_DELEGATED_TO_ENTRA" : undefined,
              resource: { type: "sso_configuration" }, provider: "entra", attributes: { from: oldMode, to: input.entraMfaMode },
            },
            tx,
          );
        }
        return adminView(tx);
      });
    },

    async setEnabled(principal: SessionPrincipal, enabled: boolean, expectedVersion: number): Promise<SsoAdminView> {
      return deps.db.transaction(async (tx) => {
        // Break-glass: the policy lock is taken before any users lock (assurance contract).
        await deps.services.assurance.lockLocalAdministratorPolicy(tx);
        const row = await lockConfig(tx);
        await i.authorizeInTx(tx, principal, "identity.sso.manage");
        if (row.version !== expectedVersion) throw conflict("STALE_VERSION", "Single sign-on settings were changed by someone else. Reload and try again.");
        if (row.enabled === enabled) return adminView(tx);
        if (enabled) {
          if (!availableInDeployment()) throw new DomainError("FORBIDDEN", "SSO_NOT_AVAILABLE_IN_PREVIEW", "Single sign-on cannot be enabled in the preview deployment.");
          if (!isComplete(row)) {
            throw validation("SSO_CONFIG_INCOMPLETE", row.protocol === "saml"
              ? "Enter the tenant ID before enabling single sign-on."
              : "Enter the tenant ID, client ID and client secret before enabling single sign-on.");
          }
          if (row.protocol === "saml" && (await samlAdmin.trustedPems(tx)).length === 0) {
            throw validation("SSO_SAML_CERTIFICATE_REQUIRED", "Import the Entra federation metadata or add the signing certificate before enabling single sign-on.");
          }
          await deps.services.assurance.assertLocalAdministratorRemains(tx);
        }
        await tx.update(ssoConfiguration).set({ enabled, version: row.version + 1, updatedByUserId: principal.userId, ...(enabled ? {} : { epoch: row.epoch + 1 }) }).where(eq(ssoConfiguration.id, CONFIG_ID));
        await deps.audit.record(
          { category: "admin", eventName: enabled ? "identity.sso.enabled" : "identity.sso.disabled", action: "update", outcome: "completed", resource: { type: "sso_configuration" }, provider: "entra" },
          tx,
        );
        return adminView(tx);
      });
    },

    /** Public sign-in start (no session involved). Returns the Entra URL; the caller sets the cookie. */
    async startSignIn(input: { next: unknown; browser: string }): Promise<string> {
      const row = await loadConfig();
      if (!usable(row, "sign_in")) throw refusal("SSO_UNAVAILABLE");
      const publicId = ulid(now().getTime());
      const authz = await newAuthorization(row, "sign_in", publicId);
      const t = now();
      await deps.db.insert(ssoAuthRequests).values({
        publicId, purpose: "sign_in", status: "pending", ...authz.columns, browserHash: hash(input.browser),
        configEpoch: row!.epoch, nextPath: safeServerNext(input.next), requestedAt: t, expiresAt: new Date(t.getTime() + PENDING_TTL_MS),
      });
      return authz.url;
    },

    /** Session-bound preparation for link / step-up / test (tRPC, CSRF-protected). */
    async prepare(principal: SessionPrincipal, purpose: Exclude<SsoPurpose, "sign_in">, next: unknown): Promise<{ startUrl: string }> {
      if (principal.state !== "full") throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
      const row = await loadConfig();
      if (!usable(row, purpose)) throw refusal("SSO_UNAVAILABLE");
      if (purpose === "test" && !roleHasCapability(principal.role, "identity.sso.manage")) throw forbidden("CAPABILITY_NOT_GRANTED");
      if ((purpose === "test" || purpose === "link") && !hasFreshStepUp(principal, now())) {
        throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your identity to continue.");
      }
      const [link] = await deps.db.select().from(ssoIdentities).where(and(eq(ssoIdentities.userId, principal.userId), eq(ssoIdentities.provider, "entra"))).limit(1);
      if (purpose === "link" && link) throw conflict("SSO_ALREADY_LINKED", "Your account is already linked to a Microsoft account.");
      if (purpose === "step_up" && (principal.authMethod !== "entra" || !link?.verifiedAt)) {
        throw new DomainError("FORBIDDEN", "SSO_STEP_UP_NOT_AVAILABLE", "Confirm your identity with your portal authenticator instead.");
      }
      const ticket = randomToken(32);
      const t = now();
      await deps.db.insert(ssoAuthRequests).values({
        publicId: ulid(t.getTime()), purpose, status: "prepared", ticketHash: hash(ticket), sessionPublicId: principal.sessionId,
        userId: principal.userId, configEpoch: row!.epoch, nextPath: safeServerNext(next), requestedAt: t, expiresAt: new Date(t.getTime() + PREPARED_TTL_MS),
      });
      return { startUrl: `${SSO_START_PATH}?ticket=${encodeURIComponent(ticket)}` };
    },

    /** GET start with a ticket: the ticket's session must be the browser's live session. */
    async startWithTicket(input: { ticket: string; session: SessionPrincipal | null; browser: string }): Promise<string> {
      if (!input.session) throw refusal("SSO_SESSION_CHANGED");
      const t = now();
      const [req] = await deps.db.select().from(ssoAuthRequests).where(eq(ssoAuthRequests.ticketHash, hash(input.ticket))).limit(1);
      if (!req || req.status !== "prepared" || req.expiresAt.getTime() <= t.getTime()) throw refusal("SSO_EXPIRED");
      if (req.sessionPublicId !== input.session.sessionId || req.userId !== input.session.userId) throw refusal("SSO_SESSION_CHANGED");
      const row = await loadConfig();
      if (!usable(row, req.purpose) || row!.epoch !== req.configEpoch) throw refusal("SSO_EXPIRED");
      // Request time for auth_time freshness is the moment the browser leaves for Entra.
      const authz = await newAuthorization(row, req.purpose, req.publicId);
      const [result] = (await deps.db
        .update(ssoAuthRequests)
        .set({ status: "pending", ...authz.columns, ticketHash: null, browserHash: hash(input.browser), requestedAt: t, expiresAt: new Date(t.getTime() + PENDING_TTL_MS) })
        .where(and(eq(ssoAuthRequests.id, req.id), eq(ssoAuthRequests.status, "prepared")))) as unknown as [{ affectedRows?: number }];
      if ((result?.affectedRows ?? 0) !== 1) throw refusal("SSO_EXPIRED");
      return authz.url;
    },

    /**
     * Callback (provider's cross-site GET; only the Lax pre-auth binder cookie is present). Consumes state
     * atomically, bound to this browser. Plain sign-in exchanges the code here; session-bound purposes
     * (link / step-up / test) PARK the encrypted code for ≤ 2 minutes and never exchange it here (G-O01) —
     * the exchange happens in complete(), where the Strict session cookie is present. Returns a same-origin
     * SPA path carrying only the opaque attempt handle (never the code or the state).
     */
    async callback(input: { state: unknown; code: unknown; error: unknown; browser: string | undefined }): Promise<string> {
      const refused = (code: SsoRefusal) => `/sso/refused?reason=${code}`;
      if (typeof input.state !== "string" || input.state.length < 20 || input.state.length > 128 || !input.browser) {
        await auditDenied("identity.sso.callback_refused", !input.browser ? "BROWSER_BINDING_MISSING" : "STATE_MISSING");
        return refused("SSO_EXPIRED");
      }
      const t = now();
      const stateHash = hash(input.state);
      const [claim] = (await deps.db
        .update(ssoAuthRequests)
        .set({ status: "refused", refusalCode: "IN_PROGRESS", callbackAt: t })
        .where(and(
          eq(ssoAuthRequests.stateHash, stateHash), eq(ssoAuthRequests.status, "pending"), eq(ssoAuthRequests.browserHash, hash(input.browser)),
          eq(ssoAuthRequests.protocol, "oidc"), gt(ssoAuthRequests.expiresAt, t),
        ))) as unknown as [{ affectedRows?: number }];
      if ((claim?.affectedRows ?? 0) !== 1) {
        await auditDenied("identity.sso.callback_refused", "STATE_INVALID_OR_REPLAYED");
        return refused("SSO_EXPIRED");
      }
      const [req] = await deps.db.select().from(ssoAuthRequests).where(eq(ssoAuthRequests.stateHash, stateHash)).limit(1);
      if (!req) return refused("SSO_EXPIRED");
      const fail = async (publicCode: SsoRefusal, detail: string) => {
        await deps.db.update(ssoAuthRequests).set({ refusalCode: detail.slice(0, 40), stateHash: null, nonceHash: null, verifierEnc: null, codeEnc: null }).where(eq(ssoAuthRequests.id, req.id));
        await auditDenied("identity.sso.callback_refused", detail, { purpose: req.purpose });
        return refused(publicCode);
      };
      if (typeof input.error === "string") return fail("SSO_CANCELLED", input.error === "access_denied" ? "IDP_ACCESS_DENIED" : "IDP_ERROR");
      if (typeof input.code !== "string" || input.code.length < 10 || input.code.length > 4096 || !/^[\x21-\x7e]+$/.test(input.code)) return fail("SSO_FAILED", "CODE_MISSING");
      const row = await loadConfig();
      if (!usable(row, req.purpose)) return fail("SSO_UNAVAILABLE", "SSO_DISABLED");
      if (row!.epoch !== req.configEpoch) return fail("SSO_EXPIRED", "CONFIG_CHANGED");
      const done = now();
      const handle = `/sso/complete?attempt=${req.publicId}`;
      if (req.purpose !== "sign_in") {
        await deps.db
          .update(ssoAuthRequests)
          .set({ status: "verified", refusalCode: null, stateHash: null, codeEnc: deps.crypto.encrypt(input.code, codeAad(req.publicId)), expiresAt: new Date(done.getTime() + VERIFIED_TTL_MS) })
          .where(and(eq(ssoAuthRequests.id, req.id), eq(ssoAuthRequests.status, "refused"), eq(ssoAuthRequests.refusalCode, "IN_PROGRESS")));
        return handle;
      }
      let claims: VerifiedEntraClaims;
      try {
        claims = await exchangeAndVerify(row!, req, input.code);
      } catch (error) {
        const reason = error instanceof OidcValidationError ? error.reasonCode : "VALIDATION_ERROR";
        return fail(reason.endsWith("UNAVAILABLE") ? "SSO_UNAVAILABLE" : "SSO_FAILED", reason);
      }
      await deps.db
        .update(ssoAuthRequests)
        .set({
          status: "verified", refusalCode: null, stateHash: null, nonceHash: null, verifierEnc: null,
          resultEnc: deps.crypto.encrypt(JSON.stringify(toStored(claims)), resultAad(req.publicId)), expiresAt: new Date(now().getTime() + VERIFIED_TTL_MS),
        })
        .where(and(eq(ssoAuthRequests.id, req.id), eq(ssoAuthRequests.status, "refused"), eq(ssoAuthRequests.refusalCode, "IN_PROGRESS")));
      return handle;
    },

    /**
     * SAML Assertion Consumer Service (Entra's cross-site form POST; no session or cookie is read — the browser
     * binder is checked later in complete(), on the same-site POST). The signed InResponseTo selects the
     * pending request atomically (single use); the assertion ID is stored under a unique key (replay defence).
     * Returns a same-origin SPA path carrying only the opaque attempt handle.
     */
    async acs(input: { samlResponse: unknown }): Promise<string> {
      const refused = (code: SsoRefusal) => `/sso/refused?reason=${code}`;
      const row = await loadConfig();
      if (!row || row.protocol !== "saml" || !availableInDeployment() || !isComplete(row)) {
        await auditDenied("identity.sso.callback_refused", "SAML_NOT_CONFIGURED", { protocol: "saml" });
        return refused("SSO_UNAVAILABLE");
      }
      let assertion;
      try {
        assertion = await verifySamlResponse(input.samlResponse, {
          tenantId: row.tenantId, sp: sp(row), certificates: await samlAdmin.trustedPems(), nowMs: now().getTime(),
        });
      } catch (error) {
        const reason = error instanceof SamlValidationError ? error.reasonCode : "VALIDATION_ERROR";
        await auditDenied("identity.sso.callback_refused", reason, { protocol: "saml" });
        return refused(reason === "IDP_STATUS_NOT_SUCCESS" ? "SSO_CANCELLED" : "SSO_FAILED");
      }
      const t = now();
      const stateHash = hash(assertion.inResponseTo);
      const [claim] = (await deps.db
        .update(ssoAuthRequests)
        .set({ status: "refused", refusalCode: "IN_PROGRESS", callbackAt: t })
        .where(and(
          eq(ssoAuthRequests.stateHash, stateHash), eq(ssoAuthRequests.status, "pending"), eq(ssoAuthRequests.protocol, "saml"),
          gt(ssoAuthRequests.expiresAt, t),
        ))) as unknown as [{ affectedRows?: number }];
      if ((claim?.affectedRows ?? 0) !== 1) {
        await auditDenied("identity.sso.callback_refused", "IN_RESPONSE_TO_INVALID_OR_REPLAYED", { protocol: "saml" });
        return refused("SSO_EXPIRED");
      }
      const [req] = await deps.db.select().from(ssoAuthRequests).where(eq(ssoAuthRequests.stateHash, stateHash)).limit(1);
      if (!req) return refused("SSO_EXPIRED");
      const fail = async (publicCode: SsoRefusal, detail: string) => {
        await deps.db.update(ssoAuthRequests).set({ refusalCode: detail.slice(0, 40), stateHash: null }).where(eq(ssoAuthRequests.id, req.id));
        await auditDenied("identity.sso.callback_refused", detail, { purpose: req.purpose, protocol: "saml" });
        return refused(publicCode);
      };
      if (!usable(row, req.purpose)) return fail("SSO_UNAVAILABLE", "SSO_DISABLED");
      if (row.epoch !== req.configEpoch) return fail("SSO_EXPIRED", "CONFIG_CHANGED");
      // ForceAuthn (link / step-up): the Entra authentication must be fresh for THIS request.
      if (req.forceAuthn && assertion.authnInstantMs < req.requestedAt.getTime() - SAML_CLOCK_SKEW_MS) return fail("SSO_FAILED", "AUTHN_NOT_FRESH");
      const facts = samlMfaFacts(assertion, acceptedContextsOf(row));
      const stored: StoredResult = {
        tid: assertion.tenantId, oid: assertion.objectId, amr: null, authTime: Math.floor(assertion.authnInstantMs / 1000),
        email: assertion.email, name: assertion.name, roles: assertion.roles,
        saml: { multipleAuthn: facts.multipleAuthn, authnContext: assertion.authnContextClassRef, claimNames: assertion.attributeNames },
      };
      try {
        await deps.db
          .update(ssoAuthRequests)
          .set({
            status: "verified", refusalCode: null, stateHash: null, assertionIdHash: hash(`${row.tenantId}:${assertion.assertionId}`),
            resultEnc: deps.crypto.encrypt(JSON.stringify(stored), resultAad(req.publicId)), expiresAt: new Date(now().getTime() + VERIFIED_TTL_MS),
          })
          .where(and(eq(ssoAuthRequests.id, req.id), eq(ssoAuthRequests.status, "refused"), eq(ssoAuthRequests.refusalCode, "IN_PROGRESS")));
      } catch (error) {
        if (isDuplicateKey(error)) return fail("SSO_EXPIRED", "ASSERTION_REPLAYED");
        throw error;
      }
      return `/sso/complete?attempt=${req.publicId}`;
    },

    /**
     * Step 2 (POST, CSRF-protected, same-site ⇒ Strict session cookie present). Requires the same browser
     * binder and the opaque attempt handle; the attempt is burned (single use) before any other check. Link /
     * step-up / test also require the LIVE session to be exactly the initiating session and actor; only then
     * is the parked code exchanged. Final checks run under the configuration lock.
     */
    async complete(input: { attempt: string; browser: string | undefined; session: SessionPrincipal | null; userAgent?: string }): Promise<SsoCompletion> {
      if (!input.browser || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input.attempt)) throw refusal("SSO_EXPIRED");
      const t = now();
      const [req] = await deps.db
        .select()
        .from(ssoAuthRequests)
        .where(and(eq(ssoAuthRequests.publicId, input.attempt), eq(ssoAuthRequests.browserHash, hash(input.browser))))
        .limit(1);
      if (!req) throw refusal("SSO_EXPIRED");
      // Burn first: whatever happens next, this attempt cannot be used again.
      const [claimed] = (await deps.db
        .update(ssoAuthRequests)
        .set({ status: "completed", completedAt: t, resultEnc: null, codeEnc: null, verifierEnc: null, nonceHash: null })
        .where(and(eq(ssoAuthRequests.id, req.id), eq(ssoAuthRequests.status, "verified"), gt(ssoAuthRequests.expiresAt, t)))) as unknown as [{ affectedRows?: number }];
      try {
        if ((claimed?.affectedRows ?? 0) !== 1) throw refusal("SSO_EXPIRED", "ATTEMPT_REPLAYED_OR_EXPIRED");
        let result: StoredResult;
        if (req.protocol === "saml") {
          if (req.purpose !== "sign_in") {
            const principal = requireSameSession(req, input.session);
            if (principal.state !== "full") throw refusal("SSO_SESSION_CHANGED", "SESSION_NOT_FULL");
          }
          if (!req.resultEnc) throw refusal("SSO_EXPIRED", "RESULT_MISSING");
          result = JSON.parse(deps.crypto.decrypt(req.resultEnc, resultAad(req.publicId))) as StoredResult;
        } else if (req.purpose === "sign_in") {
          if (!req.resultEnc) throw refusal("SSO_EXPIRED", "RESULT_MISSING");
          result = JSON.parse(deps.crypto.decrypt(req.resultEnc, resultAad(req.publicId))) as StoredResult;
        } else {
          const principal = requireSameSession(req, input.session);
          if (principal.state !== "full") throw refusal("SSO_SESSION_CHANGED", "SESSION_NOT_FULL");
          if (!req.codeEnc) throw refusal("SSO_EXPIRED", "CODE_MISSING");
          const config = await loadConfig();
          if (!usable(config, req.purpose) || config!.epoch !== req.configEpoch) throw refusal("SSO_EXPIRED", "CONFIG_CHANGED");
          try {
            result = toStored(await exchangeAndVerify(config!, req, deps.crypto.decrypt(req.codeEnc, codeAad(req.publicId))));
          } catch (error) {
            if (!(error instanceof OidcValidationError)) throw error;
            throw refusal(error.reasonCode.endsWith("UNAVAILABLE") ? "SSO_UNAVAILABLE" : "SSO_FAILED", error.reasonCode);
          }
        }
        return await deps.db.transaction(async (tx) => {
          // Lock order for every SSO path: [policy] → sso_configuration → users (ascending) → user_sessions →
          // sso_identities. Holding the configuration lock serializes this completion with configuration
          // changes, so a policy change either fully precedes (refusal) or fully follows (its revocation
          // sees the new session) — I-A02.
          const config = await lockConfig(tx);
          if (!usable(config, req.purpose) || config.epoch !== req.configEpoch || config.tenantId !== result.tid || config.protocol !== req.protocol) {
            throw refusal("SSO_EXPIRED", "CONFIG_CHANGED");
          }
          switch (req.purpose) {
            case "sign_in":
              return await completeSignIn(tx, req, result, config, input.userAgent);
            case "link":
              return await completeLink(tx, req, result, config, input.session);
            case "step_up":
              return await completeStepUp(tx, req, result, config, input.session);
            case "test":
              return await completeTest(tx, req, result, config, input.session);
          }
        });
      } catch (error) {
        if (isSsoRefusal(error) || (error instanceof DomainError && error.reasonCode === "STEP_UP_REQUIRED")) {
          await deps.db.update(ssoAuthRequests).set({ status: "refused", refusalCode: error.reasonCode.slice(0, 40), resultEnc: null, codeEnc: null, completedAt: t }).where(eq(ssoAuthRequests.id, req.id));
          const detail = typeof error.details?.detail === "string" ? error.details.detail : error.reasonCode;
          if (req.purpose === "sign_in") {
            const refusedKinds = ["SSO_MAINTENANCE", "SSO_RESTRICTED", "SSO_DOMAIN_NOT_ALLOWED", "SSO_ACCOUNT_INACTIVE", "SSO_PROVISIONING_LIMIT", "SSO_ROLE_NOT_ASSIGNED", "SSO_ROLE_NOT_ALLOWED"];
            await i.signInLog.note({ kind: refusedKinds.includes(error.reasonCode) ? "refused" : "failure", reasonCode: detail, authMethod: "entra" });
            try {
              await deps.audit.record({
                category: "security", eventName: "auth.login.refused", action: "login", outcome: "denied", severity: "WARN", reasonCode: detail,
                actor: { role: "anonymous" }, resource: { type: "user" }, provider: "entra", attributes: { auth_method: "entra" },
              });
            } catch {
              /* refusal stands regardless */
            }
          } else {
            await auditDenied("identity.sso.completion_refused", detail, { purpose: req.purpose });
          }
        }
        throw error;
      }
    },

    /* ------------------------------------------------------------------ linking management */

    async myLink(principal: SessionPrincipal) {
      const [link] = await deps.db.select().from(ssoIdentities).where(and(eq(ssoIdentities.userId, principal.userId), eq(ssoIdentities.provider, "entra"))).limit(1);
      const user = await repo.byId(principal.userId);
      const config = await loadConfig();
      return {
        available: usable(config, "link") && allowedRolesOf(config).includes(principal.role),
        linked: !!link?.verifiedAt,
        pendingAdministratorBinding: !!link && !link.verifiedAt,
        linkedAt: link?.linkedAt ?? null,
        lastSignInAt: link?.lastSignInAt ?? null,
        hasPassword: user?.passwordHash !== null && user?.passwordHash !== undefined,
      };
    },

    async unlinkSelf(principal: SessionPrincipal): Promise<void> {
      await deps.db.transaction(async (tx) => {
        const user = await repo.byId(principal.userId, { tx, forUpdate: true });
        const current = await sessions.assertCurrent(principal, tx);
        if (!user || current.pendingSteps.length > 0) throw forbidden("ACCOUNT_STEPS_PENDING");
        const age = current.stepUpAt ? now().getTime() - current.stepUpAt.getTime() : -1;
        if (!(age >= 0 && age <= STEP_UP_MAX_AGE_MS)) throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your identity to continue.");
        if (!user.passwordHash || user.authSource !== "local") {
          throw conflict("SSO_ONLY_ACCOUNT", "Your account signs in only with Microsoft. Ask an administrator to set up a password before unlinking.");
        }
        const [link] = await tx.select().from(ssoIdentities).where(and(eq(ssoIdentities.userId, user.id), eq(ssoIdentities.provider, "entra"))).limit(1).for("update");
        if (!link) throw notFound("SSO_NOT_LINKED");
        await tx.delete(ssoIdentities).where(eq(ssoIdentities.id, link.id));
        // Entra sessions of this user end with the link.
        const revoked = await revokeEntraSessions(tx, user.id, principal.sessionId);
        await deps.audit.record(
          { category: "security", eventName: "identity.sso.unlinked", action: "delete", outcome: "completed", resource: { type: "user", publicId: user.publicId }, provider: "entra", safeCounts: { entra_sessions_revoked: revoked }, attributes: { by: "self" } },
          tx,
        );
      });
    },

    /** Administrator binding: (configured tenant, object id) for a named user; usable after a completed Entra callback. */
    async bindUser(principal: SessionPrincipal, targetPublicId: string, objectId: string): Promise<{ status: "pending_verification" }> {
      const oid = objectId.trim().toLowerCase();
      if (!isTenantGuid(oid)) throw validation("SSO_OBJECT_ID_INVALID", "The object ID must be a GUID from the user's Entra ID profile.", { field: "objectId" });
      return deps.db.transaction(async (tx) => {
        const target = await i.authorizeInTx(tx, principal, "identity.sso.manage", targetPublicId);
        if (!target) throw notFound("USER_NOT_FOUND");
        const config = await loadConfig(tx);
        if (!isComplete(config)) throw validation("SSO_CONFIG_INCOMPLETE", "Configure single sign-on before linking accounts.");
        if (target.status === "deactivated") throw conflict("ACCOUNT_INACTIVE", "This account is deactivated.");
        const existing = await tx.select().from(ssoIdentities)
          .where(or(and(eq(ssoIdentities.userId, target.id), eq(ssoIdentities.provider, "entra")), and(eq(ssoIdentities.provider, "entra"), eq(ssoIdentities.tenantId, config.tenantId), eq(ssoIdentities.objectId, oid))))
          .for("update");
        if (existing.some((r) => r.userId !== target.id)) throw conflict("SSO_IDENTITY_IN_USE", "This Microsoft account is already linked to a different portal account.");
        if (existing.length > 0) throw conflict("SSO_ALREADY_LINKED", "This account already has a Microsoft link. Unlink it first.");
        const t = now();
        await tx.insert(ssoIdentities).values({ userId: target.id, provider: "entra", tenantId: config.tenantId, objectId: oid, linkMethod: "admin", linkedByUserId: principal.userId, linkedAt: t, verifiedAt: null });
        await deps.audit.record(
          { category: "admin", eventName: "identity.sso.bound", action: "create", outcome: "completed", resource: { type: "user", publicId: target.publicId }, provider: "entra", attributes: { status: "pending_verification" } },
          tx,
        );
        return { status: "pending_verification" as const };
      });
    },

    async unbindUser(principal: SessionPrincipal, targetPublicId: string): Promise<void> {
      await deps.db.transaction(async (tx) => {
        const target = await i.authorizeInTx(tx, principal, "identity.sso.manage", targetPublicId);
        if (!target) throw notFound("USER_NOT_FOUND");
        const [link] = await tx.select().from(ssoIdentities).where(and(eq(ssoIdentities.userId, target.id), eq(ssoIdentities.provider, "entra"))).limit(1).for("update");
        if (!link) throw notFound("SSO_NOT_LINKED");
        await tx.delete(ssoIdentities).where(eq(ssoIdentities.id, link.id));
        const revoked = await revokeEntraSessions(tx, target.id, target.id === principal.userId ? principal.sessionId : undefined);
        await deps.audit.record(
          { category: "admin", eventName: "identity.sso.unlinked", action: "delete", outcome: "completed", resource: { type: "user", publicId: target.publicId }, provider: "entra", safeCounts: { entra_sessions_revoked: revoked }, attributes: { by: "administrator", sso_only_account: !target.passwordHash } },
          tx,
        );
      });
    },

    /** Sign-in methods per user (by publicId) for the staff / customer lists (bounded batch). */
    async signInMethods(publicIds: readonly string[]): Promise<Map<string, SignInMethods>> {
      const out = new Map<string, SignInMethods>();
      const ids = [...new Set(publicIds)].slice(0, 200);
      if (ids.length === 0) return out;
      const rows = await deps.db.select({ id: users.id, publicId: users.publicId, passwordHash: users.passwordHash }).from(users).where(inArray(users.publicId, ids));
      if (rows.length === 0) return out;
      const byId = new Map<number, SignInMethods>();
      for (const row of rows) {
        const entry: SignInMethods = { password: row.passwordHash !== null, sso: null };
        out.set(row.publicId, entry);
        byId.set(row.id, entry);
      }
      const links = await deps.db
        .select({ userId: ssoIdentities.userId, verifiedAt: ssoIdentities.verifiedAt })
        .from(ssoIdentities)
        .where(and(inArray(ssoIdentities.userId, [...byId.keys()]), eq(ssoIdentities.provider, "entra")));
      for (const link of links) {
        const entry = byId.get(link.userId);
        if (entry) entry.sso = link.verifiedAt ? "linked" : "pending";
      }
      return out;
    },

    /** Removes finished / expired authorization requests (scheduled). */
    async prune(): Promise<number> {
      const cutoff = new Date(now().getTime() - 24 * 60 * 60_000);
      const [result] = (await deps.db.delete(ssoAuthRequests).where(lt(ssoAuthRequests.expiresAt, cutoff))) as unknown as [{ affectedRows?: number }];
      // Expired-but-recent rows lose their secrets immediately.
      await deps.db.update(ssoAuthRequests).set({ stateHash: null, nonceHash: null, verifierEnc: null, resultEnc: null, codeEnc: null, ticketHash: null }).where(lt(ssoAuthRequests.expiresAt, now()));
      return result?.affectedRows ?? 0;
    },
  };

  function verifyIdTokenWithNonceHash(idToken: string, key: Jwk, config: { tenantId: string; clientId: string }, nonceHash: string, nowSeconds: number): VerifiedEntraClaims {
    // The plaintext nonce is not stored; the claim is accepted only if hashToken(claim) equals the stored hash.
    const payload = idToken.split(".")[1] ?? "";
    const readNonce = (): string => {
      try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { nonce?: unknown };
        return typeof parsed.nonce === "string" && parsed.nonce.length <= 128 ? parsed.nonce : "";
      } catch {
        throw new OidcValidationError("TOKEN_MALFORMED");
      }
    };
    const claimNonce = readNonce();
    // Full validation first (signature, issuer, audience, tenant, times), so a forged token is reported as such.
    const verified = verifyIdToken(idToken, key, { ...config, nonce: claimNonce || "\u0000", nowSeconds });
    // Then the nonce must be the one this request stored. This check never depends on the token's own value.
    if (!claimNonce || hash(claimNonce) !== nonceHash) throw new OidcValidationError("TOKEN_NONCE_MISMATCH");
    return verified;
  }

  async function exchangeAndVerify(row: SsoConfigurationRow, req: SsoAuthRequestRow, code: string): Promise<VerifiedEntraClaims> {
    if (!isOidcComplete(row) || req.protocol !== "oidc" || !req.verifierEnc || !req.nonceHash) throw new OidcValidationError("REQUEST_INCOMPLETE");
    const verifier = deps.crypto.decrypt(req.verifierEnc, verifierAad(req.publicId));
    const idToken = await postToken(row, code, verifier);
    const key = await keyFor(row.tenantId, peekKeyId(idToken));
    return verifyIdTokenWithNonceHash(idToken, key, row, req.nonceHash, Math.floor(now().getTime() / 1000));
  }

  async function revokeEntraSessions(tx: Tx, userId: number, exceptSessionId?: string): Promise<number> {
    const conditions = [eq(userSessions.userId, userId), eq(userSessions.authMethod, "entra"), isNull(userSessions.revokedAt)];
    const rows = await tx.select({ publicId: userSessions.publicId }).from(userSessions).where(and(...conditions));
    let count = 0;
    for (const row of rows) {
      if (row.publicId === exceptSessionId) continue;
      await sessions.revoke(row.publicId, "sso_unlinked", { tx });
      count += 1;
    }
    return count;
  }

  /** Session binding for link / step-up / test: the live browser session must be the initiating session. */
  function requireSameSession(req: SsoAuthRequestRow, session: SessionPrincipal | null): SessionPrincipal {
    if (!session || session.sessionId !== req.sessionPublicId || session.userId !== req.userId) throw refusal("SSO_SESSION_CHANGED");
    return session;
  }

  async function findIdentity(tx: Tx, tid: string, oid: string, lock = false) {
    const query = tx.select().from(ssoIdentities)
      .where(and(eq(ssoIdentities.provider, "entra"), eq(ssoIdentities.tenantId, tid), eq(ssoIdentities.objectId, oid))).limit(1);
    const [row] = lock ? await query.for("update") : await query;
    return row ?? null;
  }

  async function completeSignIn(tx: Tx, req: SsoAuthRequestRow, result: StoredResult, config: SsoConfigurationRow, userAgent?: string): Promise<SsoCompletion> {
    if (!domainAllowed(config, result.email)) throw refusal("SSO_DOMAIN_NOT_ALLOWED", "DOMAIN_NOT_ALLOWED");
    let link = await findIdentity(tx, result.tid, result.oid);
    let provisioned = false;
    if (!link) {
      link = await provision(tx, result, config);
      provisioned = true;
    }
    // users before sso_identities; then re-read the link under lock and require it unchanged.
    const user = await repo.byId(link.userId, { tx, forUpdate: true });
    const lockedLink = await findIdentity(tx, result.tid, result.oid, true);
    if (!user || !lockedLink || lockedLink.userId !== user.id) throw refusal("SSO_NOT_LINKED", "LINK_CHANGED");
    link = lockedLink;
    if (user.status !== "active") throw refusal("SSO_ACCOUNT_INACTIVE", `ACCOUNT_${user.status.toUpperCase()}`.slice(0, 40));
    // Increment 07: only the roles the administrator allows may use SSO (also rolls back a just-provisioned user).
    if (!allowedRolesOf(config).includes(user.role)) throw refusal("SSO_ROLE_NOT_ALLOWED", "ROLE_NOT_ALLOWED");
    // Host recovery / forced change: Entra cannot skip the local remediation.
    if (user.mustChangePassword) throw refusal("SSO_LOCAL_SIGN_IN_REQUIRED", "LOCAL_REMEDIATION_PENDING");
    // Increment 04: customer maintenance (package E) — authoritative, after the users row lock. Also rolls
    // back a just-provisioned customer.
    if (user.role === "customer") {
      try {
        await i.gates.assertCustomerAccess(tx);
      } catch (error) {
        if (error instanceof DomainError && error.reasonCode === "CUSTOMER_MAINTENANCE") throw refusal("SSO_MAINTENANCE", "CUSTOMER_MAINTENANCE");
        throw error;
      }
    }
    const t = now();
    if (!link.verifiedAt) {
      await tx.update(ssoIdentities).set({ verifiedAt: t }).where(eq(ssoIdentities.id, link.id));
      await deps.audit.record(
        { category: "security", eventName: "identity.sso.binding_verified", action: "verify", outcome: "completed", actor: { userId: user.id, role: user.role }, resource: { type: "user", publicId: user.publicId }, provider: "entra" },
        tx,
      );
    }
    await tx.update(ssoIdentities).set({ lastSignInAt: t }).where(eq(ssoIdentities.id, link.id));
    const mfaVerified = entraMfaSatisfied(config, result);
    const mfaBasis = mfaVerified ? (mfaModeOf(config) === "entra" ? "entra_mode" : result.saml ? "saml_claim" : "amr") : "none";
    const created = await sessions.create(tx, user, { authMethod: "entra", userAgent, mfaVerifiedAt: mfaVerified ? t : null }).catch((error: unknown) => {
      if (error instanceof DomainError && error.reasonCode === "SESSION_RESTRICTED") {
        throw refusal("SSO_RESTRICTED", String(error.details?.restriction ?? "SESSION_RESTRICTED"));
      }
      throw error;
    });
    const steps = await transitions.derive(user, { mfaVerifiedAt: mfaVerified ? t : null, authMethod: "entra" }, tx);
    await deps.audit.record(
      {
        category: "security", eventName: "auth.login.succeeded", action: "login", outcome: "completed",
        actor: { userId: user.id, role: user.role }, resource: { type: "session", publicId: created.sessionId }, provider: "entra",
        attributes: {
          next_step: steps[0] ?? "none", auth_method: "entra", entra_mfa_trusted: mfaVerified, provisioned,
          protocol: result.saml ? "saml" : "oidc", mfa_mode: mfaModeOf(config), mfa_basis: mfaBasis,
        },
      },
      tx,
    );
    return { purpose: "sign_in", next: req.nextPath, nextStep: steps[0] ?? null, issued: created.issued, provisioned };
  }

  /**
   * The role a JIT account would get. Never admin. jitMode staff: a staff mapping (or the legacy single app role)
   * ⇒ staff, else a customer mapping ⇒ customer. jitMode customers: customer (when customer mappings exist, one
   * of them must match).
   */
  function jitRoleFor(config: SsoConfigurationRow, roles: readonly string[], mappings: Array<{ appRoleValue: string; role: SsoMappedRole }>): SsoMappedRole | null {
    const has = (r: SsoMappedRole) => mappings.some((m) => m.role === r && roles.includes(m.appRoleValue));
    const customerMappings = mappings.some((m) => m.role === "customer");
    if (config.jitMode === "staff") {
      if (has("staff") || (!!config.jitStaffAppRole && roles.includes(config.jitStaffAppRole))) return "staff";
      return has("customer") ? "customer" : null;
    }
    if (config.jitMode === "customers") return !customerMappings || has("customer") ? "customer" : null;
    return null;
  }

  /** Runs under the configuration lock taken by complete() (serializes the bounded daily count). */
  async function provision(tx: Tx, result: StoredResult, config: SsoConfigurationRow) {
    if (config.jitMode === "off") throw refusal("SSO_NOT_LINKED", "IDENTITY_NOT_LINKED");
    // No privilege from an e-mail address, and no silent linking to an existing account.
    if (!result.email) throw refusal("SSO_NOT_LINKED", "JIT_EMAIL_MISSING");
    if (await repo.byEmail(result.email, { tx })) throw refusal("SSO_ACCOUNT_EXISTS", "EMAIL_COLLISION_WITHOUT_LINK");
    const role = jitRoleFor(config, result.roles, await samlAdmin.roleMappings(tx));
    if (!role) throw refusal("SSO_ROLE_NOT_ASSIGNED", "JIT_APP_ROLE_MISSING");
    if (!allowedRolesOf(config).includes(role)) throw refusal("SSO_ROLE_NOT_ALLOWED", "JIT_ROLE_NOT_ALLOWED");
    const since = new Date(now().getTime() - 24 * 60 * 60_000);
    const [count] = await tx.select({ n: sql<number>`count(*)` }).from(ssoIdentities).where(and(eq(ssoIdentities.linkMethod, "jit"), gt(ssoIdentities.createdAt, since)));
    if (Number(count?.n ?? 0) >= config.jitDailyLimit) throw refusal("SSO_PROVISIONING_LIMIT", "JIT_DAILY_LIMIT");
    const name = (result.name?.trim() || result.email.split("@")[0]!).slice(0, 120);
    const created = await auth.insertUser(tx, { email: result.email, name, role, status: "active", origin: "sso_jit", passwordHash: null, emailVerifiedAt: null });
    await tx.update(users).set({ authSource: "entra" }).where(eq(users.id, created.id));
    const t = now();
    await tx.insert(ssoIdentities).values({ userId: created.id, provider: "entra", tenantId: result.tid, objectId: result.oid, linkMethod: "jit", linkedAt: t, verifiedAt: t });
    await deps.audit.record(
      { category: "security", eventName: "identity.sso.provisioned", action: "create", outcome: "completed", actor: { role: "system" }, resource: { type: "user", publicId: created.publicId }, provider: "entra", attributes: { role } },
      tx,
    );
    return (await findIdentity(tx, result.tid, result.oid))!;
  }

  async function completeLink(tx: Tx, req: SsoAuthRequestRow, result: StoredResult, config: SsoConfigurationRow, session: SessionPrincipal | null): Promise<SsoCompletion> {
    const principal = requireSameSession(req, session);
    const user = await repo.byId(principal.userId, { tx, forUpdate: true });
    let current;
    try {
      current = await sessions.assertCurrent(principal, tx);
    } catch {
      throw refusal("SSO_SESSION_CHANGED", "SESSION_NOT_CURRENT");
    }
    if (!user || current.pendingSteps.length > 0) throw refusal("SSO_SESSION_CHANGED", "SESSION_NOT_FULL");
    const age = current.stepUpAt ? now().getTime() - current.stepUpAt.getTime() : -1;
    if (!(age >= 0 && age <= STEP_UP_MAX_AGE_MS)) throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your identity again, then link your Microsoft account.");
    if (!domainAllowed(config, result.email)) throw refusal("SSO_DOMAIN_NOT_ALLOWED", "DOMAIN_NOT_ALLOWED");
    if (!allowedRolesOf(config).includes(user.role)) throw refusal("SSO_ROLE_NOT_ALLOWED", "ROLE_NOT_ALLOWED");
    const existing = await findIdentity(tx, result.tid, result.oid, true);
    if (existing && existing.userId !== user.id) throw refusal("SSO_IDENTITY_IN_USE", "IDENTITY_LINKED_ELSEWHERE");
    const [own] = await tx.select().from(ssoIdentities).where(and(eq(ssoIdentities.userId, user.id), eq(ssoIdentities.provider, "entra"))).limit(1).for("update");
    const t = now();
    if (own && (own.tenantId !== result.tid || own.objectId !== result.oid)) throw refusal("SSO_WRONG_ACCOUNT", "USER_ALREADY_LINKED");
    if (own) await tx.update(ssoIdentities).set({ verifiedAt: own.verifiedAt ?? t }).where(eq(ssoIdentities.id, own.id));
    else await tx.insert(ssoIdentities).values({ userId: user.id, provider: "entra", tenantId: result.tid, objectId: result.oid, linkMethod: "self", linkedByUserId: user.id, linkedAt: t, verifiedAt: t });
    await deps.audit.record(
      { category: "security", eventName: "identity.sso.linked", action: "create", outcome: "completed", actor: { userId: user.id, role: user.role }, resource: { type: "user", publicId: user.publicId }, provider: "entra", attributes: { by: "self", confirmed_binding: !!own } },
      tx,
    );
    return { purpose: "link", next: req.nextPath };
  }

  async function completeStepUp(tx: Tx, req: SsoAuthRequestRow, result: StoredResult, config: SsoConfigurationRow, session: SessionPrincipal | null): Promise<SsoCompletion> {
    const principal = requireSameSession(req, session);
    const link = await findIdentity(tx, result.tid, result.oid);
    if (!link || link.userId !== principal.userId || !link.verifiedAt) throw refusal("SSO_WRONG_ACCOUNT", "STEP_UP_IDENTITY_MISMATCH");
    if (result.authTime === null || !entraMfaSatisfied(config, result)) {
      throw refusal("SSO_MFA_REQUIRED", result.authTime === null ? "AUTH_TIME_MISSING" : "MFA_NOT_ASSERTED");
    }
    // The per-mode verdict is made here; assurance receives it as a proven "mfa" (it enforces no pre-request
    // skew, so the SAML instant — already checked against requestedAt − 2 min in acs() — is clamped).
    const requestedSec = Math.floor(req.requestedAt.getTime() / 1000);
    const authTime = result.saml ? Math.min(Math.max(result.authTime, requestedSec), Math.floor(now().getTime() / 1000)) : result.authTime;
    let issued: IssuedSession;
    try {
      issued = await deps.services.assurance.completeEntraStepUp(principal, { amr: ["mfa"], trustEntraMfa: true, authTime, requestedAt: req.requestedAt }, tx);
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.reasonCode === "AUTHENTICATION_PROOF_INVALID") throw refusal("SSO_MFA_REQUIRED", "STEP_UP_PROOF_REJECTED");
        if (error.reasonCode === "SESSION_NOT_CURRENT" || error.reasonCode === "ACCOUNT_STEP_CHANGED") throw refusal("SSO_SESSION_CHANGED", error.reasonCode);
      }
      throw error; // audit / infrastructure failures propagate unchanged
    }
    return { purpose: "step_up", next: req.nextPath, issued };
  }

  async function completeTest(tx: Tx, req: SsoAuthRequestRow, result: StoredResult, config: SsoConfigurationRow, session: SessionPrincipal | null): Promise<SsoCompletion> {
    const principal = requireSameSession(req, session);
    await i.authorizeInTx(tx, principal, "identity.sso.manage");
    const link = await findIdentity(tx, result.tid, result.oid);
    const linkedUser = link ? await repo.byId(link.userId, { tx }) : null;
    const jitRole = jitRoleFor(config, result.roles, await samlAdmin.roleMappings(tx));
    const proven = mfaProven(config, result);
    const mode = mfaModeOf(config);
    const test: SsoTestResult = {
      signatureVerified: true, tenantMatches: true, audienceMatches: true,
      mfaClaimPresent: proven,
      authTimePresent: result.authTime !== null,
      emailDomain: emailDomain(result.email),
      domainAllowed: domainAllowed(config, result.email),
      appRoles: result.roles.length,
      staffRoleAssigned: !!config.jitStaffAppRole && result.roles.includes(config.jitStaffAppRole),
      linkedToYou: link?.userId === principal.userId,
      linkedToAnotherAccount: !!link && link.userId !== principal.userId,
      protocol: result.saml ? "saml" : "oidc",
      claimNames: result.saml ? result.saml.claimNames.slice(0, 40) : [],
      mfaProven: proven,
      mfaSkippedByMode: mode === "entra" ? true : mode === "claim" ? proven : false,
      roleAllowed: linkedUser ? allowedRolesOf(config).includes(linkedUser.role) : jitRole !== null && allowedRolesOf(config).includes(jitRole),
      jitRole: link ? null : jitRole,
    };
    await deps.audit.record(
      {
        category: "admin", eventName: "identity.sso.tested", action: "test", outcome: "completed", resource: { type: "sso_configuration" }, provider: "entra",
        attributes: {
          mfa_claim_present: test.mfaClaimPresent, domain_allowed: test.domainAllowed, linked_to_you: test.linkedToYou,
          protocol: test.protocol, mfa_mode: mode, role_allowed: test.roleAllowed,
        },
      },
      tx,
    );
    return { purpose: "test", next: req.nextPath, test };
  }

  void toView;
  return service;
}

export type SsoService = ReturnType<typeof createSsoService>;

function isDuplicateKey(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(error) === "ER_DUP_ENTRY" || (typeof error === "object" && error !== null && "cause" in error && code((error as { cause?: unknown }).cause) === "ER_DUP_ENTRY");
}
