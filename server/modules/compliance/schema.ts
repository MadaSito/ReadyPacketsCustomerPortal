/**
 * Compliance module — Drizzle MySQL tables. Owner: compliance_engineer.
 *
 * Covers three linked evidentiary domains (architecture §3.1):
 *   1. Policy documents, immutable published versions, and user acceptance evidence
 *   2. Versioned intake questionnaires, encrypted order submissions, and full answer/review history
 *   3. Order invoices, sequential numbering, manual/provider payment evidence, and refund evidence
 *
 * All foreign-key and index names are explicitly <= 48 characters (MySQL identifier cap = 64).
 */
import {
  boolean,
  char,
  foreignKey,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  idColumn,
  publicIdColumn,
  refColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";
import { users } from "../identity/schema.js";

/* ---------------------------------------------------------------- policies */

export const POLICY_AUDIENCES = ["all", "customer", "staff"] as const;
export type PolicyAudience = (typeof POLICY_AUDIENCES)[number];

export const POLICY_VERSION_STATUSES = ["draft", "published"] as const;
export type PolicyVersionStatus = (typeof POLICY_VERSION_STATUSES)[number];

export const POLICY_CONTENT_FORMATS = ["plain_text", "safe_markdown"] as const;
export type PolicyContentFormat = (typeof POLICY_CONTENT_FORMATS)[number];

export const POLICY_ACCEPTANCE_METHODS = [
  "portal_checkbox",
  "registration",
  "typed_signature",
  "imported_historical",
] as const;
export type PolicyAcceptanceMethod = (typeof POLICY_ACCEPTANCE_METHODS)[number];

export const RECORD_ORIGINS = ["portal", "import"] as const;
export type RecordOrigin = (typeof RECORD_ORIGINS)[number];

export const policyDocuments = mysqlTable(
  "policy_documents",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    slug: varchar("slug", { length: 64 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    audience: mysqlEnum("audience", POLICY_AUDIENCES).notNull().default("customer"),
    requiresAcceptance: boolean("requires_acceptance").notNull().default(true),
    requiresTypedSignature: boolean("requires_typed_signature").notNull().default(false),
    active: boolean("active").notNull().default(true),
    /** Pointer to latest published policy_versions.id (nullable until first publication). */
    currentPublishedVersionId: refColumn("current_published_version_id"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("cmp_pol_docs_slug_uq").on(t.slug),
    index("cmp_pol_docs_active_aud_idx").on(t.active, t.audience),
  ],
);

export const policyVersions = mysqlTable(
  "policy_versions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    documentId: refColumn("document_id").notNull(),
    versionNumber: int("version_number", { unsigned: true }).notNull(),
    versionLabel: varchar("version_label", { length: 32 }).notNull(),
    status: mysqlEnum("status", POLICY_VERSION_STATUSES).notNull().default("draft"),
    contentFormat: mysqlEnum("content_format", POLICY_CONTENT_FORMATS).notNull().default("safe_markdown"),
    /** Normalized NFC + LF text; never rendered as raw HTML. */
    bodyText: mediumtext("body_text").notNull(),
    /** SHA-256 hex digest of normalized bodyText. Locked permanently when published. */
    contentHash: char("content_hash", { length: 64 }).notNull(),
    changeSummary: varchar("change_summary", { length: 500 }),
    effectiveAt: utcDateTime("effective_at").notNull(),
    publishedAt: utcDateTime("published_at"),
    publishedByUserId: refColumn("published_by_user_id"),
    origin: mysqlEnum("origin", RECORD_ORIGINS).notNull().default("portal"),
    importId: varchar("import_id", { length: 64 }),
    sourceInstallationId: varchar("source_installation_id", { length: 128 }),
    sourcePublicId: varchar("source_public_id", { length: 64 }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cmp_pol_ver_doc_fk",
      columns: [t.documentId],
      foreignColumns: [policyDocuments.id],
    }),
    foreignKey({
      name: "cmp_pol_ver_pub_user_fk",
      columns: [t.publishedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cmp_pol_ver_doc_num_uq").on(t.documentId, t.versionNumber),
    uniqueIndex("cmp_pol_ver_doc_lbl_uq").on(t.documentId, t.versionLabel),
    uniqueIndex("cmp_pol_ver_imp_uq").on(t.sourceInstallationId, t.sourcePublicId),
    index("cmp_pol_ver_doc_st_eff_idx").on(t.documentId, t.status, t.effectiveAt),
  ],
);

export const policyAcceptances = mysqlTable(
  "policy_acceptances",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id").notNull(),
    documentId: refColumn("document_id").notNull(),
    policyVersionId: refColumn("policy_version_id").notNull(),
    /** Exact SHA-256 content hash verified at acceptance time. */
    versionContentHash: char("version_content_hash", { length: 64 }).notNull(),
    acceptedAt: utcDateTime("accepted_at").notNull(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    /** HMAC pseudonym of client IP (`deps.crypto.pseudonym(ip, "compliance.policy_acceptance.ip")`); never raw IP. */
    sourceAddressPseudonym: varchar("source_address_pseudonym", { length: 64 }),
    method: mysqlEnum("method", POLICY_ACCEPTANCE_METHODS).notNull(),
    /** Optional AES-256-GCM encrypted typed signature (`policy_acceptances.signer_name:<publicId>`). */
    signerNameEnc: text("signer_name_enc"),
    /** Optional internal order id when accepted in an order context (no cross-module FK). */
    orderId: refColumn("order_id"),
    orderPublicId: char("order_public_id", { length: 26 }),
    origin: mysqlEnum("origin", RECORD_ORIGINS).notNull().default("portal"),
    importId: varchar("import_id", { length: 64 }),
    sourceInstallationId: varchar("source_installation_id", { length: 128 }),
    sourcePublicId: varchar("source_public_id", { length: 64 }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cmp_pol_acc_user_fk",
      columns: [t.userId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "cmp_pol_acc_doc_fk",
      columns: [t.documentId],
      foreignColumns: [policyDocuments.id],
    }),
    foreignKey({
      name: "cmp_pol_acc_ver_fk",
      columns: [t.policyVersionId],
      foreignColumns: [policyVersions.id],
    }),
    uniqueIndex("cmp_pol_acc_usr_ver_orig_uq").on(t.userId, t.policyVersionId, t.origin),
    uniqueIndex("cmp_pol_acc_imp_uq").on(t.sourceInstallationId, t.sourcePublicId),
    index("cmp_pol_acc_doc_ver_idx").on(t.documentId, t.policyVersionId),
    index("cmp_pol_acc_order_idx").on(t.orderPublicId),
  ],
);

/* ------------------------------------------------------------------ intake */

export const INTAKE_SCOPE_KINDS = ["default", "catalog_item", "workflow"] as const;
export type IntakeScopeKind = (typeof INTAKE_SCOPE_KINDS)[number];

export const INTAKE_VERSION_STATUSES = ["draft", "published"] as const;
export type IntakeVersionStatus = (typeof INTAKE_VERSION_STATUSES)[number];

export const INTAKE_FIELD_TYPES = [
  "short_text",
  "long_text",
  "single_choice",
  "multi_choice",
  "date",
  "number",
] as const;
export type IntakeFieldType = (typeof INTAKE_FIELD_TYPES)[number];

export const INTAKE_SUBMISSION_STATUSES = [
  "draft",
  "submitted",
  "returned_for_changes",
  "accepted",
] as const;
export type IntakeSubmissionStatus = (typeof INTAKE_SUBMISSION_STATUSES)[number];

export const INTAKE_REVISION_EVENTS = [
  "draft_saved",
  "submitted",
  "returned_for_changes",
  "accepted",
  "imported",
] as const;
export type IntakeRevisionEvent = (typeof INTAKE_REVISION_EVENTS)[number];

export interface StoredIntakeFieldOption {
  value: string;
  label: string;
}

export interface StoredIntakeFieldDef {
  key: string;
  section?: string;
  label: string;
  helpText?: string;
  type: IntakeFieldType;
  required: boolean;
  sensitive: boolean;
  minLength?: number;
  maxLength?: number;
  options?: StoredIntakeFieldOption[];
  minNumber?: number;
  maxNumber?: number;
  minSelections?: number;
  maxSelections?: number;
}

export const intakeQuestionnaires = mysqlTable(
  "intake_questionnaires",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    slug: varchar("slug", { length: 64 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: varchar("description", { length: 1000 }),
    scopeKind: mysqlEnum("scope_kind", INTAKE_SCOPE_KINDS).notNull().default("default"),
    /** Product publicId or workflow key when scoped; null for `default`. */
    scopeRef: varchar("scope_ref", { length: 64 }),
    active: boolean("active").notNull().default(true),
    currentPublishedVersionId: refColumn("current_published_version_id"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("cmp_int_q_slug_uq").on(t.slug),
    index("cmp_int_q_scope_act_idx").on(t.scopeKind, t.scopeRef, t.active),
  ],
);

export const intakeQuestionnaireVersions = mysqlTable(
  "intake_questionnaire_versions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    questionnaireId: refColumn("questionnaire_id").notNull(),
    versionNumber: int("version_number", { unsigned: true }).notNull(),
    status: mysqlEnum("status", INTAKE_VERSION_STATUSES).notNull().default("draft"),
    fieldsJson: json("fields_json").$type<StoredIntakeFieldDef[]>().notNull(),
    schemaHash: char("schema_hash", { length: 64 }).notNull(),
    publishedAt: utcDateTime("published_at"),
    publishedByUserId: refColumn("published_by_user_id"),
    origin: mysqlEnum("origin", RECORD_ORIGINS).notNull().default("portal"),
    importId: varchar("import_id", { length: 64 }),
    sourceInstallationId: varchar("source_installation_id", { length: 128 }),
    sourcePublicId: varchar("source_public_id", { length: 64 }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cmp_iqv_q_fk",
      columns: [t.questionnaireId],
      foreignColumns: [intakeQuestionnaires.id],
    }),
    foreignKey({
      name: "cmp_iqv_pub_user_fk",
      columns: [t.publishedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cmp_iqv_qid_num_uq").on(t.questionnaireId, t.versionNumber),
    uniqueIndex("cmp_iqv_imp_uq").on(t.sourceInstallationId, t.sourcePublicId),
    index("cmp_iqv_qid_st_idx").on(t.questionnaireId, t.status),
  ],
);

export const intakeSubmissions = mysqlTable(
  "intake_submissions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Internal orders.id (no cross-module FK; validated via services.orders). */
    orderId: refColumn("order_id").notNull(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    questionnaireId: refColumn("questionnaire_id").notNull(),
    questionnaireVersionId: refColumn("questionnaire_version_id").notNull(),
    status: mysqlEnum("status", INTAKE_SUBMISSION_STATUSES).notNull().default("draft"),
    revisionNumber: int("revision_number", { unsigned: true }).notNull().default(1),
    /** AES-256-GCM encrypted JSON answer map (`intake_submissions.answers:<publicId>`). */
    currentAnswersEnc: mediumtext("current_answers_enc").notNull(),
    submittedAt: utcDateTime("submitted_at"),
    submittedByUserId: refColumn("submitted_by_user_id"),
    reviewedAt: utcDateTime("reviewed_at"),
    reviewedByUserId: refColumn("reviewed_by_user_id"),
    origin: mysqlEnum("origin", RECORD_ORIGINS).notNull().default("portal"),
    importId: varchar("import_id", { length: 64 }),
    sourceInstallationId: varchar("source_installation_id", { length: 128 }),
    sourcePublicId: varchar("source_public_id", { length: 64 }),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cmp_isub_q_fk",
      columns: [t.questionnaireId],
      foreignColumns: [intakeQuestionnaires.id],
    }),
    foreignKey({
      name: "cmp_isub_qv_fk",
      columns: [t.questionnaireVersionId],
      foreignColumns: [intakeQuestionnaireVersions.id],
    }),
    foreignKey({
      name: "cmp_isub_sub_user_fk",
      columns: [t.submittedByUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "cmp_isub_rev_user_fk",
      columns: [t.reviewedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cmp_isub_order_q_uq").on(t.orderId, t.questionnaireId),
    uniqueIndex("cmp_isub_imp_uq").on(t.sourceInstallationId, t.sourcePublicId),
    index("cmp_isub_order_pub_idx").on(t.orderPublicId),
    index("cmp_isub_status_idx").on(t.status),
  ],
);

export const intakeSubmissionRevisions = mysqlTable(
  "intake_submission_revisions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    submissionId: refColumn("submission_id").notNull(),
    revisionNumber: int("revision_number", { unsigned: true }).notNull(),
    eventKind: mysqlEnum("event_kind", INTAKE_REVISION_EVENTS).notNull(),
    actorUserId: refColumn("actor_user_id"),
    actorRole: mysqlEnum("actor_role", ["customer", "staff", "admin", "system"]).notNull(),
    /** AES-256-GCM encrypted JSON answer snapshot (`intake_submission_revisions.answers:<publicId>`). */
    answersEnc: mediumtext("answers_enc").notNull(),
    /** Optional AES-256-GCM encrypted review note (`intake_submission_revisions.note:<publicId>`). */
    noteEnc: text("note_enc"),
    occurredAt: utcDateTime("occurred_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "cmp_irev_sub_fk",
      columns: [t.submissionId],
      foreignColumns: [intakeSubmissions.id],
    }),
    foreignKey({
      name: "cmp_irev_actor_fk",
      columns: [t.actorUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cmp_irev_sub_rev_uq").on(t.submissionId, t.revisionNumber),
  ],
);

/* ----------------------------------------------------- invoices & evidence */

export const INVOICE_STATUSES = ["draft", "issued", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = [
  "bank_transfer",
  "wire",
  "ach",
  "check",
  "card_manual",
  "waiver",
  "provider_online",
  "imported_historical",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_RECORD_STATUSES = ["succeeded", "failed"] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];

export const complianceSequences = mysqlTable(
  "compliance_sequences",
  {
    id: idColumn(),
    seqKey: varchar("seq_key", { length: 32 }).notNull(),
    nextVal: int("next_val", { unsigned: true }).notNull().default(1),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("cmp_seq_key_uq").on(t.seqKey)],
);

export const complianceInvoices = mysqlTable(
  "compliance_invoices",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Internal orders.id (validated via services.orders; no cross-module FK). */
    orderId: refColumn("order_id").notNull(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    sequenceNumber: int("sequence_number", { unsigned: true }),
    /** Sequential human-facing number once issued (null while draft, e.g. RP-INV-2026-000001). */
    invoiceNumber: varchar("invoice_number", { length: 48 }),
    /** Derived status persisted for indexed filtering; always recomputed from issuance/void/ledger evidence. */
    status: mysqlEnum("status", INVOICE_STATUSES).notNull().default("draft"),
    currency: currencyColumn("currency").notNull(),
    subtotalMinor: amountMinorColumn("subtotal_minor").notNull(),
    discountMinor: amountMinorColumn("discount_minor").notNull().default(0),
    taxMinor: amountMinorColumn("tax_minor").notNull().default(0),
    totalMinor: amountMinorColumn("total_minor").notNull(),
    issuedAt: utcDateTime("issued_at"),
    dueAt: utcDateTime("due_at"),
    voidedAt: utcDateTime("voided_at"),
    voidReason: varchar("void_reason", { length: 500 }),
    memo: varchar("memo", { length: 1000 }),
    issuerNameSnapshot: varchar("issuer_name_snapshot", { length: 160 }),
    issuerAddressSnapshot: varchar("issuer_address_snapshot", { length: 500 }),
    createdByUserId: refColumn("created_by_user_id"),
    issuedByUserId: refColumn("issued_by_user_id"),
    voidedByUserId: refColumn("voided_by_user_id"),
    origin: mysqlEnum("origin", RECORD_ORIGINS).notNull().default("portal"),
    importId: varchar("import_id", { length: 64 }),
    sourceInstallationId: varchar("source_installation_id", { length: 128 }),
    sourcePublicId: varchar("source_public_id", { length: 64 }),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cmp_inv_created_by_fk",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "cmp_inv_issued_by_fk",
      columns: [t.issuedByUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "cmp_inv_voided_by_fk",
      columns: [t.voidedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cmp_inv_number_uq").on(t.invoiceNumber),
    uniqueIndex("cmp_inv_imp_uq").on(t.sourceInstallationId, t.sourcePublicId),
    index("cmp_inv_order_idx").on(t.orderId),
    index("cmp_inv_order_pub_idx").on(t.orderPublicId),
    index("cmp_inv_st_created_idx").on(t.status, t.createdAt),
  ],
);

export const complianceInvoiceLines = mysqlTable(
  "compliance_invoice_lines",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    invoiceId: refColumn("invoice_id").notNull(),
    position: int("position", { unsigned: true }).notNull(),
    description: varchar("description", { length: 240 }).notNull(),
    quantity: int("quantity", { unsigned: true }).notNull(),
    unitAmountMinor: amountMinorColumn("unit_amount_minor").notNull(),
    lineTotalMinor: amountMinorColumn("line_total_minor").notNull(),
  },
  (t) => [
    foreignKey({
      name: "cmp_inv_line_inv_fk",
      columns: [t.invoiceId],
      foreignColumns: [complianceInvoices.id],
    }),
    uniqueIndex("cmp_inv_line_inv_pos_uq").on(t.invoiceId, t.position),
  ],
);

export const complianceInvoicePayments = mysqlTable(
  "compliance_invoice_payments",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    invoiceId: refColumn("invoice_id").notNull(),
    method: mysqlEnum("method", PAYMENT_METHODS).notNull(),
    status: mysqlEnum("status", PAYMENT_RECORD_STATUSES).notNull().default("succeeded"),
    amountMinor: amountMinorColumn("amount_minor").notNull(),
    currency: currencyColumn("currency").notNull(),
    /** Staff-entered payment reference or provider charge/payment-intent reference (non-secret). */
    reference: varchar("reference", { length: 128 }).notNull(),
    /** Optional AES-256-GCM encrypted staff notes (`compliance_invoice_payments.notes:<publicId>`). */
    notesEnc: text("notes_enc"),
    receivedAt: utcDateTime("received_at").notNull(),
    recordedByUserId: refColumn("recorded_by_user_id"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    provider: varchar("provider", { length: 32 }),
    providerEventId: varchar("provider_event_id", { length: 128 }),
    origin: mysqlEnum("origin", RECORD_ORIGINS).notNull().default("portal"),
    importId: varchar("import_id", { length: 64 }),
    sourceInstallationId: varchar("source_installation_id", { length: 128 }),
    sourcePublicId: varchar("source_public_id", { length: 64 }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cmp_pmt_inv_fk",
      columns: [t.invoiceId],
      foreignColumns: [complianceInvoices.id],
    }),
    foreignKey({
      name: "cmp_pmt_rec_user_fk",
      columns: [t.recordedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cmp_pmt_idemp_uq").on(t.invoiceId, t.idempotencyKey),
    uniqueIndex("cmp_pmt_prov_evt_uq").on(t.provider, t.providerEventId),
    uniqueIndex("cmp_pmt_imp_uq").on(t.sourceInstallationId, t.sourcePublicId),
    index("cmp_pmt_inv_idx").on(t.invoiceId),
  ],
);

export const complianceInvoiceRefunds = mysqlTable(
  "compliance_invoice_refunds",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    invoiceId: refColumn("invoice_id").notNull(),
    paymentId: refColumn("payment_id").notNull(),
    amountMinor: amountMinorColumn("amount_minor").notNull(),
    currency: currencyColumn("currency").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    reference: varchar("reference", { length: 128 }).notNull(),
    /** Optional AES-256-GCM encrypted staff notes (`compliance_invoice_refunds.notes:<publicId>`). */
    notesEnc: text("notes_enc"),
    refundedAt: utcDateTime("refunded_at").notNull(),
    recordedByUserId: refColumn("recorded_by_user_id"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    provider: varchar("provider", { length: 32 }),
    providerEventId: varchar("provider_event_id", { length: 128 }),
    origin: mysqlEnum("origin", RECORD_ORIGINS).notNull().default("portal"),
    importId: varchar("import_id", { length: 64 }),
    sourceInstallationId: varchar("source_installation_id", { length: 128 }),
    sourcePublicId: varchar("source_public_id", { length: 64 }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "cmp_rfd_inv_fk",
      columns: [t.invoiceId],
      foreignColumns: [complianceInvoices.id],
    }),
    foreignKey({
      name: "cmp_rfd_pmt_fk",
      columns: [t.paymentId],
      foreignColumns: [complianceInvoicePayments.id],
    }),
    foreignKey({
      name: "cmp_rfd_rec_user_fk",
      columns: [t.recordedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("cmp_rfd_idemp_uq").on(t.invoiceId, t.idempotencyKey),
    uniqueIndex("cmp_rfd_prov_evt_uq").on(t.provider, t.providerEventId),
    uniqueIndex("cmp_rfd_imp_uq").on(t.sourceInstallationId, t.sourcePublicId),
    index("cmp_rfd_inv_idx").on(t.invoiceId),
    index("cmp_rfd_pmt_idx").on(t.paymentId),
  ],
);

/** Tracks all processed provider webhook events so duplicate deliveries remain strictly idempotent. */
export const complianceProviderEvents = mysqlTable(
  "compliance_provider_events",
  {
    id: idColumn(),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 128 }).notNull(),
    invoiceId: refColumn("invoice_id"),
    paymentPublicId: char("payment_public_id", { length: 26 }),
    refundPublicId: char("refund_public_id", { length: 26 }),
    processedAt: utcDateTime("processed_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "cmp_pevt_inv_fk",
      columns: [t.invoiceId],
      foreignColumns: [complianceInvoices.id],
    }),
    uniqueIndex("cmp_pevt_prov_evt_uq").on(t.provider, t.providerEventId),
  ],
);

/* Order policy acceptance evidence (package V, owner identity_engineer). */
export * from "./acceptanceSchema.js";
