/**
 * In-transaction audit tap (increment 03, package J). Owner: audit engineer.
 *
 * After a DURABLE audit row has been inserted, the emitter offers the event to at most one registered tap
 * (the automations module). Rules:
 *
 * - Cost when nothing listens: one synchronous `listens(eventName)` call (an in-memory set lookup on the
 *   tap's side). No allocation of the tap event, no database work, no await.
 * - Only validated envelope data is passed on: event name, ids, actor role / id, resource type / public id,
 *   correlation ids, the validated safe attributes and safe counts. Never request addresses, session
 *   references or anything the envelope validator dropped.
 * - Loop protection (decision 10, gate 4.1 J): an event whose correlation id or parent correlation id
 *   carries the automation-origin marker is never offered. The marker lives in the correlation id, which
 *   the job queue and mail outbox persist on every row and restore in the worker context, so it survives
 *   every asynchronous descendant (jobs, mails, webhooks, later audit events such as mail.delivery.failed).
 * - A tap failure never fails the business transaction, EXCEPT when the database has already rolled the
 *   transaction back (deadlock / lock-wait timeout): continuing would commit the remaining statements
 *   outside the transaction, so the error is rethrown (fail closed).
 * - Events recorded without a transaction are offered with `tx: undefined`; the tap uses its own write.
 *   Best-effort notes (`audit.note`) are never offered: they are not evidence and may be dropped.
 */
import type { SafeAttributeValue, Tx } from "../../core/types.js";
import type { AuditEnvelope } from "./envelope.js";

/** Correlation-id prefix that marks work caused by an automation run. */
export const AUTOMATION_ORIGIN_PREFIX = "automation:";
const RUN_ID_RE = /^[A-Za-z0-9_-]{10,40}$/;

/** Correlation id for everything an automation run does (`automation:<runPublicId>`, ≤ 64 chars). */
export function automationCorrelationId(runPublicId: string): string {
  if (!RUN_ID_RE.test(runPublicId)) throw new TypeError("automation run id must be an opaque public id");
  return `${AUTOMATION_ORIGIN_PREFIX}${runPublicId}`;
}

export function isAutomationOrigin(correlationId: string | null | undefined): boolean {
  return typeof correlationId === "string" && correlationId.startsWith(AUTOMATION_ORIGIN_PREFIX);
}

export interface AuditTapEvent {
  eventId: string;
  eventName: string;
  category: AuditEnvelope["category"];
  action: string;
  outcome: AuditEnvelope["outcome"];
  reasonCode: string | null;
  occurredAt: string;
  actor: { role: AuditEnvelope["actor_role"]; userId: number | null };
  resource: { type: string; publicId: string | null } | null;
  correlationId: string | null;
  jobId: string | null;
  attributes: Readonly<Record<string, SafeAttributeValue>>;
  safeCounts: Readonly<Record<string, number>>;
}

export interface AuditTap {
  /** MUST be synchronous and cheap (e.g. `Set.has`). Called for every durable event. */
  listens(eventName: string): boolean;
  /** Enqueue work for the event. Runs inside the caller's transaction when there is one. */
  onRecorded(event: AuditTapEvent, tx: Tx | undefined): Promise<void>;
}

export interface AuditTapStats {
  offered: number;
  suppressedAutomationOrigin: number;
  failures: number;
  lastFailureAt: string | null;
}

export function toTapEvent(envelope: AuditEnvelope): AuditTapEvent {
  return Object.freeze({
    eventId: envelope.event_id,
    eventName: envelope.event_name,
    category: envelope.category,
    action: envelope.action,
    outcome: envelope.outcome,
    reasonCode: envelope.reason_code,
    occurredAt: envelope.occurred_at,
    actor: Object.freeze({ role: envelope.actor_role, userId: envelope.actor_user_id }),
    resource: envelope.resource_type ? Object.freeze({ type: envelope.resource_type, publicId: envelope.resource_public_id }) : null,
    correlationId: envelope.correlation_id,
    jobId: envelope.job_id,
    attributes: Object.freeze({ ...envelope.attributes }),
    safeCounts: Object.freeze({ ...envelope.safe_counts }),
  });
}

/** MySQL errors after which InnoDB has rolled back (or may have rolled back) the whole transaction. */
const TX_ABORTING_ERRNO = new Set([1213, 1205]);

export function abortsTransaction(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const errno = (current as { errno?: unknown }).errno;
    if (typeof errno === "number" && TX_ABORTING_ERRNO.has(errno)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
