/**
 * Test-only helpers for the orders module (synthetic data; never imported by production code).
 */
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { users } from "../identity/schema.js";
import * as orderTables from "./schema.js";
import type { Db, SessionPrincipal, Tx } from "../../core/types.js";
import type { TestHarness } from "../../../tests/helpers/fakes.js";
import { fakePrincipal } from "../../../tests/helpers/fakes.js";
import type { OrdersUserView } from "./ports.js";
import type { UserRole } from "../../../shared/domain.js";

export const ordersTestSchema = { users, ...orderTables };

let seq = 0;

export interface TestUser {
  id: number;
  publicId: string;
  email: string;
  principal: SessionPrincipal;
}

export async function insertUser(
  h: TestHarness,
  db: Db,
  options: { role?: UserRole; status?: "active" | "pending_activation" | "suspended" | "deactivated"; verified?: boolean; stepUp?: boolean } = {},
): Promise<TestUser> {
  seq += 1;
  const publicId = `01JDTEST${String(Date.now() % 1e8).padStart(8, "0")}${String(seq).padStart(10, "0")}`.slice(0, 26);
  const email = `user${seq}.${Math.random().toString(36).slice(2, 8)}@example.test`;
  await db.insert(users).values({
    publicId,
    role: options.role ?? "customer",
    status: options.status ?? "active",
    emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
    emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
    emailVerifiedAt: options.verified === false ? null : h.clock.now(),
    nameEnc: h.deps.crypto.encrypt(`Synthetic User ${seq}`, `users.name:${publicId}`),
  });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.publicId, publicId));
  const principal = fakePrincipal({
    userId: row!.id,
    userPublicId: publicId,
    role: options.role ?? "customer",
    stepUpAt: options.stepUp ? h.clock.now() : null,
  });
  return { id: row!.id, publicId, email, principal };
}

/** Minimal identity fake backed by the real `users` table (decrypts like identity will). */
export function fakeIdentity(h: TestHarness, db: Db) {
  const view = (row: typeof users.$inferSelect): OrdersUserView & { emailVerified: boolean } => ({
    id: row.id,
    publicId: row.publicId,
    role: row.role,
    status: row.status,
    email: h.deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`),
    name: h.deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`),
    customerRef: row.customerRef,
    emailVerified: row.emailVerifiedAt !== null,
  });
  /** Per-session overrides of the PERSISTED session state (default: live, no pending steps, principal's step-up). */
  const sessionState = new Map<string, { revoked?: boolean; pendingSteps?: string[]; stepUpAt?: Date | null; role?: UserRole }>();
  const lockQuery = <T extends { for(mode: "update"): unknown }>(query: T, forUpdate?: boolean) => (forUpdate ? query.for("update") : query);
  return {
    sessionState,
    async getUser(userId: number, opts?: { tx?: Db | Tx; forUpdate?: boolean }) {
      const [row] = (await lockQuery((opts?.tx ?? db).select().from(users).where(eq(users.id, userId)).limit(1), opts?.forUpdate)) as (typeof users.$inferSelect)[];
      return row ? view(row) : null;
    },
    async getUserByPublicId(publicId: string, opts?: { tx?: Db | Tx; forUpdate?: boolean }) {
      const [row] = (await lockQuery((opts?.tx ?? db).select().from(users).where(eq(users.publicId, publicId)).limit(1), opts?.forUpdate)) as (typeof users.$inferSelect)[];
      return row ? view(row) : null;
    },
    /** Mirrors identity.sessions.assertCurrent: locks the users row, rejects stale sessions, returns PERSISTED authority. */
    sessions: {
      async assertCurrent(principal: SessionPrincipal, tx: Tx) {
        const [row] = await tx.select().from(users).where(eq(users.id, principal.userId)).limit(1).for("update");
        const state = sessionState.get(principal.sessionId) ?? {};
        if (!row || row.status !== "active" || state.revoked || row.role !== principal.role)
          throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Please sign in again.");
        return {
          pendingSteps: state.pendingSteps ?? [],
          role: state.role ?? row.role,
          stepUpAt: state.stepUpAt !== undefined ? state.stepUpAt : principal.stepUpAt,
          mfaVerifiedAt: null,
        };
      },
    },
  };
}

export class FakeFiles {
  calls: { orderId: number; ownerUserId: number }[] = [];
  fail = false;
  async reassignOrderFiles(orderId: number, ownerUserId: number, _tx: Tx): Promise<void> {
    if (this.fail) throw new Error("files unavailable");
    this.calls.push({ orderId, ownerUserId });
  }
}

export class FakeEngagement {
  notifications: { userId: number; kind: string; link?: string }[] = [];
  async notify(input: { userId: number; kind: string; title: string; body: string; link?: string }) {
    this.notifications.push({ userId: input.userId, kind: input.kind, link: input.link });
  }
}

export function idemKey(): string {
  seq += 1;
  return `idem_${Date.now()}_${seq}_abcdefgh`;
}
