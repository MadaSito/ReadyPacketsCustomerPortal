/** Row ⇄ envelope mapping. Owner: audit engineer. */
import type { AuditCategory, AuditOutcome, FieldCrypto, Severity } from "../../core/types.js";
import type { ActorRole, AuditEnvelope, SourceAddressClass } from "./envelope.js";
import type { auditEvents } from "./schema.js";

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type AuditEventInsert = typeof auditEvents.$inferInsert;

export function envelopeToRow(envelope: AuditEnvelope, sourceAddressEnc: string | null): AuditEventInsert {
  return {
    eventId: envelope.event_id,
    schemaVersion: envelope.schema_version,
    occurredAt: new Date(envelope.occurred_at),
    observedAt: new Date(envelope.observed_at),
    severityText: envelope.severity_text,
    severityNumber: envelope.severity_number,
    category: envelope.category,
    eventName: envelope.event_name,
    action: envelope.action,
    outcome: envelope.outcome,
    reasonCode: envelope.reason_code,
    durability: envelope.durability,
    actorUserId: envelope.actor_user_id,
    actorRef: envelope.actor_ref,
    actorRole: envelope.actor_role,
    sessionRef: envelope.session_ref,
    resourceType: envelope.resource_type,
    resourcePublicId: envelope.resource_public_id,
    resourceRef: envelope.resource_ref,
    orderPublicId: envelope.order_public_id ?? null,
    requestId: envelope.request_id,
    traceId: envelope.trace_id,
    spanId: envelope.span_id,
    correlationId: envelope.correlation_id,
    parentCorrelationId: envelope.parent_correlation_id,
    jobId: envelope.job_id,
    packageId: envelope.package_id,
    importId: envelope.import_id,
    deliveryId: envelope.delivery_id,
    provider: envelope.provider,
    durationMs: envelope.duration_ms,
    origin: envelope.origin,
    service: envelope.service,
    installationRef: envelope.installation_ref,
    releaseRef: envelope.release_ref,
    deploymentProfile: envelope.deployment_profile,
    sourceAddressClass: envelope.source_address_class,
    sourceAddressRef: envelope.source_address_ref,
    sourceAddressEnc,
    safeCounts: envelope.safe_counts,
    attributes: envelope.attributes,
    droppedAttributes: envelope.dropped_attributes,
  };
}

/** mysql2 returns JSON columns parsed; DATETIME(3) as Date (timezone Z in pools we create). */
export function rowToEnvelope(row: AuditEventRow, chainSeq: number | null = null): AuditEnvelope {
  return {
    schema_version: row.schemaVersion,
    event_id: row.eventId,
    occurred_at: row.occurredAt.toISOString(),
    observed_at: row.observedAt.toISOString(),
    severity_text: row.severityText as Severity,
    severity_number: row.severityNumber,
    category: row.category as AuditCategory,
    event_name: row.eventName,
    action: row.action,
    outcome: row.outcome as AuditOutcome,
    reason_code: row.reasonCode,
    durability: row.durability as AuditEnvelope["durability"],
    actor_ref: row.actorRef,
    actor_role: row.actorRole as ActorRole,
    actor_user_id: row.actorUserId,
    session_ref: row.sessionRef,
    resource_type: row.resourceType,
    resource_public_id: row.resourcePublicId,
    resource_ref: row.resourceRef,
    order_public_id: row.orderPublicId ?? null,
    request_id: row.requestId,
    trace_id: row.traceId,
    span_id: row.spanId,
    correlation_id: row.correlationId,
    parent_correlation_id: row.parentCorrelationId,
    job_id: row.jobId,
    package_id: row.packageId,
    import_id: row.importId,
    delivery_id: row.deliveryId,
    provider: row.provider,
    duration_ms: row.durationMs,
    origin: row.origin as AuditEnvelope["origin"],
    service: row.service,
    installation_ref: row.installationRef,
    release_ref: row.releaseRef,
    deployment_profile: row.deploymentProfile,
    source_address_class: row.sourceAddressClass as SourceAddressClass,
    source_address_ref: row.sourceAddressRef,
    safe_counts: (typeof row.safeCounts === "string" ? JSON.parse(row.safeCounts) : row.safeCounts) ?? {},
    attributes: (typeof row.attributes === "string" ? JSON.parse(row.attributes) : row.attributes) ?? {},
    dropped_attributes: row.droppedAttributes,
    chain_seq: chainSeq,
  };
}

/** Decrypts the local-only source address for reviewers. Returns null on any failure (never throws). */
export function decryptSourceAddress(crypto: FieldCrypto, row: Pick<AuditEventRow, "sourceAddressEnc" | "eventId">): string | null {
  if (!row.sourceAddressEnc) return null;
  try {
    return crypto.decrypt(row.sourceAddressEnc, `audit_events.source_address:${row.eventId}`);
  } catch {
    return null;
  }
}
