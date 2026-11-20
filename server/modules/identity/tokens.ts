/**
 * Single-use e-mail link tokens. 256-bit random, stored only as FieldCrypto.hashToken, newest-only per
 * (user, purpose), bounded TTL. Lock order: users row → token row (see API.md).
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { randomToken } from "../../core/ids.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { identityTokens, users, type IdentityTokenPurpose, type UserRow } from "./schema.js";
import { TOKEN_TTL_MS } from "./settings.js";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const LINK_PATHS: Record<IdentityTokenPurpose, string> = {
  verify_email: "/verify-email",
  password_reset: "/reset-password",
  admin_set_password: "/reset-password",
  invitation: "/activate",
};

export function createTokenService(deps: ModuleDeps) {
  return {
    /** Retires outstanding tokens of the purpose and issues a fresh one. Call inside the user's transaction. */
    async issue(
      tx: Tx,
      userId: number,
      purpose: IdentityTokenPurpose,
    ): Promise<{ token: string; tokenId: number; expiresAt: Date; path: string; url: string; mailKey: string }> {
      const now = deps.clock.now();
      await tx
        .update(identityTokens)
        .set({ consumedAt: now, retiredReason: "superseded" })
        .where(and(eq(identityTokens.userId, userId), eq(identityTokens.purpose, purpose), isNull(identityTokens.consumedAt)));
      const token = randomToken(32);
      const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS[purpose]);
      const [inserted] = await tx
        .insert(identityTokens)
        .values({ userId, purpose, tokenHash: deps.crypto.hashToken(token), expiresAt, createdAt: now })
        .$returningId();
      const path = `${LINK_PATHS[purpose]}?token=${token}`;
      const tokenId = inserted!.id;
      // Mail idempotency key derives from the token ROW id, never from the bearer secret.
      return { token, tokenId, expiresAt, path, url: `${deps.config.canonicalOrigin}${path}`, mailKey: `identity.token:${tokenId}` };
    },

    async retireAll(tx: Tx, userId: number, purposes: readonly IdentityTokenPurpose[], reason: string): Promise<void> {
      await tx
        .update(identityTokens)
        .set({ consumedAt: deps.clock.now(), retiredReason: reason })
        .where(and(eq(identityTokens.userId, userId), inArray(identityTokens.purpose, [...purposes]), isNull(identityTokens.consumedAt)));
    },

    async lastIssuedAt(db: DbOrTx, userId: number, purpose: IdentityTokenPurpose): Promise<Date | null> {
      const [row] = await db
        .select({ createdAt: identityTokens.createdAt })
        .from(identityTokens)
        .where(and(eq(identityTokens.userId, userId), eq(identityTokens.purpose, purpose)))
        .orderBy(desc(identityTokens.id))
        .limit(1);
      return row?.createdAt ?? null;
    },

    /**
     * Validates and consumes a token inside `tx`: users row is locked FIRST, then the token row; the
     * token must be unconsumed, unexpired and of an allowed purpose. Returns null for any invalid token.
     * If the caller's transaction later throws, the consumption rolls back (e.g. password-policy rejection).
     */
    async consume(
      tx: Tx,
      rawToken: string,
      purposes: readonly IdentityTokenPurpose[],
    ): Promise<{ user: UserRow; purpose: IdentityTokenPurpose } | null> {
      if (!TOKEN_SHAPE.test(rawToken)) return null;
      const tokenHash = deps.crypto.hashToken(rawToken);
      const [peek] = await tx.select({ userId: identityTokens.userId }).from(identityTokens).where(eq(identityTokens.tokenHash, tokenHash)).limit(1);
      if (!peek) return null;
      const [user] = await tx.select().from(users).where(eq(users.id, peek.userId)).limit(1).for("update");
      const [row] = await tx.select().from(identityTokens).where(eq(identityTokens.tokenHash, tokenHash)).limit(1).for("update");
      const now = deps.clock.now();
      if (!user || !row || row.consumedAt !== null || row.expiresAt.getTime() <= now.getTime() || !purposes.includes(row.purpose)) {
        return null;
      }
      await tx.update(identityTokens).set({ consumedAt: now, retiredReason: "consumed" }).where(eq(identityTokens.id, row.id));
      return { user, purpose: row.purpose };
    },
  };
}
export type TokenService = ReturnType<typeof createTokenService>;
