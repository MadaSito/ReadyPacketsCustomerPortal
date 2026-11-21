/**
 * Durable audit emitter. Owner: audit engineer.
 * Constructed BEFORE the settings store and modules, so it depends only on these primitives.
 *
 * record(event, tx?)  — validates, builds the canonical envelope and INSERTs it, inside `tx` when given
 *                       (atomic with the caller's business change). ANY failure (validation, DB, crypto)
 *                       throws AuditUnavailableError so the caller's transaction aborts (fail closed).
 * note(event)         — best-effort, low-impact. Bounded in-memory queue flushed in small batches;
 *                       never throws; drops are counted and reported (health + `audit.note.dropped`).
 *
 * Hash chaining is NOT done here: sequence numbers are assigned after commit by the sealer (chain.ts),
 * so concurrent transactions committing out of id order are still chained correctly.
 */
import type { AppConfig } from "../../config/env.js";
import { AuditUnavailableError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { AuditEmitter, AuditEventInput, Clock, Db, FieldCrypto, Logger, Tx } from "../../core/types.js";
import { AuditValidationError, buildEnvelope, type AuditEnvelope } from "./envelope.js";
import { envelopeToRow } from "./rows.js";
import { auditEvents } from "./schema.js";
import { abortsTransaction, isAutomationOrigin, toTapEvent, type AuditTap, type AuditTapStats } from "./tap.js";

export interface AuditEmitterDeps {
  config: AppConfig;
  db: Db;
  clock: Clock;
  logger: Logger;
  crypto: FieldCrypto;
}

export const NOTE_QUEUE_LIMIT = 1000;
const NOTE_BATCH = 100;

export interface AuditEmitterStats {
  recorded: number;
  recordFailures: number;
  lastRecordFailureAt: string | null;
  notesQueued: number;
  notesWritten: number;
  notesDropped: number;
  validationRejections: number;
}

export interface DurableAuditEmitter extends AuditEmitter {
  /** Builds + validates without writing (used by tests and the export/SIEM synthetic paths). */
  build(event: AuditEventInput, durability?: AuditEnvelope["durability"]): { envelope: AuditEnvelope; sourceAddressEnc: string | null };
  /** Waits until the best-effort queue is empty (tests, graceful shutdown). */
  flushNotes(): Promise<void>;
  stats(): AuditEmitterStats;
  /** Installs the single in-transaction tap (automations). Returns a detach function. See tap.ts. */
  setTap(tap: AuditTap): () => void;
  tapStats(): AuditTapStats;
}

export function isDurableAuditEmitter(value: AuditEmitter): value is DurableAuditEmitter {
  return typeof (value as Partial<DurableAuditEmitter>).stats === "function";
}

export function createAuditEmitter(deps: AuditEmitterDeps): DurableAuditEmitter {
  const log = deps.logger.child({ component: "audit.emitter" });
  const stats: AuditEmitterStats = {
    recorded: 0,
    recordFailures: 0,
    lastRecordFailureAt: null,
    notesQueued: 0,
    notesWritten: 0,
    notesDropped: 0,
    validationRejections: 0,
  };
  const queue: ReturnType<DurableAuditEmitter["build"]>[] = [];
  let flushing: Promise<void> | null = null;
  let dropsSinceReport = 0;
  let tap: AuditTap | null = null;
  const tapStats: AuditTapStats = { offered: 0, suppressedAutomationOrigin: 0, failures: 0, lastFailureAt: null };

  function wants(name: string): boolean {
    if (!tap) return false;
    try {
      return tap.listens(name) === true;
    } catch {
      return false;
    }
  }

  async function offer(envelope: AuditEnvelope, tx: Tx | undefined): Promise<void> {
    const current = tap;
    if (!current || !wants(envelope.event_name)) return;
    if (isAutomationOrigin(envelope.correlation_id) || isAutomationOrigin(envelope.parent_correlation_id)) {
      tapStats.suppressedAutomationOrigin += 1;
      return;
    }
    tapStats.offered += 1;
    try {
      await current.onRecorded(toTapEvent(envelope), tx);
    } catch (error) {
      tapStats.failures += 1;
      tapStats.lastFailureAt = deps.clock.now().toISOString();
      log.error("audit tap failed; automation trigger not enqueued", { event_name: envelope.event_name, in_transaction: tx !== undefined, error });
      // The database already rolled the transaction back: carrying on would commit the rest outside it.
      if (tx !== undefined && abortsTransaction(error)) throw new AuditUnavailableError();
    }
  }

  function build(event: AuditEventInput, durability: AuditEnvelope["durability"] = "durable") {
    const observedAt = deps.clock.now();
    const request = getRequestContext();
    const envelope = buildEnvelope(event, {
      config: deps.config,
      crypto: deps.crypto,
      request,
      eventId: ulid(observedAt.getTime()),
      observedAt,
      durability,
    });
    const address = request?.ipAddress;
    const sourceAddressEnc = address ? deps.crypto.encrypt(address, `audit_events.source_address:${envelope.event_id}`) : null;
    if (envelope.dropped_attributes > 0) {
      log.warn("audit attributes dropped by validation", { event_name: envelope.event_name, dropped: envelope.dropped_attributes });
    }
    return { envelope, sourceAddressEnc };
  }

  async function writeBatch(items: ReturnType<typeof build>[]): Promise<void> {
    await deps.db.insert(auditEvents).values(items.map((item) => envelopeToRow(item.envelope, item.sourceAddressEnc)));
  }

  function scheduleFlush(): void {
    if (flushing) return;
    flushing = (async () => {
      try {
        while (queue.length > 0) {
          const batch = queue.splice(0, NOTE_BATCH);
          try {
            await writeBatch(batch);
            stats.notesWritten += batch.length;
          } catch (error) {
            stats.notesDropped += batch.length;
            dropsSinceReport += batch.length;
            log.warn("best-effort audit notes dropped (store unavailable)", { count: batch.length, error });
          }
        }
        if (dropsSinceReport > 0) {
          const count = dropsSinceReport;
          dropsSinceReport = 0;
          try {
            const item = build(
              {
                category: "system",
                eventName: "audit.note.dropped",
                action: "drop",
                outcome: "failed",
                severity: "WARN",
                reasonCode: "NOTE_QUEUE_LOSS",
                actor: { role: "system" },
                safeCounts: { dropped: count },
              },
              "durable",
            );
            await writeBatch([item]);
          } catch {
            dropsSinceReport += count;
          }
        }
      } finally {
        flushing = null;
      }
    })();
  }

  return {
    build,
    async record(event: AuditEventInput, tx?: Tx): Promise<void> {
      let item: ReturnType<typeof build>;
      try {
        item = build(event, "durable");
      } catch (error) {
        stats.validationRejections += 1;
        stats.recordFailures += 1;
        log.error("audit event rejected by validation", {
          field: error instanceof AuditValidationError ? error.field : "unknown",
          event_name_valid: typeof event?.eventName === "string" && /^[a-z0-9_.]{1,96}$/.test(event.eventName) ? event.eventName : "[invalid]",
        });
        throw new AuditUnavailableError();
      }
      try {
        await (tx ?? deps.db).insert(auditEvents).values(envelopeToRow(item.envelope, item.sourceAddressEnc));
        stats.recorded += 1;
      } catch (error) {
        stats.recordFailures += 1;
        stats.lastRecordFailureAt = deps.clock.now().toISOString();
        log.error("durable audit write failed", { event_name: item.envelope.event_name, in_transaction: tx !== undefined, error });
        throw new AuditUnavailableError();
      }
      if (tap) await offer(item.envelope, tx);
    },
    note(event: AuditEventInput): void {
      try {
        const item = build(event, "best_effort");
        if (queue.length >= NOTE_QUEUE_LIMIT) {
          stats.notesDropped += 1;
          dropsSinceReport += 1;
          return;
        }
        queue.push(item);
        scheduleFlush();
      } catch {
        stats.validationRejections += 1;
        log.warn("best-effort audit note rejected by validation", {});
      }
    },
    async flushNotes(): Promise<void> {
      while (flushing || queue.length > 0) {
        if (!flushing) scheduleFlush();
        await flushing;
      }
    },
    stats: () => ({ ...stats, notesQueued: queue.length }),
    setTap(next: AuditTap): () => void {
      if (tap && tap !== next) throw new Error("an audit tap is already installed");
      tap = next;
      return () => {
        if (tap === next) tap = null;
      };
    },
    tapStats: () => ({ ...tapStats }),
  };
}
