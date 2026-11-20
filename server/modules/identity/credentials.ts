/**
 * Password primitives exposed to other modules (assurance credential administration, step-up).
 * No route ever returns an existing password; temporary passwords are generated here and shown once by the caller.
 */
import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { DomainError, notFound } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import { assertPasswordAcceptable, type AuthInternals } from "./auth.js";
import { checkPassword } from "./password/policy.js";
import { users } from "./schema.js";
import { toView } from "./users.js";

const TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateTemporaryPassword(): string {
  for (;;) {
    let out = "";
    for (let i = 0; i < 20; i += 1) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]!;
    // 20 chars × log2(56) ≈ 116 bits; re-roll in the (vanishingly unlikely) case policy rejects it.
    if (checkPassword(out) === null) return out;
  }
}

export function createCredentialService(i: AuthInternals) {
  const { deps, hasher, repo, tokens, sessions } = i;
  const inTx = <T>(tx: Tx | undefined, fn: (t: Tx) => Promise<T>) => (tx ? fn(tx) : deps.db.transaction(fn));

  return {
    generateTemporaryPassword,

    /** Verifies the user's current password (uniform timing) and transparently upgrades the hash. */
    async verifyPassword(userId: number, password: string, opts: { tx?: Tx } = {}): Promise<boolean> {
      const user = await repo.byId(userId, opts.tx ? { tx: opts.tx } : {});
      const ok = await hasher.verify(user?.passwordHash ?? null, password);
      if (!ok || !user || user.status !== "active") return false;
      if (user.passwordHash && hasher.needsRehash(user.passwordHash)) {
        await (opts.tx ?? deps.db).update(users).set({ passwordHash: await hasher.hash(password) }).where(eq(users.id, user.id));
      }
      return true;
    },

    /** Sets a password after the shared policy check; retires outstanding reset/set-password links. */
    async setPassword(
      userId: number,
      password: string,
      opts: { mustChange: boolean; tx?: Tx; revokeSessions?: { exceptSessionId?: string; reason: string } },
    ): Promise<void> {
      const passwordHash = await hasher.hash(password);
      await inTx(opts.tx, async (tx) => {
        const user = await repo.byId(userId, { tx, forUpdate: true });
        if (!user) throw notFound("USER_NOT_FOUND");
        if (user.authSource !== "local") throw new DomainError("CONFLICT", "NOT_LOCAL_ACCOUNT", "This account does not use a local password.");
        const view = toView(deps.crypto, user);
        assertPasswordAcceptable(password, { email: view.email, name: view.name });
        await tx
          .update(users)
          .set({ passwordHash, passwordChangedAt: deps.clock.now(), mustChangePassword: opts.mustChange, version: user.version + 1 })
          .where(eq(users.id, user.id));
        if (opts.revokeSessions) await sessions.revokeAllForUser(user.id, { ...opts.revokeSessions, tx });
        await tokens.retireAll(tx, user.id, ["password_reset", "admin_set_password"], "password_set");
        await deps.audit.record(
          {
            category: "security",
            eventName: "auth.password.set",
            action: "update",
            outcome: "completed",
            resource: { type: "user", publicId: user.publicId },
            attributes: { must_change: opts.mustChange },
          },
          tx,
        );
      });
    },

    /** Admin e-mail mode: old password unusable, must_change set, single-use link mailed in tx. */
    async issueAdminSetPasswordLink(userId: number, opts: { tx: Tx }): Promise<{ previewLink?: string }> {
      const tx = opts.tx;
      const user = await repo.byId(userId, { tx, forUpdate: true });
      if (!user) throw notFound("USER_NOT_FOUND");
      if (user.authSource !== "local") throw new DomainError("CONFLICT", "NOT_LOCAL_ACCOUNT", "This account does not use a local password.");
      if (user.status !== "active") throw new DomainError("CONFLICT", "ACCOUNT_NOT_ACTIVE", "Only active accounts can receive a password link.");
      await tx.update(users).set({ passwordHash: null, mustChangePassword: true, version: user.version + 1 }).where(eq(users.id, user.id));
      await tokens.retireAll(tx, user.id, ["password_reset"], "superseded");
      const link = await tokens.issue(tx, user.id, "admin_set_password");
      await deps.mailer.enqueue(
        { template: "auth.admin_set_password", to: { userId: user.id }, vars: { link: link.url }, idempotencyKey: `auth.admin_set_password:${link.token.slice(0, 16)}`, expiresAt: link.expiresAt },
        tx,
      );
      await deps.audit.record(
        {
          category: "security",
          eventName: "auth.password.set_link_issued",
          action: "reset",
          outcome: "completed",
          resource: { type: "user", publicId: user.publicId },
        },
        tx,
      );
      return deps.config.deploymentProfile === "preview" ? { previewLink: link.path } : {};
    },
  };
}
export type CredentialService = ReturnType<typeof createCredentialService>;
