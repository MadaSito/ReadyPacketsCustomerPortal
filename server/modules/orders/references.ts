/**
 * Human-facing order references. Every value ever assigned is kept in `order_references` (unique index), so a
 * retired reference is reserved forever and can never be assigned to another order.
 */
import { eq, sql } from "drizzle-orm";
import { conflict, validation } from "../../core/errors.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { orderReferenceCounters, orderReferences } from "./schema.js";

export const REFERENCE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export function normalizeReference(raw: string): string {
  const value = raw.normalize("NFC").trim().toUpperCase();
  if (!REFERENCE_PATTERN.test(value) || value.includes("--") || value.endsWith("-"))
    throw validation("INVALID_REFERENCE", "Use 3–32 letters, digits and single hyphens.");
  return value;
}

export async function isReferenceReserved(db: DbOrTx, reference: string): Promise<boolean> {
  const rows = await db.select({ id: orderReferences.id }).from(orderReferences).where(eq(orderReferences.reference, reference)).limit(1);
  return rows.length > 0;
}

/** Allocates the next `PREFIX-YYYY-NNNNNN` reference inside the caller's transaction (row-locked counter). */
export async function allocateReference(tx: Tx, prefix: string, now: Date): Promise<string> {
  const scope = `${prefix}-${now.getUTCFullYear()}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await tx
      .insert(orderReferenceCounters)
      .values({ scope, nextValue: 1 })
      .onDuplicateKeyUpdate({ set: { nextValue: sql`${orderReferenceCounters.nextValue} + 1` } });
    const [counter] = await tx
      .select({ nextValue: orderReferenceCounters.nextValue })
      .from(orderReferenceCounters)
      .where(eq(orderReferenceCounters.scope, scope))
      .for("update");
    const candidate = `${scope}-${String(counter!.nextValue).padStart(6, "0")}`;
    // An administrator may have assigned a value in this shape manually; never reuse it.
    if (!(await isReferenceReserved(tx, candidate))) return candidate;
  }
  throw conflict("REFERENCE_ALLOCATION_FAILED", "A reference could not be allocated. Please try again.");
}

export async function reserveReference(
  tx: Tx,
  input: { reference: string; orderId: number; reasonCode: string; actorUserId: number | null; now: Date },
): Promise<void> {
  if (await isReferenceReserved(tx, input.reference))
    throw conflict("REFERENCE_RESERVED", "That reference is already in use or has been used before.");
  await tx.insert(orderReferences).values({
    reference: input.reference,
    orderId: input.orderId,
    status: "active",
    reasonCode: input.reasonCode,
    actorUserId: input.actorUserId,
    assignedAt: input.now,
  });
}
