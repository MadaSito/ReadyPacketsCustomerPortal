/**
 * Order policy acceptance evidence (increment 04 part B, package V, ADR 0039). Owner: identity_engineer
 * (inside the compliance module, module owner compliance_engineer).
 *
 * APPEND-ONLY: the service inserts rows and never updates or deletes them (no updated_at / version).
 * One row per (order, acting user, policy version, gate, pinned workflow version). The row binds the exact text shown (SHA-256 of
 * the normalized policy body) so evidence cannot be replayed for another order or a different text.
 * Policy references are plain refs (no FK) to avoid a schema import cycle with ./schema.ts; the service
 * resolves them through the policies service.
 */
import { char, foreignKey, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, utcDateTime } from "../../db/columns.js";
import { users } from "../identity/schema.js";

export const ACCEPTANCE_SIGNATURE_MODES = ["checkbox", "typed_name"] as const;
export type AcceptanceSignatureMode = (typeof ACCEPTANCE_SIGNATURE_MODES)[number];

export const orderPolicyAcceptances = mysqlTable(
  "order_policy_acceptances",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Internal order id (orders module; no cross-module FK). */
    orderId: refColumn("order_id").notNull(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    userId: refColumn("user_id").notNull(),
    /** `order_start` or the workflow step key the gate guards. */
    gateKey: varchar("gate_key", { length: 64 }).notNull(),
    workflowVersionId: refColumn("workflow_version_id").notNull(),
    policyDocumentId: refColumn("policy_document_id").notNull(),
    policyVersionId: refColumn("policy_version_id").notNull(),
    policyPublicId: char("policy_public_id", { length: 26 }).notNull(),
    policyVersionNumber: int("policy_version_number", { unsigned: true }).notNull(),
    /** SHA-256 hex of the exact normalized text shown to the user. */
    textSha256: char("text_sha256", { length: 64 }).notNull(),
    signatureMode: mysqlEnum("signature_mode", ACCEPTANCE_SIGNATURE_MODES).notNull(),
    /** AES-256-GCM, AAD `order_policy_acceptances.typed_name:<publicId>`. */
    typedNameEnc: text("typed_name_enc"),
    acceptedAt: utcDateTime("accepted_at").notNull(),
    /** AES-256-GCM, AAD `order_policy_acceptances.ip:<publicId>`. Console: only with sessions.read_all. */
    sourceAddressEnc: text("source_address_enc"),
    userAgent: varchar("user_agent", { length: 512 }),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({ name: "cmp_ord_acc_user_fk", columns: [t.userId], foreignColumns: [users.id] }),
    uniqueIndex("cmp_ord_acc_once_uq").on(t.orderId, t.userId, t.policyVersionId, t.gateKey, t.workflowVersionId),
    index("cmp_ord_acc_order_idx").on(t.orderId, t.acceptedAt),
    index("cmp_ord_acc_user_idx").on(t.userId),
    /** Increment 05 acceptance log centre: newest-first keyset scan (acceptedAt DESC, publicId DESC). */
    index("cmp_ord_acc_time_idx").on(t.acceptedAt, t.publicId),
  ],
);
export type OrderPolicyAcceptanceRow = typeof orderPolicyAcceptances.$inferSelect;
