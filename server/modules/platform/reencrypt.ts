/**
 * Resumable re-encryption of one encrypted column to the current data key. Owner: platform engineer.
 *
 * Mechanics (see scripts/ops/keys/RUNBOOK.md):
 *  - Walk rows by ascending numeric id in bounded batches, starting after the persisted checkpoint.
 *  - For each envelope not under the current key: decrypt with the retained key (dual-read), re-encrypt
 *    under the current key with the SAME AAD, and write with compare-and-set (`WHERE id = ? AND col = old`)
 *    so a concurrent application write is never overwritten (counted as `skipped`, picked up next pass).
 *  - Each batch is ONE transaction: checkpoint row lock, CAS writes, checkpoint advance and durable audit.
 *  - A row that fails to decrypt is counted `failed` and left untouched (fail closed — never "repaired").
 *  - The retired key may only be removed from the keyring after a full pass reports zero remaining and
 *    zero failed, and backups that still need it have expired (retirement criteria in the runbook).
 */
import { and, asc, eq, getTableColumns, gt, isNotNull, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import type { AuditEmitter, Clock, Db, Tx } from "../../core/types.js";
import type { PlatformFieldCrypto } from "../../security/fieldCrypto.js";
import { platformReencryptCheckpoints } from "./schema.js";

export interface ReencryptTarget {
  /** Stable name, e.g. `users.email_enc`. */
  name: string;
  table: MySqlTable;
  idColumn: MySqlColumn;
  envelopeColumn: MySqlColumn;
  /** Extra columns needed to rebuild the AAD (e.g. public_id). */
  aadColumns: Record<string, MySqlColumn>;
  aadFor(row: Record<string, unknown>): string;
}

export interface ReencryptBatchResult {
  rewritten: number;
  skipped: number;
  failed: number;
  alreadyCurrent: number;
  lastId: number;
  done: boolean;
}

export function createReencryptor(deps: { db: Db; clock: Clock; audit: AuditEmitter; crypto: PlatformFieldCrypto }) {
  const { db, clock, audit, crypto } = deps;
  const targetKeyId = crypto.keyringStatus().currentKeyId;

  async function ensureCheckpoint(target: ReencryptTarget): Promise<void> {
    const where = and(eq(platformReencryptCheckpoints.target, target.name), eq(platformReencryptCheckpoints.targetKeyId, targetKeyId));
    const [row] = await db.select({ id: platformReencryptCheckpoints.id }).from(platformReencryptCheckpoints).where(where).limit(1);
    if (row) return;
    try {
      await db.insert(platformReencryptCheckpoints).values({ target: target.name, targetKeyId, createdAt: clock.now(), updatedAt: clock.now() });
    } catch (error) {
      if (!isDuplicate(error)) throw error; // a concurrent runner created it
    }
  }

  /**
   * Processes one batch after the checkpoint, atomically: the checkpoint row is locked FOR UPDATE (so
   * overlapping runners serialize and the cursor only moves forward), payload compare-and-set writes, the
   * checkpoint advance and the durable audit record commit together — audit failure ⇒ nothing changes.
   * Idempotent; call until `done`.
   */
  async function runBatch(target: ReencryptTarget, batchSize = 200): Promise<ReencryptBatchResult> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(batchSize)));
    await ensureCheckpoint(target);
    return db.transaction(async (tx: Tx) => {
      const [state] = await tx
        .select()
        .from(platformReencryptCheckpoints)
        .where(and(eq(platformReencryptCheckpoints.target, target.name), eq(platformReencryptCheckpoints.targetKeyId, targetKeyId)))
        .for("update");
      if (!state) throw new Error("re-encryption checkpoint missing");
      const rows = (await tx
        .select({ id: target.idColumn, envelope: target.envelopeColumn, ...target.aadColumns })
        .from(target.table)
        .where(and(gt(target.idColumn, state.lastId), isNotNull(target.envelopeColumn)))
        .orderBy(asc(target.idColumn))
        .limit(limit)) as Record<string, unknown>[];

      let rewritten = 0;
      let skipped = 0;
      let failed = 0;
      let alreadyCurrent = 0;
      let lastId = state.lastId;
      for (const row of rows) {
        const id = Number(row.id);
        const envelope = row.envelope as string;
        lastId = Math.max(lastId, id);
        let next: string;
        try {
          if (!crypto.needsReencryption(envelope)) {
            alreadyCurrent += 1;
            continue;
          }
          next = crypto.reencrypt(envelope, target.aadFor(row));
        } catch {
          failed += 1;
          continue;
        }
        const result = (await tx
          .update(target.table)
          .set({ [envelopeProperty(target)]: next } as Record<string, unknown>)
          .where(and(eq(target.idColumn, id), eq(target.envelopeColumn, envelope)) as SQL)) as unknown as [{ affectedRows: number }];
        if (result[0]?.affectedRows === 1) rewritten += 1;
        else skipped += 1;
      }
      const done = rows.length < limit;
      await tx
        .update(platformReencryptCheckpoints)
        .set({
          lastId,
          rewritten: sql`${platformReencryptCheckpoints.rewritten} + ${rewritten}`,
          skipped: sql`${platformReencryptCheckpoints.skipped} + ${skipped}`,
          failed: sql`${platformReencryptCheckpoints.failed} + ${failed}`,
          completedAt: done ? clock.now() : null,
          updatedAt: clock.now(),
        })
        .where(eq(platformReencryptCheckpoints.id, state.id));
      await audit.record(
        {
          category: "system",
          eventName: "platform.crypto.reencrypt.batch",
          action: "reencrypt",
          outcome: failed > 0 ? "failed" : "completed",
          severity: failed > 0 ? "WARN" : "INFO",
          reasonCode: failed > 0 ? "UNREADABLE_ROWS" : undefined,
          resource: { type: "encrypted_column" },
          safeCounts: { rewritten, skipped, failed, already_current: alreadyCurrent },
          attributes: { target: target.name, target_key_id: targetKeyId, done },
        },
        tx,
      );
      return { rewritten, skipped, failed, alreadyCurrent, lastId, done };
    });
  }

  /** Counts envelopes still under a non-current key (bounded scan for verification before key retirement). */
  async function remaining(target: ReencryptTarget, maxRows = 100_000): Promise<{ remaining: number; scanned: number; truncated: boolean }> {
    let after = 0;
    let remainingCount = 0;
    let scanned = 0;
    for (;;) {
      const rows = (await db
        .select({ id: target.idColumn, envelope: target.envelopeColumn })
        .from(target.table)
        .where(and(gt(target.idColumn, after), isNotNull(target.envelopeColumn)))
        .orderBy(asc(target.idColumn))
        .limit(1000)) as { id: number; envelope: string }[];
      for (const row of rows) {
        scanned += 1;
        after = Number(row.id);
        try {
          if (crypto.needsReencryption(row.envelope)) remainingCount += 1;
        } catch {
          remainingCount += 1;
        }
      }
      if (rows.length < 1000) return { remaining: remainingCount, scanned, truncated: false };
      if (scanned >= maxRows) return { remaining: remainingCount, scanned, truncated: true };
    }
  }

  /** Restart a pass from the beginning (e.g. after skipped rows). */
  async function resetCheckpoint(target: ReencryptTarget): Promise<void> {
    await ensureCheckpoint(target);
    await db.transaction(async (tx: Tx) => {
      await tx
        .update(platformReencryptCheckpoints)
        .set({ lastId: 0, completedAt: null, updatedAt: clock.now() })
        .where(and(eq(platformReencryptCheckpoints.target, target.name), eq(platformReencryptCheckpoints.targetKeyId, targetKeyId)));
      await audit.record(
        {
          category: "system",
          eventName: "platform.crypto.reencrypt.reset",
          action: "reencrypt",
          outcome: "completed",
          resource: { type: "encrypted_column" },
          attributes: { target: target.name, target_key_id: targetKeyId },
        },
        tx,
      );
    });
  }

  return { runBatch, remaining, resetCheckpoint, targetKeyId };
}

function isDuplicate(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && current !== null && (current as { code?: string }).code === "ER_DUP_ENTRY") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Drizzle's `.set()` is keyed by the TypeScript property name, not the SQL column name. */
function envelopeProperty(target: ReencryptTarget): string {
  const entry = Object.entries(getTableColumns(target.table)).find(([, column]) => column === target.envelopeColumn);
  if (!entry) throw new Error(`envelope column does not belong to ${target.name}`);
  return entry[0];
}
