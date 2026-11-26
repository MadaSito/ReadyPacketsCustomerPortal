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

/**
 * Increment 08 (D2): folding for reference parts. NFKD, strip combining marks, upper-case, keep A–Z and 0–9 only.
 * Non-Latin letters, punctuation and emoji fold to nothing.
 */
export function foldReferencePart(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function head(raw: string | null | undefined, length: number): string {
  return foldReferencePart(raw).slice(0, length).padEnd(length, "X");
}

/** Last 4 letters/digits of the customer ID (`RPCUS-…`); none → `0000`; shorter → padded on the left with 0. */
function customerPart(customerRef: string | null | undefined): string {
  const folded = foldReferencePart(customerRef);
  return folded ? folded.slice(-4).padStart(4, "0") : "0000";
}

/**
 * Pure: `PREFIX-C4-F3L3-P6` (e.g. `RP-JJG5-ZEUGRE-ICEQUE`). The stem is frozen on the order at creation; later renames
 * never change a reference. With the 2–6 letter prefix the stem is at most 27 characters, leaving ≥ 5 for `-NNN`.
 */
export function buildReferenceStem(input: { prefix: string; customerRef: string | null; firstName: string; lastName: string; projectName: string }): string {
  const prefix = foldReferencePart(input.prefix) || "RP";
  return `${prefix}-${customerPart(input.customerRef)}-${head(input.firstName, 3)}${head(input.lastName, 3)}-${head(input.projectName, 6)}`;
}

/** Recognises a generated stem reference and returns its stem (null for any other shape, e.g. `RP-2026-000123`). */
export function stemOfReference(reference: string): string | null {
  const match = /^([A-Z0-9]{1,6}-[A-Z0-9]{4}-[A-Z0-9]{6}-[A-Z0-9]{6})-\d{3,}$/.exec(reference);
  return match ? match[1]! : null;
}

/**
 * Increment 08 (D2): allocates `STEM-NNN` (at least 3 digits, from 001) inside the caller's transaction. The per-stem
 * counter row is locked; a value present in `order_references` (manual or imported) is skipped and never reused.
 */
export async function allocateStemReference(tx: Tx, stem: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await tx
      .insert(orderReferenceCounters)
      .values({ scope: stem, nextValue: 1 })
      .onDuplicateKeyUpdate({ set: { nextValue: sql`${orderReferenceCounters.nextValue} + 1` } });
    const [counter] = await tx
      .select({ nextValue: orderReferenceCounters.nextValue })
      .from(orderReferenceCounters)
      .where(eq(orderReferenceCounters.scope, stem))
      .for("update");
    const candidate = `${stem}-${String(counter!.nextValue).padStart(3, "0")}`;
    if (candidate.length > 32) break;
    if (!(await isReferenceReserved(tx, candidate))) return candidate;
  }
  throw conflict("REFERENCE_ALLOCATION_FAILED", "A reference could not be allocated. Please try again.");
}

/**
 * Increment 08 (D2, imports): a kept stem reference (`STEM-NNN`) raises its stem counter to at least NNN, so the
 * generator continues after it instead of probing through reserved values.
 */
export async function noteStemReferenceUsed(tx: Tx, reference: string): Promise<void> {
  const stem = stemOfReference(reference);
  if (!stem) return;
  const used = Number(reference.slice(stem.length + 1));
  if (!Number.isSafeInteger(used) || used < 1 || used > 4_000_000_000) return;
  // Never advance past the last number that still fits the 32-character column: a maximal imported suffix (for
  // example a six-letter prefix and 999999) would otherwise leave the stem with no next value. Below the bound the
  // generator still skips every reserved value, so not bumping is always safe.
  if (stem.length + 1 + String(used + 1).length > 32) return;
  await tx
    .insert(orderReferenceCounters)
    .values({ scope: stem, nextValue: used })
    .onDuplicateKeyUpdate({ set: { nextValue: sql`GREATEST(${orderReferenceCounters.nextValue}, ${used})` } });
}

/** Older shape `PREFIX-YYYY-NNNNNN` (row-locked per-year counter). Increment 08: only a fallback (e.g. imports). */
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
