import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { Services } from "../../../container.js";
import { conflict, validation } from "../../../core/errors.js";
import { ulid } from "../../../core/ids.js";
import type { AuditOutcome, SessionPrincipal, Tx } from "../../../core/types.js";
import { authorizationUrl, exchangeCode, revokeGrant, type OAuthApp, type StorageOAuthProvider, type StorageRequest } from "./provider.js";
import { storageOAuthAttempts as attempts } from "./schema.js";

export const OAUTH_TTL_MS = 5 * 60_000;
export const OAUTH_PARK_TTL_MS = 2 * 60_000;
const EXCHANGE_TTL_MS = 60_000;
export const opaqueSecret = /^[A-Za-z0-9_-]{43}$/;
export type OAuthTarget = { provider: StorageOAuthProvider; publicId: string; expectedVersion: number };
type Attempt = typeof attempts.$inferSelect;
type Material = {
  userId: number;
  sessionId: string;
  sessionBinding: string;
  verifier: string;
};
type Parked = { initiationEnc: string; code: string };
type AuditActor = Pick<SessionPrincipal, "userId" | "role">;

function aad(id: string): string { return `storage_oauth_attempts.payload:${id}`; }
function randomSecret(): string { return randomBytes(32).toString("base64url"); }
function sameHex(a: string | null, b: string): boolean {
  return typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
}

export function storageRedirectUri(services: Pick<Services, "config">, provider: StorageOAuthProvider): string {
  const origin = new URL(services.config.canonicalOrigin);
  if (origin.protocol !== "https:" || services.config.deploymentProfile === "preview") {
    throw validation("STORAGE_OAUTH_HTTPS_REQUIRED", "Storage consent requires the canonical HTTPS portal.");
  }
  return new URL(`/api/storage/oauth/callback/${provider}`, origin).href;
}

function readApp(setup: { config: Record<string, unknown>; credentials: Record<string, string> | null }): OAuthApp {
  const clientId = setup.config.clientId;
  const secret = setup.credentials?.clientSecret;
  if (typeof clientId !== "string" || !clientId || !secret) {
    throw validation("STORAGE_OAUTH_APP_REQUIRED", "Save the storage app client ID and secret before connecting.");
  }
  return { clientId, clientSecret: secret };
}

function audit(services: Services, target: OAuthTarget, action: "connect" | "disconnect" | "revoke", outcome: AuditOutcome,
  actor: AuditActor, attemptId: string, tx?: Tx, reasonCode?: string): Promise<void> {
  return services.audit.record({
    category: "integration", eventName: `storage.oauth.${action}`, action, outcome, reasonCode, provider: target.provider,
    actor: { userId: actor.userId, role: actor.role }, resource: { type: "storage_connection", publicId: target.publicId },
    correlationId: attemptId,
  }, tx);
}

export function storageOAuthService(services: Services, requestFor: (provider: StorageOAuthProvider) => StorageRequest) {
  const registry = services.storageConnections;
  const readSetup = (principal: SessionPrincipal, input: OAuthTarget, tx: Tx) => registry.readProviderSetup(principal, {
    publicId: input.publicId, kind: input.provider, expectedVersion: input.expectedVersion,
  }, tx);
  const owned = (id: string, attemptId: string) => and(eq(attempts.connectionPublicId, id), eq(attempts.attemptId, attemptId));
  async function createMarker(tx: Tx, record: typeof attempts.$inferInsert): Promise<void> {
    const [prior] = await tx.select().from(attempts).where(eq(attempts.connectionPublicId, record.connectionPublicId)).limit(1).for("update");
    if (prior && prior.expiresAt > services.clock.now()) {
      throw conflict("STORAGE_OAUTH_ALREADY_IN_PROGRESS", "Finish the existing storage consent flow or wait for it to expire.");
    }
    if (prior) await tx.delete(attempts).where(owned(prior.connectionPublicId, prior.attemptId));
    await tx.insert(attempts).values(record);
  }
  const seal = (value: Material, id: string) => services.crypto.encrypt(JSON.stringify(value), aad(id));
  const open = (value: string, id: string) => JSON.parse(services.crypto.decrypt(value, aad(id))) as Material;
  const bindSession = (principal: SessionPrincipal) =>
    services.crypto.blindIndex(principal.csrfSecret, "storage-oauth-session");
  async function assertMarker(tx: Tx, row: Attempt): Promise<void> {
    const [current] = await tx.select().from(attempts).where(owned(row.connectionPublicId, row.attemptId)).limit(1).for("update");
    if (!current || current.phase !== "exchanging" || current.expiresAt <= services.clock.now()) throw callbackDenied();
  }
  const callbackDenied = () => validation("STORAGE_OAUTH_CALLBACK_REJECTED", "The storage consent request expired or did not match. Try connecting again.");
  async function park(provider: StorageOAuthProvider, { state, binder, code }: {
    state: string; binder: string; code?: string;
  }): Promise<string> {
    if (!opaqueSecret.test(state) || !opaqueSecret.test(binder)) throw callbackDenied();
    const redirectUri = storageRedirectUri(services, provider);
    const stateHash = services.crypto.hashToken(state);
    const binderHash = services.crypto.hashToken(binder);
    const handle = randomSecret();
    const accepted = await services.db.transaction(async (tx) => {
      const [row] = await tx.select().from(attempts).where(eq(attempts.stateHash, stateHash)).limit(1).for("update");
      if (!row || row.provider !== provider || row.redirectUri !== redirectUri || row.phase !== "pending" ||
          row.expiresAt <= services.clock.now() || !row.payloadEnc || !sameHex(row.binderHash, binderHash)) throw callbackDenied();
      if (!code) {
        const material = open(row.payloadEnc, row.attemptId);
        await audit(services, { provider, publicId: row.connectionPublicId, expectedVersion: row.expectedVersion },
          "connect", "refused", { userId: material.userId, role: "admin" }, row.attemptId, tx, "STORAGE_OAUTH_CONSENT_NOT_GRANTED");
        await tx.delete(attempts).where(owned(row.connectionPublicId, row.attemptId));
        return false;
      }
      const payload: Parked = { initiationEnc: row.payloadEnc, code };
      await tx.update(attempts).set({
        phase: "parked", stateHash: services.crypto.hashToken(handle), binderHash: null,
        payloadEnc: services.crypto.encrypt(JSON.stringify(payload), `${aad(row.attemptId)}:parked`),
        expiresAt: new Date(services.clock.now().getTime() + OAUTH_PARK_TTL_MS),
      }).where(owned(row.connectionPublicId, row.attemptId));
      return true;
    });
    if (!accepted) throw callbackDenied();
    return handle;
  }

  async function claimParked(handle: string): Promise<Attempt> {
    if (!opaqueSecret.test(handle)) throw callbackDenied();
    const handleHash = services.crypto.hashToken(handle);
    // Commit the one-time claim before any live identity check or provider work. Missing/mismatched sessions
    // burn a presented handle, and a failed or ambiguous exchange cannot repeat the provider effect.
    return services.db.transaction(async (tx) => {
      const [row] = await tx.select().from(attempts).where(eq(attempts.stateHash, handleHash)).limit(1).for("update");
      if (!row || row.phase !== "parked" || row.expiresAt <= services.clock.now() || !row.payloadEnc) throw callbackDenied();
      await tx.update(attempts).set({
        phase: "exchanging", stateHash: null, binderHash: null, payloadEnc: null,
        expiresAt: new Date(services.clock.now().getTime() + EXCHANGE_TTL_MS),
      }).where(owned(row.connectionPublicId, row.attemptId));
      return row;
    });
  }

  return {
    async start(principal: SessionPrincipal, input: OAuthTarget): Promise<{ authorizeUrl: string; binder: string }> {
      const redirectUri = storageRedirectUri(services, input.provider);
      const state = randomSecret(), verifier = randomSecret(), binder = randomSecret(), attemptId = ulid();
      await services.db.delete(attempts).where(lte(attempts.expiresAt, services.clock.now())).limit(100);
      const clientId = await services.db.transaction(async (tx) => {
        const setup = await readSetup(principal, input, tx);
        const app = readApp(setup);
        if (setup.credentials?.refreshToken) throw conflict("STORAGE_OAUTH_CONNECTED", "Disconnect this account before connecting another.");
        await createMarker(tx, {
          connectionPublicId: input.publicId, expectedVersion: input.expectedVersion, provider: input.provider, attemptId, redirectUri,
          expiresAt: new Date(services.clock.now().getTime() + OAUTH_TTL_MS), phase: "pending",
          stateHash: services.crypto.hashToken(state), binderHash: services.crypto.hashToken(binder),
          payloadEnc: seal({ userId: principal.userId, sessionId: principal.sessionId, sessionBinding: bindSession(principal), verifier }, attemptId),
        });
        await audit(services, input, "connect", "attempted", principal, attemptId, tx);
        return app.clientId;
      });
      return { authorizeUrl: authorizationUrl(input.provider, redirectUri, clientId, state, verifier), binder };
    },
    park,
    async finish(handle: string, currentSession: SessionPrincipal | null): Promise<void> {
      const row = await claimParked(handle);
      const provider = row.provider === "dropbox" || row.provider === "google_drive" ? row.provider : undefined;
      if (!provider) throw callbackDenied();
      const target: OAuthTarget = { provider, publicId: row.connectionPublicId, expectedVersion: row.expectedVersion };
      let initiator: AuditActor | undefined;
      let grantAcquired = false;
      try {
        const parked = JSON.parse(services.crypto.decrypt(row.payloadEnc!, `${aad(row.attemptId)}:parked`)) as Parked;
        const material = open(parked.initiationEnc, row.attemptId);
        initiator = { userId: material.userId, role: "admin" };
        if (!currentSession || currentSession.sessionId !== material.sessionId || currentSession.userId !== material.userId ||
            !sameHex(material.sessionBinding, bindSession(currentSession)) || storageRedirectUri(services, provider) !== row.redirectUri) {
          throw callbackDenied();
        }
        const actor = currentSession;
        const app = await services.db.transaction(async (tx) => {
          const setup = await readSetup(actor, target, tx);
          await assertMarker(tx, row);
          return readApp(setup);
        });
        const grant = await exchangeCode(requestFor(provider), provider, app, { code: parked.code, verifier: material.verifier, redirectUri: row.redirectUri });
        grantAcquired = true;
        await services.db.transaction(async (tx) => {
          await readSetup(actor, target, tx);
          await assertMarker(tx, row);
          await registry.connections.update(actor, {
            publicId: target.publicId, expectedVersion: target.expectedVersion, enabled: false,
            credentials: { clientSecret: app.clientSecret, refreshToken: grant.refreshToken },
          }, tx);
          await audit(services, target, "connect", "completed", actor, row.attemptId, tx);
          await tx.delete(attempts).where(owned(row.connectionPublicId, row.attemptId));
        });
      } catch {
        // Deliberately do not revoke here: an ambiguous COMMIT or an expired revision could otherwise
        // revoke a valid grant. Incomplete connections can be removed in the provider's console.
        if (initiator) await audit(services, target, "connect", grantAcquired ? "unknown" : "failed", initiator, row.attemptId, undefined,
          grantAcquired ? "STORAGE_OAUTH_GRANT_NOT_CONFIRMED" : "STORAGE_OAUTH_CALLBACK_REJECTED");
        throw callbackDenied();
      } finally {
        await services.db.delete(attempts).where(owned(row.connectionPublicId, row.attemptId));
      }
    },
    async disconnect(principal: SessionPrincipal, input: OAuthTarget): Promise<{ remoteRevoked: boolean }> {
      const attemptId = ulid();
      const redirectUri = storageRedirectUri(services, input.provider);
      const setup = await services.db.transaction(async (tx) => {
        const connection = await readSetup(principal, input, tx);
        const app = readApp(connection);
        const refreshToken = connection.credentials?.refreshToken;
        if (!refreshToken) throw conflict("STORAGE_OAUTH_NOT_CONNECTED", "This account is not connected.");
        await createMarker(tx, {
          connectionPublicId: input.publicId, expectedVersion: input.expectedVersion, provider: input.provider, attemptId,
          redirectUri, expiresAt: new Date(services.clock.now().getTime() + OAUTH_TTL_MS), phase: "revoking",
        });
        await registry.connections.update(principal, {
          publicId: input.publicId, expectedVersion: input.expectedVersion, enabled: false, credentials: { clientSecret: app.clientSecret },
        }, tx);
        await audit(services, input, "disconnect", "completed", principal, attemptId, tx);
        await audit(services, input, "revoke", "attempted", principal, attemptId, tx);
        return { app, refreshToken };
      });
      let remoteRevoked = false;
      try {
        await revokeGrant(requestFor(input.provider), input.provider, setup.app, setup.refreshToken);
        remoteRevoked = true;
      } catch {
        // No reuse of a detached credential. The UI can direct the operator to revoke at the provider.
      }
      await services.db.transaction(async (tx) => {
        await audit(services, input, "revoke", remoteRevoked ? "completed" : "unknown", principal, attemptId, tx,
          remoteRevoked ? undefined : "STORAGE_OAUTH_REVOKE_UNCONFIRMED");
        await tx.delete(attempts).where(owned(input.publicId, attemptId));
      });
      return { remoteRevoked };
    },
  };
}
