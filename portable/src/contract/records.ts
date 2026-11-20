/**
 * Portable contract v3 record schemas (normative). One JSON object per line in `records/<type>.jsonl`.
 *
 * Rules shared by every record:
 *  - `publicId` is the stable portable identifier (ULID). Installation-local numeric ids never appear.
 *  - References are `<thing>PublicId` fields and must resolve inside the package, or be declared in
 *    `manifest.dependencyClosure.external`.
 *  - Money is `{ amountMinor, currency }` (integer minor units). Times are RFC 3339 UTC.
 *  - `heldUnknown` preserves producer fields the contract does not model. It is inert evidence: a reader
 *    must never interpret it as policy or code.
 *  - Objects are strict: unknown keys fail validation for same-minor packages (see unknown-field policy in
 *    portable/docs/CONTRACT.md).
 */
import { z } from "zod";
import {
  Actor,
  Currency,
  DisplayFileName,
  HeldUnknown,
  Money,
  PublicId,
  ReasonCode,
  Sha256Hex,
  Token,
  UtcTime,
  text,
} from "./primitives.js";

const base = {
  publicId: PublicId,
  heldUnknown: HeldUnknown.optional(),
};

export const CustomerRecord = z.strictObject({
  ...base,
  /** Mutable human-facing customer number (not identity). */
  customerNumber: text(64, 1).nullable(),
  status: Token,
  /** Contact e-mail of the business profile. Imported profiles never become sign-in identities automatically. */
  email: z.email().max(254),
  firstName: text(255).nullable(),
  middleName: text(255).nullable(),
  lastName: text(255).nullable(),
  preferredName: text(255).nullable(),
  suffix: text(255).nullable(),
  company: text(255).nullable(),
  phone: text(255).nullable(),
  address: text(1000).nullable(),
  timezone: text(64, 1).nullable(),
  locale: text(35).nullable(),
  marketingOptIn: z.boolean(),
  customFields: z
    .array(z.strictObject({ key: Token, label: text(255).nullable(), value: text(4000).nullable() }))
    .max(200)
    .optional(),
  /** null = unknown (legacy v1/v2 packages did not carry it). */
  createdAt: UtcTime.nullable(),
  updatedAt: UtcTime.nullable(),
});

export const OrderRecord = z.strictObject({
  ...base,
  customerPublicId: PublicId,
  orderNumber: text(64, 1),
  projectName: text(500).nullable(),
  status: Token,
  paymentStatus: Token,
  paymentRequirement: Token.nullable(),
  currency: Currency,
  subtotal: Money,
  discount: Money,
  total: Money,
  isTestOrder: z.boolean(),
  /** Read-only lock state; null = unknown (legacy). Importers default to read-only regardless. */
  lock: z.strictObject({ readOnly: z.boolean(), reasonCode: ReasonCode.nullable() }).nullable(),
  completionPercent: z.int().min(0).max(100).nullable(),
  /** Staff-only notes. Never shown to customers by a conforming importer. */
  internalNotes: text(20_000).nullable(),
  /** When the customer submitted the order (null = draft / unknown). Optional in 3.0. */
  submittedAt: UtcTime.nullable().optional(),
  dueAt: UtcTime.nullable(),
  deliveredAt: UtcTime.nullable(),
  closedAt: UtcTime.nullable(),
  createdAt: UtcTime,
  updatedAt: UtcTime.nullable(),
});

export const OrderItemRecord = z.strictObject({
  ...base,
  orderPublicId: PublicId,
  position: z.int().min(0).max(10_000),
  sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  name: text(255, 1),
  tier: Token.nullable(),
  quantity: z.int().min(1).max(1_000_000),
  unitPrice: Money,
  lineTotal: Money,
});

export const OrderStatusHistoryRecord = z.strictObject({
  ...base,
  orderPublicId: PublicId,
  fromStatus: Token.nullable(),
  toStatus: Token,
  reasonCode: ReasonCode.nullable(),
  note: text(1000).nullable(),
  actor: Actor,
  occurredAt: UtcTime,
});

export const OrderShareRecord = z.strictObject({
  ...base,
  orderPublicId: PublicId,
  granteeCustomerPublicId: PublicId,
  access: z.enum(["read", "comment", "write"]),
  grantedBy: Actor,
  grantedAt: UtcTime,
  expiresAt: UtcTime.nullable(),
  revokedAt: UtcTime.nullable(),
});

export const FileRecord = z.strictObject({
  ...base,
  orderPublicId: PublicId,
  category: Token,
  phase: Token.nullable(),
  visibleToCustomer: z.boolean(),
  createdAt: UtcTime,
  deletedAt: UtcTime.nullable(),
});

export const FileVersionRecord = z.strictObject({
  ...base,
  filePublicId: PublicId,
  version: z.int().min(1).max(100_000),
  /** Display name only (no path). Untrusted: importers re-validate type and name. */
  originalName: DisplayFileName,
  /** Declared media type (untrusted metadata; targets re-classify bytes). */
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/),
  extension: z.string().regex(/^[a-z0-9]{1,16}$/).nullable(),
  sizeBytes: z.int().min(0),
  /** SHA-256 of the bytes; the object is stored at `objects/<sha256>`. */
  sha256: Sha256Hex,
  durationSeconds: z.number().min(0).max(864_000).nullable(),
  uploadedBy: Actor,
  createdAt: UtcTime,
});

export const MessageThreadRecord = z.strictObject({
  ...base,
  customerPublicId: PublicId,
  orderPublicId: PublicId.nullable(),
  subject: text(500),
  createdAt: UtcTime,
  closedAt: UtcTime.nullable(),
});

export const MessageRecord = z.strictObject({
  ...base,
  threadPublicId: PublicId,
  author: Actor,
  body: text(65_536),
  attachmentFileVersionPublicIds: z.array(PublicId).max(50),
  sentAt: UtcTime,
  editedAt: UtcTime.nullable(),
});

export const TicketRecord = z.strictObject({
  ...base,
  customerPublicId: PublicId,
  orderPublicId: PublicId.nullable(),
  ticketNumber: text(64).nullable(),
  subject: text(500),
  status: Token,
  priority: Token.nullable(),
  category: Token.nullable(),
  createdAt: UtcTime,
  closedAt: UtcTime.nullable(),
});

export const TicketCommentRecord = z.strictObject({
  ...base,
  ticketPublicId: PublicId,
  author: Actor,
  body: text(65_536),
  /** Staff-internal comment; never shown to customers. */
  internal: z.boolean(),
  createdAt: UtcTime,
});

export const PolicyVersionRecord = z.strictObject({
  ...base,
  policyKey: Token,
  version: text(64, 1),
  title: text(500),
  contentSha256: Sha256Hex,
  /** Optional verbatim text (plain/markdown). Historical evidence, not rendered as HTML. */
  contentText: text(500_000).nullable(),
  effectiveAt: UtcTime,
  retiredAt: UtcTime.nullable(),
});

export const PolicyAcceptanceRecord = z.strictObject({
  ...base,
  policyVersionPublicId: PublicId,
  customerPublicId: PublicId,
  orderPublicId: PublicId.nullable(),
  method: Token,
  acceptedAt: UtcTime,
  /** Statement of authenticity as recorded by the source; never re-executed or upgraded. */
  evidenceNote: text(1000).nullable(),
});

const IntakeAnswerValue = z.union([
  text(20_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(text(1000)).max(100),
]);

export const IntakeDefinitionRecord = z.strictObject({
  ...base,
  key: Token,
  version: z.int().min(1).max(100_000),
  title: text(500),
  questions: z
    .array(
      z.strictObject({
        key: Token,
        label: text(1000),
        kind: Token,
        required: z.boolean(),
        options: z.array(text(500)).max(200).nullable(),
      }),
    )
    .max(500),
  createdAt: UtcTime,
});

export const IntakeSubmissionRecord = z.strictObject({
  ...base,
  definitionPublicId: PublicId,
  orderPublicId: PublicId,
  customerPublicId: PublicId.nullable(),
  status: Token,
  answers: z.array(z.strictObject({ questionKey: Token, value: IntakeAnswerValue })).max(500),
  submittedAt: UtcTime.nullable(),
});

const ProviderReference = z.strictObject({ provider: Token, reference: text(128, 1) }).nullable();

export const InvoiceRecord = z.strictObject({
  ...base,
  customerPublicId: PublicId,
  orderPublicId: PublicId.nullable(),
  invoiceNumber: text(64, 1),
  status: Token,
  currency: Currency,
  lines: z
    .array(z.strictObject({ description: text(500), quantity: z.int().min(1), unitPrice: Money, total: Money }))
    .max(500),
  subtotal: Money,
  tax: Money,
  total: Money,
  issuedAt: UtcTime.nullable(),
  dueAt: UtcTime.nullable(),
  /** Historical provider reference; a conforming importer must never replay provider actions. */
  providerReference: ProviderReference,
});

export const PaymentRecord = z.strictObject({
  ...base,
  customerPublicId: PublicId,
  invoicePublicId: PublicId.nullable(),
  orderPublicId: PublicId.nullable(),
  amount: Money,
  method: Token,
  status: Token,
  receivedAt: UtcTime.nullable(),
  providerReference: ProviderReference,
});

export const RefundRecord = z.strictObject({
  ...base,
  paymentPublicId: PublicId,
  amount: Money,
  status: Token,
  reasonCode: ReasonCode.nullable(),
  refundedAt: UtcTime.nullable(),
  providerReference: ProviderReference,
});

export const RECORD_TYPE_ORDER = [
  "customers",
  "orders",
  "order-items",
  "order-status-history",
  "order-shares",
  "files",
  "file-versions",
  "message-threads",
  "messages",
  "tickets",
  "ticket-comments",
  "policy-versions",
  "policy-acceptances",
  "intake-definitions",
  "intake-submissions",
  "invoices",
  "payments",
  "refunds",
  "provenance",
] as const;
export type RecordType = (typeof RECORD_TYPE_ORDER)[number];
export const RecordTypeSchema = z.enum(RECORD_TYPE_ORDER);

export const ProvenanceRecord = z.strictObject({
  ...base,
  subjectType: RecordTypeSchema,
  subjectPublicId: PublicId,
  sourceSystemPseudonym: text(64, 1),
  /** Source-side record kind, e.g. `order`, `legacy-v2:file`. */
  sourceRecordType: text(64, 1),
  /** Opaque source reference (never a local database primary key in v3 producers). */
  sourceReference: text(128, 1),
  transformation: z.strictObject({ adapter: text(64, 1), version: text(32, 1) }).nullable(),
  notes: z.array(ReasonCode).max(50),
});

export const RECORD_SCHEMAS = {
  customers: CustomerRecord,
  orders: OrderRecord,
  "order-items": OrderItemRecord,
  "order-status-history": OrderStatusHistoryRecord,
  "order-shares": OrderShareRecord,
  files: FileRecord,
  "file-versions": FileVersionRecord,
  "message-threads": MessageThreadRecord,
  messages: MessageRecord,
  tickets: TicketRecord,
  "ticket-comments": TicketCommentRecord,
  "policy-versions": PolicyVersionRecord,
  "policy-acceptances": PolicyAcceptanceRecord,
  "intake-definitions": IntakeDefinitionRecord,
  "intake-submissions": IntakeSubmissionRecord,
  invoices: InvoiceRecord,
  payments: PaymentRecord,
  refunds: RefundRecord,
  provenance: ProvenanceRecord,
} as const satisfies Record<RecordType, z.ZodType>;

export type RecordOf<T extends RecordType> = z.infer<(typeof RECORD_SCHEMAS)[T]>;
export type AnyRecord = { [T in RecordType]: RecordOf<T> }[RecordType];

/** Contract module each record type belongs to (core is always required; history modules are optional). */
export const RECORD_MODULE: Record<RecordType, "core" | "engagement" | "compliance" | "billing"> = {
  customers: "core",
  orders: "core",
  "order-items": "core",
  "order-status-history": "core",
  "order-shares": "core",
  files: "core",
  "file-versions": "core",
  "message-threads": "engagement",
  messages: "engagement",
  tickets: "engagement",
  "ticket-comments": "engagement",
  "policy-versions": "compliance",
  "policy-acceptances": "compliance",
  "intake-definitions": "compliance",
  "intake-submissions": "compliance",
  invoices: "billing",
  payments: "billing",
  refunds: "billing",
  provenance: "core",
};

export interface ReferenceSpec {
  field: string;
  target: RecordType;
  nullable: boolean;
  array?: boolean;
}

/** Reference graph. Every reference points to an earlier type in RECORD_TYPE_ORDER (topological). */
export const REFERENCES: Record<RecordType, ReferenceSpec[]> = {
  customers: [],
  orders: [{ field: "customerPublicId", target: "customers", nullable: false }],
  "order-items": [{ field: "orderPublicId", target: "orders", nullable: false }],
  "order-status-history": [{ field: "orderPublicId", target: "orders", nullable: false }],
  "order-shares": [
    { field: "orderPublicId", target: "orders", nullable: false },
    { field: "granteeCustomerPublicId", target: "customers", nullable: false },
  ],
  files: [{ field: "orderPublicId", target: "orders", nullable: false }],
  "file-versions": [{ field: "filePublicId", target: "files", nullable: false }],
  "message-threads": [
    { field: "customerPublicId", target: "customers", nullable: false },
    { field: "orderPublicId", target: "orders", nullable: true },
  ],
  messages: [
    { field: "threadPublicId", target: "message-threads", nullable: false },
    { field: "attachmentFileVersionPublicIds", target: "file-versions", nullable: false, array: true },
  ],
  tickets: [
    { field: "customerPublicId", target: "customers", nullable: false },
    { field: "orderPublicId", target: "orders", nullable: true },
  ],
  "ticket-comments": [{ field: "ticketPublicId", target: "tickets", nullable: false }],
  "policy-versions": [],
  "policy-acceptances": [
    { field: "policyVersionPublicId", target: "policy-versions", nullable: false },
    { field: "customerPublicId", target: "customers", nullable: false },
    { field: "orderPublicId", target: "orders", nullable: true },
  ],
  "intake-definitions": [],
  "intake-submissions": [
    { field: "definitionPublicId", target: "intake-definitions", nullable: false },
    { field: "orderPublicId", target: "orders", nullable: false },
    { field: "customerPublicId", target: "customers", nullable: true },
  ],
  invoices: [
    { field: "customerPublicId", target: "customers", nullable: false },
    { field: "orderPublicId", target: "orders", nullable: true },
  ],
  payments: [
    { field: "customerPublicId", target: "customers", nullable: false },
    { field: "invoicePublicId", target: "invoices", nullable: true },
    { field: "orderPublicId", target: "orders", nullable: true },
  ],
  refunds: [{ field: "paymentPublicId", target: "payments", nullable: false }],
  provenance: [], // subjectPublicId is checked dynamically against subjectType
};

/** Yield every (targetType, publicId) a record references. */
export function referencesOf(type: RecordType, record: Record<string, unknown>): Array<[RecordType, string]> {
  const out: Array<[RecordType, string]> = [];
  for (const spec of REFERENCES[type]) {
    const v = record[spec.field];
    if (spec.array && Array.isArray(v)) for (const id of v) out.push([spec.target, String(id)]);
    else if (typeof v === "string") out.push([spec.target, v]);
  }
  if (type === "provenance") out.push([record.subjectType as RecordType, String(record.subjectPublicId)]);
  return out;
}

/** Top-level keys known to the schema of a type (used by the unknown-field policy). */
export function knownKeys(type: RecordType): ReadonlySet<string> {
  return new Set(Object.keys(RECORD_SCHEMAS[type].shape));
}
