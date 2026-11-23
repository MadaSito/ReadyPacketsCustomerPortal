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
import {
  SSO_JIT_MODES,
  ssoAuthRequests,
  ssoConfiguration,
  ssoIdentities,
  users,
  userSessions,
  type SsoAuthRequestRow,
  type SsoConfigurationRow,
  type SsoJitMode,
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
};

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
  trustEntraMfa: boolean;
  jitMode: SsoJitMode;
  jitStaffAppRole: string | null;
  jitDailyLimit: number;
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
    await tx.insert(ssoConfiguration).values({ id: CONFIG_ID }).onDuplicateKeyUpdate({ set: { id: sql`${ssoConfiguration.id}` } });
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
  const isComplete = (row: SsoConfigurationRow | null): row is SsoConfigurationRow & { tenantId: string; clientId: string; clientSecretEnc: string } =>
    !!row && !!row.tenantId && isTenantGuid(row.tenantId) && !!row.clientId && isTenantGuid(row.clientId) && !!row.clientSecretEnc;
  const usable = (row: SsoConfigurationRow | null, purpose: SsoPurpose) =>
    availableInDeployment() && isComplete(row) && (purpose === "test" || row.enabled);
  const domainAllowed = (row: SsoConfigurationRow, email: string | null) => {
    const allowed = domainsOf(row);
    if (allowed.length === 0) return true;
    const domain = emailDomain(email);
    return domain !== null && allowed.includes(domain);
  };

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
  }

  async function adminView(tx?: Tx): Promise<SsoAdminView> {
    const row = await loadConfig(tx);
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
      trustEntraMfa: row?.trustEntraMfa === true,
      jitMode: row?.jitMode ?? "off",
      jitStaffAppRole: row?.jitStaffAppRole ?? null,
      jitDailyLimit: row?.jitDailyLimit ?? 25,
      redirectUri: redirectUri(),
      version: row?.version ?? 1,
      complete: isComplete(row),
      availableInThisDeployment: availableInDeployment(),
      linkedAccounts: Number(linked?.n ?? 0),
      breakGlass,
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

  async function newAuthorization(row: SsoConfigurationRow & { tenantId: string; clientId: string }, purpose: SsoPurpose, publicId: string) {
    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = randomToken(48); // 64 base64url chars (RFC 7636: 43–128)
    const url = authorizationUrl({
      tenantId: row.tenantId, clientId: row.clientId, redirectUri: redirectUri(), state, nonce, verifier,
      forceReauthentication: purpose === "step_up" || purpose === "link",
    });
    return { url, columns: { stateHash: hash(state), nonceHash: hash(nonce), verifierEnc: deps.crypto.encrypt(verifier, verifierAad(publicId)) } };
  }

  const service = {
    redirectUri,
    adminView,

    async publicConfig(): Promise<{ enabled: boolean; buttonLabel: string; providerName: string }> {
      const row = await loadConfig();
      return { enabled: usable(row, "sign_in"), buttonLabel: row?.buttonLabel ?? "Sign in with SSO", providerName: "Microsoft Entra ID" };
    },

    async updateConfig(principal: SessionPrincipal, input: SsoConfigInput): Promise<SsoAdminView> {
      validateConfigInput(input);
      return deps.db.transaction(async (tx) => {
        // Lock order: sso_configuration → users (see complete()).
        const row = await lockConfig(tx);
        await i.authorizeInTx(tx, principal, "identity.sso.manage");
        if (row.version !== input.expectedVersion) {
          throw conflict("STALE_VERSION", "Single sign-on settings were changed by someone else. Reload and try again.");
        }
        const tenantId = input.tenantId?.trim().toLowerCase() ?? null;
        const clientId = input.clientId?.trim().toLowerCase() ?? null;
        const secretChanged = input.clientSecret !== undefined;
        const bindingChanged = tenantId !== row.tenantId || clientId !== row.clientId || secretChanged;
        const disablesTrust = row.trustEntraMfa && !input.trustEntraMfa;
        const patch: Partial<SsoConfigurationRow> = {
          tenantId,
          clientId,
          buttonLabel: input.buttonLabel?.trim() || null,
          allowedDomains: JSON.stringify([...new Set(input.allowedDomains.map((d) => d.trim().toLowerCase()))]),
          trustEntraMfa: input.trustEntraMfa,
          jitMode: input.jitMode,
          jitStaffAppRole: input.jitStaffAppRole,
          jitDailyLimit: input.jitDailyLimit,
          updatedByUserId: principal.userId,
          version: row.version + 1,
          ...(bindingChanged ? { epoch: row.epoch + 1 } : {}),
          ...(secretChanged
            ? input.clientSecret === null
              ? { clientSecretEnc: null, clientSecretLast4: null }
              : { clientSecretEnc: deps.crypto.encrypt(input.clientSecret!, SECRET_AAD), clientSecretLast4: input.clientSecret!.slice(-4) }
            : {}),
        };
        // A configuration without the essentials cannot stay enabled.
        const next = { ...row, ...patch } as SsoConfigurationRow;
        if (row.enabled && !isComplete(next)) patch.enabled = false;
        await tx.update(ssoConfiguration).set(patch).where(eq(ssoConfiguration.id, CONFIG_ID));
        let revoked = 0;
        // Pending grants die with the binding (epoch); Entra-trusted MFA sessions die when trust is withdrawn
        // or the tenant / application changes.
        if (bindingChanged || disablesTrust) {
          const [result] = (await tx
            .update(userSessions)
            .set({ revokedAt: now(), revokeReason: "sso_config_changed" })
            .where(and(eq(userSessions.authMethod, "entra"), isNull(userSessions.revokedAt)))) as unknown as [{ affectedRows?: number }];
          revoked = result?.affectedRows ?? 0;
        }
        await deps.audit.record(
          {
            category: "admin", eventName: "identity.sso.config_updated", action: "update", outcome: "completed",
            resource: { type: "sso_configuration" }, provider: "entra",
            safeCounts: { allowed_domains: input.allowedDomains.length, entra_sessions_revoked: revoked },
            attributes: {
              binding_changed: bindingChanged, secret_changed: secretChanged, trust_entra_mfa: input.trustEntraMfa,
              jit_mode: input.jitMode, auto_disabled: patch.enabled === false,
            },
          },
          tx,
        );
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
          if (!isComplete(row)) throw validation("SSO_CONFIG_INCOMPLETE", "Enter the tenant ID, client ID and client secret before enabling single sign-on.");
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
      const authz = await newAuthorization(row as SsoConfigurationRow & { tenantId: string; clientId: string }, "sign_in", publicId);
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
      const authz = await newAuthorization(row as SsoConfigurationRow & { tenantId: string; clientId: string }, req.purpose, req.publicId);
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
          gt(ssoAuthRequests.expiresAt, t),
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
        if (req.purpose === "sign_in") {
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
          if (!usable(config, req.purpose) || config.epoch !== req.configEpoch || config.tenantId !== result.tid) throw refusal("SSO_EXPIRED", "CONFIG_CHANGED");
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
            const refusedKinds = ["SSO_MAINTENANCE", "SSO_RESTRICTED", "SSO_DOMAIN_NOT_ALLOWED", "SSO_ACCOUNT_INACTIVE", "SSO_PROVISIONING_LIMIT", "SSO_ROLE_NOT_ASSIGNED"];
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
        available: usable(config, "link"),
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
    if (!isComplete(row) || !req.verifierEnc || !req.nonceHash) throw new OidcValidationError("REQUEST_INCOMPLETE");
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
    const { mfaVerified } = deps.services.assurance.assessEntraSignIn(result.amr ?? undefined, config.trustEntraMfa);
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
        attributes: { next_step: steps[0] ?? "none", auth_method: "entra", entra_mfa_trusted: mfaVerified, provisioned },
      },
      tx,
    );
    return { purpose: "sign_in", next: req.nextPath, nextStep: steps[0] ?? null, issued: created.issued, provisioned };
  }

  /** Runs under the configuration lock taken by complete() (serializes the bounded daily count). */
  async function provision(tx: Tx, result: StoredResult, config: SsoConfigurationRow) {
    if (config.jitMode === "off") throw refusal("SSO_NOT_LINKED", "IDENTITY_NOT_LINKED");
    // No privilege from an e-mail address, and no silent linking to an existing account.
    if (!result.email) throw refusal("SSO_NOT_LINKED", "JIT_EMAIL_MISSING");
    if (await repo.byEmail(result.email, { tx })) throw refusal("SSO_ACCOUNT_EXISTS", "EMAIL_COLLISION_WITHOUT_LINK");
    let role: "customer" | "staff";
    if (config.jitMode === "staff") {
      if (!config.jitStaffAppRole || !result.roles.includes(config.jitStaffAppRole)) throw refusal("SSO_ROLE_NOT_ASSIGNED", "JIT_APP_ROLE_MISSING");
      role = "staff";
    } else {
      role = "customer";
    }
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
    if (result.authTime === null || !deps.services.assurance.assessEntraSignIn(result.amr ?? undefined, config.trustEntraMfa).mfaVerified) {
      throw refusal("SSO_MFA_REQUIRED", result.authTime === null ? "AUTH_TIME_MISSING" : "MFA_NOT_ASSERTED");
    }
    let issued: IssuedSession;
    try {
      issued = await deps.services.assurance.completeEntraStepUp(principal, { amr: result.amr ?? undefined, trustEntraMfa: config.trustEntraMfa, authTime: result.authTime, requestedAt: req.requestedAt }, tx);
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
    const test: SsoTestResult = {
      signatureVerified: true, tenantMatches: true, audienceMatches: true,
      mfaClaimPresent: result.amr?.includes("mfa") === true,
      authTimePresent: result.authTime !== null,
      emailDomain: emailDomain(result.email),
      domainAllowed: domainAllowed(config, result.email),
      appRoles: result.roles.length,
      staffRoleAssigned: !!config.jitStaffAppRole && result.roles.includes(config.jitStaffAppRole),
      linkedToYou: link?.userId === principal.userId,
      linkedToAnotherAccount: !!link && link.userId !== principal.userId,
    };
    await deps.audit.record(
      {
        category: "admin", eventName: "identity.sso.tested", action: "test", outcome: "completed", resource: { type: "sso_configuration" }, provider: "entra",
        attributes: { mfa_claim_present: test.mfaClaimPresent, domain_allowed: test.domainAllowed, linked_to_you: test.linkedToYou },
      },
      tx,
    );
    return { purpose: "test", next: req.nextPath, test };
  }

  void toView;
  return service;
}

export type SsoService = ReturnType<typeof createSsoService>;
