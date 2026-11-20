/**
 * User repository + decrypted server-side view. Internal to the identity module.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, FieldCrypto, Tx } from "../../core/types.js";
import { conflict } from "../../core/errors.js";
import { randomBytes } from "node:crypto";
import type { AuthMethod, UserRole } from "../../../shared/domain.js";
import { namePrefixes, normalizeEmail } from "./normalize.js";
import { customerRefReservations, users, type UserRow, type UserStatus } from "./schema.js";

export interface UserView {
  id: number;
  publicId: string;
  role: UserRole;
  status: UserStatus;
  email: string;
  name: string;
  customerRef: string | null;
  emailVerified: boolean;
  authSource: AuthMethod;
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: Date;
  version: number;
}

export const emailAad = (publicId: string) => `users.email:${publicId}`;
export const nameAad = (publicId: string) => `users.name:${publicId}`;

export function emailIndexOf(crypto: FieldCrypto, email: string): string {
  return crypto.blindIndex(normalizeEmail(email), "users.email");
}

export function namePrefixIndex(crypto: FieldCrypto, prefix: string): string {
  return crypto.blindIndex(prefix, "users.name_prefix");
}

/** Encrypted name columns + search indexes for a (publicId, name). */
export function nameColumns(crypto: FieldCrypto, publicId: string, name: string) {
  const prefixes = namePrefixes(name);
  return {
    nameEnc: crypto.encrypt(name, nameAad(publicId)),
    nameFirstPrefixIndex: prefixes.first ? namePrefixIndex(crypto, prefixes.first) : null,
    nameLastPrefixIndex: prefixes.last ? namePrefixIndex(crypto, prefixes.last) : null,
  };
}

export function emailColumns(crypto: FieldCrypto, publicId: string, email: string) {
  const normalized = normalizeEmail(email);
  return { emailEnc: crypto.encrypt(normalized, emailAad(publicId)), emailIndex: emailIndexOf(crypto, normalized) };
}

export function toView(crypto: FieldCrypto, row: UserRow): UserView {
  return {
    id: row.id,
    publicId: row.publicId,
    role: row.role,
    status: row.status,
    email: crypto.decrypt(row.emailEnc, emailAad(row.publicId)),
    name: crypto.decrypt(row.nameEnc, nameAad(row.publicId)),
    customerRef: row.customerRef ?? null,
    emailVerified: row.emailVerifiedAt !== null,
    authSource: row.authSource,
    mustChangePassword: row.mustChangePassword,
    hasPassword: row.passwordHash !== null,
    createdAt: row.createdAt,
    version: row.version,
  };
}

export interface LoadOptions {
  tx?: DbOrTx;
  forUpdate?: boolean;
}

export function createUserRepo(deps: ModuleDeps) {
  const db = (tx?: DbOrTx) => tx ?? deps.db;
  async function one(where: ReturnType<typeof eq>, options: LoadOptions = {}): Promise<UserRow | null> {
    if (options.forUpdate && !options.tx) throw new Error("forUpdate requires a transaction");
    const query = db(options.tx).select().from(users).where(where).limit(1);
    const rows = options.forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }
  return {
    byId: (id: number, options?: LoadOptions) => one(eq(users.id, id), options),
    byPublicId: (publicId: string, options?: LoadOptions) => one(eq(users.publicId, publicId), options),
    byEmail: (email: string, options?: LoadOptions) => one(eq(users.emailIndex, emailIndexOf(deps.crypto, email)), options),

    async countActiveAdmins(tx: Tx, excludeUserId?: number): Promise<number> {
      const rows = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active")))
        .for("update");
      return rows.filter((row) => row.id !== excludeUserId).length;
    },

    async hasActiveAdministrator(): Promise<boolean> {
      const [row] = await deps.db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active")));
      return (row?.n ?? 0) > 0;
    },

    /** True when the reference is neither current nor retired anywhere. */
    async isCustomerRefAvailable(reference: string, tx?: DbOrTx): Promise<boolean> {
      const [reserved] = await db(tx)
        .select({ id: customerRefReservations.id })
        .from(customerRefReservations)
        .where(eq(customerRefReservations.reference, reference))
        .limit(1);
      if (reserved) return false;
      const [current] = await db(tx).select({ id: users.id }).from(users).where(eq(users.customerRef, reference)).limit(1);
      return !current;
    },

    /** Claims a reference for a user (permanent reservation row). Throws CONFLICT REFERENCE_IN_USE. */
    async reserveRef(tx: Tx, reference: string, userId: number): Promise<void> {
      try {
        await tx.insert(customerRefReservations).values({ reference, userId });
      } catch (error) {
        if (isDuplicate(error)) throw conflict("REFERENCE_IN_USE", "That customer reference is already in use or reserved.");
        throw error;
      }
    },

    async retireRef(tx: Tx, reference: string, now: Date): Promise<void> {
      await tx
        .update(customerRefReservations)
        .set({ retiredAt: now })
        .where(and(eq(customerRefReservations.reference, reference), isNull(customerRefReservations.retiredAt)));
    },
  };
}
export type UserRepo = ReturnType<typeof createUserRepo>;

const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Generated customer references: `RP-` + 7 Crockford characters (≈34 bits). */
export function generateCustomerRef(): string {
  const bytes = randomBytes(7);
  let out = "RP-";
  for (const byte of bytes) out += REF_ALPHABET[byte % 32]!;
  return out;
}

export function isDuplicate(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown; errno?: unknown }).code;
    if (code === "ER_DUP_ENTRY" || (current as { errno?: unknown }).errno === 1062) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
