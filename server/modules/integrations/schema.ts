/**
 * Integrations module — Drizzle MySQL tables. Owner: integrations module engineer.
 *
 * Tables:
 *  - `integration_egress_allowlist`  : Explicit admin-approved egress destinations (step-up + audited).
 *  - `integration_provider_checks`   : Truthful last-check state per optional provider (never fake "ok").
 *  - `integration_webhook_events`    : Durable authenticated webhook inbox for idempotent delivery handling.
 */
import { boolean, char, index, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";

export const integrationEgressAllowlist = mysqlTable(
  "integration_egress_allowlist",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    matchType: varchar("match_type", { length: 16 }).notNull(), // "host" | "ip" | "cidr"
    pattern: varchar("pattern", { length: 255 }).notNull(),
    port: int("port", { unsigned: true }).notNull(),
    protocol: varchar("protocol", { length: 16 }).notNull(), // "https:" | "tls:" | "smtp:" | "smtps:"
    allowPrivateAddress: boolean("allow_private_address").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    justification: varchar("justification", { length: 280 }).notNull(),
    createdByUserId: refColumn("created_by_user_id"),
    updatedByUserId: refColumn("updated_by_user_id"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_integration_egress_target").on(table.purpose, table.pattern, table.port, table.protocol),
    index("idx_integration_egress_purpose_enabled").on(table.purpose, table.enabled),
  ],
);

export const integrationProviderChecks = mysqlTable(
  "integration_provider_checks",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    providerKey: varchar("provider_key", { length: 32 }).notNull(),
    lastCheckedAt: utcDateTime("last_checked_at").notNull(),
    lastOutcome: varchar("last_outcome", { length: 24 }).notNull(), // "succeeded" | "failed" | "unknown"
    lastReasonCode: varchar("last_reason_code", { length: 64 }),
    verifiedAt: utcDateTime("verified_at"),
    consecutiveFailures: int("consecutive_failures", { unsigned: true }).notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex("uq_integration_provider_checks_key").on(table.providerKey)],
);

export const integrationWebhookEvents = mysqlTable(
  "integration_webhook_events",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    provider: varchar("provider", { length: 32 }).notNull(),
    externalEventId: varchar("external_event_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 96 }).notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(), // "processing" | "processed" | "ignored" | "failed"
    reasonCode: varchar("reason_code", { length: 64 }),
    providerTimestamp: utcDateTime("provider_timestamp").notNull(),
    processedAt: utcDateTime("processed_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("uq_integration_webhook_provider_event").on(table.provider, table.externalEventId),
    index("idx_integration_webhook_status").on(table.provider, table.status),
  ],
);
