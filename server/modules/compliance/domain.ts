import { createHash } from "node:crypto";
import { z } from "zod";
import { validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  INTAKE_FIELD_TYPES,
  INTAKE_SCOPE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  POLICY_ACCEPTANCE_METHODS,
  POLICY_AUDIENCES,
  POLICY_CONTENT_FORMATS,
  type InvoiceStatus,
  type StoredIntakeFieldDef,
} from "./schema.js";

/* ----------------------------------------------------- normalization & ids */

export function normalizeNfc(value: string): string {
  return value.normalize("NFC");
}

export function normalizePolicyBody(body: string): string {
  return body.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

export function hashPolicyContent(normalizedBody: string): string {
  return createHash("sha256").update(normalizedBody, "utf8").digest("hex");
}

export function normalizeSignerComparison(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

/** Normalized NFC + trimmed string validated AFTER normalization so whitespace-only strings never pass min(). */
function nfcTrimmedString(min: number, max: number) {
  return z
    .string()
    .max(max * 2)
    .transform((s) => s.normalize("NFC").trim())
    .pipe(z.string().min(min).max(max));
}

const MAX_POLICY_BODY_BYTES = 180_000; // Fits safely inside the 256 KiB HTTP JSON cap and MEDIUMTEXT
const MAX_SERIALIZED_INTAKE_ANSWERS_BYTES = 160_000;

const policyBodySchema = z
  .string()
  .max(MAX_POLICY_BODY_BYTES)
  .transform(normalizePolicyBody)
  .pipe(
    z
      .string()
      .min(10, "Policy body must be at least 10 characters.")
      .max(120_000)
      .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_POLICY_BODY_BYTES, "Policy body exceeds maximum UTF-8 byte size."),
  );

const RESERVED_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

export const publicIdSchema = z.string().regex(ULID_PATTERN, "Invalid identifier.");
export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must contain lowercase letters, numbers, and hyphens.");
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO 4217 code.");
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "Invalid SHA-256 digest.");

/* ----------------------------------------------------------- cursor helper */

export interface IdCursor {
  id: number;
}

export function encodeIdCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

export function decodeIdCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  if (cursor.length > 128) throw validation("INVALID_CURSOR", "Pagination cursor is not valid.");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.hasOwn(parsed, "id") &&
      typeof (parsed as { id: unknown }).id === "number" &&
      Number.isSafeInteger((parsed as { id: number }).id) &&
      (parsed as { id: number }).id > 0
    ) {
      return (parsed as { id: number }).id;
    }
  } catch {
    // Fall through to uniform validation error.
  }
  throw validation("INVALID_CURSOR", "Pagination cursor is not valid.");
}

/* ---------------------------------------------------------- policy schemas */

export const createPolicyDocumentSchema = z.strictObject({
  slug: slugSchema,
  title: nfcTrimmedString(2, 160),
  audience: z.enum(POLICY_AUDIENCES).default("customer"),
  requiresAcceptance: z.boolean().default(true),
  requiresTypedSignature: z.boolean().default(false),
  versionLabel: nfcTrimmedString(1, 32),
  contentFormat: z.enum(POLICY_CONTENT_FORMATS).default("safe_markdown"),
  bodyText: policyBodySchema,
  changeSummary: nfcTrimmedString(0, 500).optional(),
  effectiveAt: z.coerce.date().optional(),
});

export const updatePolicyDocumentSchema = z.strictObject({
  documentPublicId: publicIdSchema,
  expectedVersion: z.number().int().min(1),
  title: nfcTrimmedString(2, 160),
  audience: z.enum(POLICY_AUDIENCES),
  requiresAcceptance: z.boolean(),
  requiresTypedSignature: z.boolean(),
  active: z.boolean(),
});

export const createPolicyDraftSchema = z.strictObject({
  documentPublicId: publicIdSchema,
  versionLabel: nfcTrimmedString(1, 32),
  contentFormat: z.enum(POLICY_CONTENT_FORMATS).default("safe_markdown"),
  bodyText: policyBodySchema,
  changeSummary: nfcTrimmedString(0, 500).optional(),
  effectiveAt: z.coerce.date().optional(),
});

export const updatePolicyDraftSchema = z.strictObject({
  versionPublicId: publicIdSchema,
  versionLabel: nfcTrimmedString(1, 32),
  contentFormat: z.enum(POLICY_CONTENT_FORMATS),
  bodyText: policyBodySchema,
  changeSummary: nfcTrimmedString(0, 500).optional(),
  effectiveAt: z.coerce.date(),
});

export const acceptPolicySchema = z.strictObject({
  versionPublicId: publicIdSchema,
  contentHash: sha256HexSchema,
  /** Optional UI hint; the server derives the authoritative acceptance method from the locked policy document. */
  method: z.enum(["portal_checkbox", "typed_signature"]).optional(),
  signerName: nfcTrimmedString(1, 160).optional(),
  orderPublicId: publicIdSchema.optional(),
});

export const policyAcceptanceMethodSchema = z.enum(POLICY_ACCEPTANCE_METHODS);

/* ---------------------------------------------------------- intake schemas */

export const intakeFieldOptionSchema = z.strictObject({
  value: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "Option value must be alphanumeric, underscore, or hyphen."),
  label: nfcTrimmedString(1, 160),
});

export const intakeFieldDefSchema = z
  .strictObject({
    key: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, "Field key must start with a lowercase letter and use [a-z0-9_].")
      .refine((k) => !RESERVED_OBJECT_KEYS.has(k), "Field key cannot use a reserved identifier."),
    section: nfcTrimmedString(1, 120).optional(),
    label: nfcTrimmedString(1, 240),
    helpText: nfcTrimmedString(0, 500).optional(),
    type: z.enum(INTAKE_FIELD_TYPES),
    required: z.boolean().default(true),
    sensitive: z.boolean().default(true),
    minLength: z.number().int().min(0).max(8_000).optional(),
    maxLength: z.number().int().min(1).max(8_000).optional(),
    options: z.array(intakeFieldOptionSchema).min(1).max(50).optional(),
    minNumber: z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000).optional(),
    maxNumber: z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000).optional(),
    minSelections: z.number().int().min(0).max(50).optional(),
    maxSelections: z.number().int().min(1).max(50).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "short_text" && (field.maxLength ?? 500) > 500) {
      ctx.addIssue({ code: "custom", message: "Short text maxLength cannot exceed 500." });
    }
    if ((field.type === "short_text" || field.type === "long_text") && field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
      ctx.addIssue({ code: "custom", message: "minLength cannot exceed maxLength." });
    }
    if (field.type === "single_choice" || field.type === "multi_choice") {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({ code: "custom", message: "Choice fields require at least one option." });
      } else {
        const seen = new Set<string>();
        for (const opt of field.options) {
          if (seen.has(opt.value)) {
            ctx.addIssue({ code: "custom", message: `Duplicate option value "${opt.value}".` });
            break;
          }
          seen.add(opt.value);
        }
      }
    }
    if (field.type === "number" && field.minNumber !== undefined && field.maxNumber !== undefined && field.minNumber > field.maxNumber) {
      ctx.addIssue({ code: "custom", message: "minNumber cannot exceed maxNumber." });
    }
    if (field.type === "multi_choice" && field.minSelections !== undefined && field.maxSelections !== undefined && field.minSelections > field.maxSelections) {
      ctx.addIssue({ code: "custom", message: "minSelections cannot exceed maxSelections." });
    }
  });

export const intakeFieldsArraySchema = z
  .array(intakeFieldDefSchema)
  .min(1)
  .max(40)
  .superRefine((fields, ctx) => {
    const keys = new Set<string>();
    for (const field of fields) {
      if (keys.has(field.key)) {
        ctx.addIssue({ code: "custom", message: `Duplicate field key "${field.key}".` });
      }
      keys.add(field.key);
    }
  });

export function canonicalizeIntakeFields(fields: readonly StoredIntakeFieldDef[]): StoredIntakeFieldDef[] {
  return fields.map((f) => ({
    key: f.key,
    ...(f.section ? { section: f.section } : {}),
    label: f.label,
    ...(f.helpText ? { helpText: f.helpText } : {}),
    type: f.type,
    required: f.required,
    sensitive: f.sensitive,
    ...(f.minLength !== undefined ? { minLength: f.minLength } : {}),
    ...(f.maxLength !== undefined
      ? { maxLength: f.maxLength }
      : f.type === "short_text"
        ? { maxLength: 500 }
        : f.type === "long_text"
          ? { maxLength: 8000 }
          : {}),
    ...(f.options ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    ...(f.minNumber !== undefined ? { minNumber: f.minNumber } : {}),
    ...(f.maxNumber !== undefined ? { maxNumber: f.maxNumber } : {}),
    ...(f.minSelections !== undefined ? { minSelections: f.minSelections } : {}),
    ...(f.maxSelections !== undefined ? { maxSelections: f.maxSelections } : {}),
  }));
}

export function hashQuestionnaireFields(fields: readonly StoredIntakeFieldDef[]): string {
  const canonical = canonicalizeIntakeFields(fields);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export type IntakeAnswerValue = string | number | readonly string[] | null;
export type IntakeAnswerMap = Record<string, IntakeAnswerValue>;

export const intakeAnswerValueSchema = z.union([
  z.string().max(8_000),
  z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000),
  z.array(z.string().max(64)).max(50),
  z.null(),
]);

export const intakeAnswersRecordSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .refine((k) => !RESERVED_OBJECT_KEYS.has(k), "Reserved answer key is not allowed."),
    intakeAnswerValueSchema,
  )
  .refine((rec) => Object.keys(rec).length <= 40, "Too many intake answer keys.")
  .refine(
    (rec) => Buffer.byteLength(JSON.stringify(rec), "utf8") <= MAX_SERIALIZED_INTAKE_ANSWERS_BYTES,
    "Aggregate intake answers exceed maximum allowed size.",
  );

const ISO_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validates intake answers against the bound questionnaire version.
 * - Uses `Object.hasOwn` exclusively and builds a null-prototype accumulator before returning a clean plain object,
 *   preventing `Object.prototype` property reads (e.g. `constructor`).
 * - Enforces aggregate UTF-8 byte budget so encrypted snapshots never overflow persistence or HTTP body bounds.
 */
export function validateIntakeAnswers(
  fields: readonly StoredIntakeFieldDef[],
  rawAnswers: IntakeAnswerMap,
  mode: "draft" | "submit",
): IntakeAnswerMap {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(rawAnswers)) {
    if (RESERVED_OBJECT_KEYS.has(key) || !byKey.has(key)) {
      throw validation("UNKNOWN_INTAKE_FIELD", `Unrecognized intake question "${key}".`, { field: key });
    }
  }

  const acc: Record<string, IntakeAnswerValue> = Object.create(null) as Record<string, IntakeAnswerValue>;
  const missingFields: string[] = [];

  for (const field of fields) {
    if (RESERVED_OBJECT_KEYS.has(field.key)) {
      throw validation("INVALID_INTAKE_KEY", "Intake field key is reserved.", { field: field.key });
    }
    const raw = Object.hasOwn(rawAnswers, field.key) ? rawAnswers[field.key] : undefined;
    const isEmpty =
      raw === undefined ||
      raw === null ||
      (typeof raw === "string" && raw.trim().length === 0) ||
      (Array.isArray(raw) && raw.length === 0);

    if (isEmpty) {
      if (mode === "submit" && field.required) {
        missingFields.push(field.key);
      }
      acc[field.key] = null;
      continue;
    }

    switch (field.type) {
      case "short_text":
      case "long_text": {
        if (typeof raw !== "string") {
          throw validation("INVALID_INTAKE_TYPE", `Answer for "${field.label}" must be text.`, { field: field.key });
        }
        const norm = normalizeNfc(raw).trim();
        const maxLen = field.maxLength ?? (field.type === "short_text" ? 500 : 8000);
        if (norm.length > maxLen) {
          throw validation("INTAKE_ANSWER_TOO_LONG", `Answer for "${field.label}" exceeds ${maxLen} characters.`, {
            field: field.key,
            maxLength: maxLen,
          });
        }
        if (mode === "submit" && field.minLength !== undefined && norm.length < field.minLength) {
          throw validation(
            "INTAKE_ANSWER_TOO_SHORT",
            `Answer for "${field.label}" must be at least ${field.minLength} characters.`,
            { field: field.key, minLength: field.minLength },
          );
        }
        acc[field.key] = norm;
        break;
      }
      case "single_choice": {
        if (typeof raw !== "string") {
          throw validation("INVALID_INTAKE_TYPE", `Answer for "${field.label}" must be a single selection.`, {
            field: field.key,
          });
        }
        const allowed = new Set((field.options ?? []).map((o) => o.value));
        if (!allowed.has(raw)) {
          throw validation("INVALID_INTAKE_OPTION", `Selected option for "${field.label}" is not valid.`, {
            field: field.key,
          });
        }
        acc[field.key] = raw;
        break;
      }
      case "multi_choice": {
        if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === "string")) {
          throw validation("INVALID_INTAKE_TYPE", `Answer for "${field.label}" must be a list of selections.`, {
            field: field.key,
          });
        }
        const allowed = new Set((field.options ?? []).map((o) => o.value));
        const deduped = Array.from(new Set(raw));
        for (const item of deduped) {
          if (!allowed.has(item)) {
            throw validation("INVALID_INTAKE_OPTION", `Selected option for "${field.label}" is not valid.`, {
              field: field.key,
            });
          }
        }
        if (field.maxSelections !== undefined && deduped.length > field.maxSelections) {
          throw validation(
            "INTAKE_TOO_MANY_SELECTIONS",
            `Select at most ${field.maxSelections} options for "${field.label}".`,
            { field: field.key },
          );
        }
        if (mode === "submit" && field.minSelections !== undefined && deduped.length < field.minSelections) {
          throw validation(
            "INTAKE_TOO_FEW_SELECTIONS",
            `Select at least ${field.minSelections} options for "${field.label}".`,
            { field: field.key },
          );
        }
        acc[field.key] = deduped;
        break;
      }
      case "date": {
        if (typeof raw !== "string" || !isValidIsoCalendarDate(raw)) {
          throw validation("INVALID_INTAKE_DATE", `Answer for "${field.label}" must be a valid YYYY-MM-DD date.`, {
            field: field.key,
          });
        }
        acc[field.key] = raw;
        break;
      }
      case "number": {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          throw validation("INVALID_INTAKE_NUMBER", `Answer for "${field.label}" must be a valid number.`, {
            field: field.key,
          });
        }
        if (field.maxNumber !== undefined && raw > field.maxNumber) {
          throw validation("INTAKE_NUMBER_OUT_OF_RANGE", `Answer for "${field.label}" exceeds maximum ${field.maxNumber}.`, {
            field: field.key,
          });
        }
        if (mode === "submit" && field.minNumber !== undefined && raw < field.minNumber) {
          throw validation("INTAKE_NUMBER_OUT_OF_RANGE", `Answer for "${field.label}" is below minimum ${field.minNumber}.`, {
            field: field.key,
          });
        }
        acc[field.key] = raw;
        break;
      }
    }
  }

  if (missingFields.length > 0) {
    throw validation("INTAKE_REQUIRED_FIELDS_MISSING", "Please complete all required intake questions before submitting.", {
      missingFields,
    });
  }

  const cleaned: IntakeAnswerMap = { ...acc };
  if (Buffer.byteLength(JSON.stringify(cleaned), "utf8") > MAX_SERIALIZED_INTAKE_ANSWERS_BYTES) {
    throw validation("INTAKE_PAYLOAD_TOO_LARGE", "Aggregate intake answers exceed maximum allowed size.");
  }

  return cleaned;
}

export const createQuestionnaireSchema = z
  .strictObject({
    slug: slugSchema,
    title: nfcTrimmedString(2, 160),
    description: nfcTrimmedString(0, 1000).optional(),
    scopeKind: z.enum(INTAKE_SCOPE_KINDS).default("default"),
    scopeRef: z.string().trim().min(1).max(64).optional().nullable(),
    fields: intakeFieldsArraySchema,
  })
  .superRefine((v, ctx) => {
    if (v.scopeKind !== "default" && !v.scopeRef) {
      ctx.addIssue({ code: "custom", message: "Scoped questionnaires require scopeRef." });
    }
  });

export const updateQuestionnaireSchema = z
  .strictObject({
    questionnairePublicId: publicIdSchema,
    expectedVersion: z.number().int().min(1),
    title: nfcTrimmedString(2, 160),
    description: nfcTrimmedString(0, 1000).optional().nullable(),
    scopeKind: z.enum(INTAKE_SCOPE_KINDS),
    scopeRef: z.string().trim().min(1).max(64).optional().nullable(),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.scopeKind !== "default" && !v.scopeRef) {
      ctx.addIssue({ code: "custom", message: "Scoped questionnaires require scopeRef." });
    }
  });

export const saveQuestionnaireDraftSchema = z.strictObject({
  questionnairePublicId: publicIdSchema,
  versionPublicId: publicIdSchema.optional(),
  fields: intakeFieldsArraySchema,
});

/* ------------------------------------------- invoice arithmetic & statuses */

const MAX_MINOR_UNITS = 100_000_000_000; // $1,000,000,000.00 in cents — safe integer arithmetic

export const invoiceLineInputSchema = z.strictObject({
  description: nfcTrimmedString(1, 240),
  quantity: z.number().int().min(1).max(10_000),
  unitAmountMinor: z.number().int().min(0).max(10_000_000_000),
});

export const createInvoiceDraftSchema = z.strictObject({
  orderPublicId: publicIdSchema,
  currency: currencySchema.default("USD"),
  lines: z.array(invoiceLineInputSchema).min(1).max(100),
  discountMinor: z.number().int().min(0).max(MAX_MINOR_UNITS).default(0),
  taxMinor: z.number().int().min(0).max(MAX_MINOR_UNITS).default(0),
  dueAt: z.coerce.date().optional().nullable(),
  memo: nfcTrimmedString(0, 1000).optional().nullable(),
});

export const updateInvoiceDraftSchema = z.strictObject({
  invoicePublicId: publicIdSchema,
  expectedVersion: z.number().int().min(1),
  currency: currencySchema,
  lines: z.array(invoiceLineInputSchema).min(1).max(100),
  discountMinor: z.number().int().min(0).max(MAX_MINOR_UNITS).default(0),
  taxMinor: z.number().int().min(0).max(MAX_MINOR_UNITS).default(0),
  dueAt: z.coerce.date().optional().nullable(),
  memo: nfcTrimmedString(0, 1000).optional().nullable(),
});

export const recordManualPaymentSchema = z.strictObject({
  invoicePublicId: publicIdSchema,
  method: z.enum(PAYMENT_METHODS).refine((m) => m !== "provider_online", "Manual payments cannot claim online provider method."),
  amountMinor: z.number().int().min(1).max(MAX_MINOR_UNITS),
  currency: currencySchema,
  reference: nfcTrimmedString(1, 128),
  notes: nfcTrimmedString(0, 500).optional(),
  receivedAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const recordRefundSchema = z.strictObject({
  invoicePublicId: publicIdSchema,
  paymentPublicId: publicIdSchema,
  amountMinor: z.number().int().min(1).max(MAX_MINOR_UNITS),
  currency: currencySchema,
  reasonCode: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Reason code must be UPPER_SNAKE."),
  reference: nfcTrimmedString(1, 128),
  notes: nfcTrimmedString(0, 500).optional(),
  refundedAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);

export interface ComputedInvoiceLine {
  position: number;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  lineTotalMinor: number;
}

export interface ComputedInvoiceTotals {
  lines: ComputedInvoiceLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * Pure integer minor-unit invoice calculation. Rejects any overflow, negative subtotal/total,
 * or discount exceeding subtotal. Never uses floating-point division or multiplication.
 */
export function computeInvoiceTotals(input: {
  lines: readonly { description: string; quantity: number; unitAmountMinor: number }[];
  discountMinor: number;
  taxMinor: number;
}): ComputedInvoiceTotals {
  if (!Number.isSafeInteger(input.discountMinor) || input.discountMinor < 0) {
    throw validation("INVALID_MONEY_AMOUNT", "Discount must be a non-negative integer in minor units.");
  }
  if (!Number.isSafeInteger(input.taxMinor) || input.taxMinor < 0) {
    throw validation("INVALID_MONEY_AMOUNT", "Tax must be a non-negative integer in minor units.");
  }

  let subtotalMinor = 0;
  const computedLines: ComputedInvoiceLine[] = input.lines.map((line, index) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw validation("INVALID_LINE_QUANTITY", "Line item quantity must be a positive integer.");
    }
    if (!Number.isSafeInteger(line.unitAmountMinor) || line.unitAmountMinor < 0) {
      throw validation("INVALID_MONEY_AMOUNT", "Unit price must be a non-negative integer in minor units.");
    }
    const lineTotalMinor = line.quantity * line.unitAmountMinor;
    if (!Number.isSafeInteger(lineTotalMinor) || lineTotalMinor > MAX_MINOR_UNITS) {
      throw validation("MONEY_OVERFLOW", "Line item total exceeds supported bounds.");
    }
    subtotalMinor += lineTotalMinor;
    if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor > MAX_MINOR_UNITS) {
      throw validation("MONEY_OVERFLOW", "Invoice subtotal exceeds supported bounds.");
    }
    return {
      position: index + 1,
      description: line.description,
      quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor,
      lineTotalMinor,
    };
  });

  if (input.discountMinor > subtotalMinor) {
    throw validation("DISCOUNT_EXCEEDS_SUBTOTAL", "Discount cannot exceed the invoice subtotal.");
  }

  const totalMinor = subtotalMinor - input.discountMinor + input.taxMinor;
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || totalMinor > MAX_MINOR_UNITS) {
    throw validation("MONEY_OVERFLOW", "Invoice total exceeds supported bounds.");
  }

  return {
    lines: computedLines,
    subtotalMinor,
    discountMinor: input.discountMinor,
    taxMinor: input.taxMinor,
    totalMinor,
  };
}

/**
 * Deterministic derivation of invoice status from recorded issuance, void, payment and refund evidence.
 * Invoice status is NEVER set arbitrarily by a status-dropdown mutation.
 */
export function deriveInvoiceStatus(evidence: {
  issuedAt: Date | null;
  voidedAt: Date | null;
  totalMinor: number;
  grossPaidMinor: number;
  refundedMinor: number;
}): InvoiceStatus {
  if (evidence.voidedAt !== null) return "void";
  if (evidence.issuedAt === null) return "draft";
  const netPaidMinor = evidence.grossPaidMinor - evidence.refundedMinor;
  if (evidence.totalMinor === 0) return "paid";
  return netPaidMinor >= evidence.totalMinor ? "paid" : "issued";
}

export function formatInvoiceNumber(prefix: string, issuedAt: Date, sequenceNumber: number): string {
  return `${prefix}-${issuedAt.getUTCFullYear()}-${String(sequenceNumber).padStart(6, "0")}`;
}
