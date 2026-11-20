/**
 * Compliance console — shared types, labels and pure helpers. Owner: orders_engineer (compliance admin UI).
 * Types are inferred from the server router so the console never drifts from the API.
 */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";

type Out = inferRouterOutputs<AppRouter>["compliance"];
type In = inferRouterInputs<AppRouter>["compliance"];

export type PolicyDocumentSummary = Out["policies"]["admin"]["listDocuments"][number];
export type PolicyDocumentDetail = Out["policies"]["admin"]["getDocument"];
export type PolicyVersion = PolicyDocumentDetail["versions"][number];
export type PolicyAcceptance = Out["policies"]["admin"]["listAcceptances"]["items"][number];
export type PolicyAudience = PolicyDocumentSummary["audience"];
export type PolicyFormat = PolicyVersion["contentFormat"];

export type QuestionnaireSummary = Out["intake"]["admin"]["listQuestionnaires"][number];
export type QuestionnaireDetail = Out["intake"]["admin"]["getQuestionnaire"];
export type IntakeFieldInput = In["intake"]["admin"]["saveDraftVersion"]["fields"][number];
export type IntakeFieldType = IntakeFieldInput["type"];
export type IntakeScopeKind = QuestionnaireSummary["scopeKind"];
export type OrderIntakeItem = Out["intake"]["listForOrder"]["items"][number];
export type IntakeRevision = Out["intake"]["getSubmission"]["revisions"][number];

export type InvoiceSummary = Out["invoices"]["admin"]["list"]["items"][number];
export type InvoiceDetail = Out["invoices"]["get"];
export type InvoicePayment = InvoiceDetail["payments"][number];
export type ManualPaymentMethod = Exclude<In["invoices"]["admin"]["recordManualPayment"]["method"], "provider_online">;

export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
export const REASON_CODE = /^[A-Z][A-Z0-9_]*$/;
export const CURRENCY = /^[A-Z]{3}$/;

export const AUDIENCE_LABELS: Record<PolicyAudience, string> = { all: "Everyone", customer: "Customers", staff: "Staff and admins" };
export const FORMAT_LABELS: Record<PolicyFormat, string> = { safe_markdown: "Formatted text (safe Markdown)", plain_text: "Plain text" };
export const SCOPE_LABELS: Record<IntakeScopeKind, string> = { default: "All orders", catalog_item: "Catalog product", workflow: "Workflow" };
export const FIELD_TYPE_LABELS: Record<IntakeFieldType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  single_choice: "Single choice",
  multi_choice: "Multiple choice",
  date: "Date",
  number: "Number",
};
export const ACCEPTANCE_METHOD_LABELS: Record<PolicyAcceptance["method"], string> = {
  portal_checkbox: "Portal checkbox",
  registration: "At registration",
  typed_signature: "Typed signature",
  imported_historical: "Imported (historical)",
};
export const REVISION_EVENT_LABELS: Record<IntakeRevision["eventKind"], string> = {
  draft_saved: "Draft saved",
  submitted: "Submitted",
  returned_for_changes: "Returned for changes",
  accepted: "Accepted",
  imported: "Imported",
};
export const PAYMENT_METHOD_LABELS: Record<InvoicePayment["method"], string> = {
  bank_transfer: "Bank transfer",
  wire: "Wire",
  ach: "ACH",
  check: "Check",
  card_manual: "Card (recorded manually)",
  waiver: "Waiver",
  provider_online: "Online provider",
  imported_historical: "Imported (historical)",
  other: "Other",
};
export const MANUAL_PAYMENT_METHODS: ManualPaymentMethod[] = ["bank_transfer", "wire", "ach", "check", "card_manual", "waiver", "other"];
export const REFUND_REASONS = [
  { value: "CUSTOMER_REQUEST", label: "Customer request" },
  { value: "DUPLICATE_PAYMENT", label: "Duplicate payment" },
  { value: "OVERPAYMENT", label: "Overpayment" },
  { value: "SERVICE_CANCELED", label: "Service canceled" },
  { value: "CORRECTION", label: "Correction" },
];

export function money(amountMinor: number, currency: string) {
  return { amountMinor, currency };
}

/** `<input type="datetime-local">` value (local time) for a Date. */
export function toLocalInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Parses a datetime-local or date value as local time; null when empty or invalid. */
export function fromLocalInput(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value.length === 10 ? `${value}T00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function toDateInput(value: Date | string | null | undefined): string {
  return toLocalInput(value).slice(0, 10);
}

export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/** Per-version acceptance counts over the loaded evidence records. */
export function acceptanceCounts(items: readonly PolicyAcceptance[]): { versionPublicId: string; versionLabel: string; versionNumber: number; count: number; typed: number }[] {
  const byVersion = new Map<string, { versionPublicId: string; versionLabel: string; versionNumber: number; count: number; typed: number }>();
  for (const item of items) {
    const entry = byVersion.get(item.versionPublicId) ?? { versionPublicId: item.versionPublicId, versionLabel: item.versionLabel, versionNumber: item.versionNumber, count: 0, typed: 0 };
    entry.count += 1;
    if (item.hasTypedSignature) entry.typed += 1;
    byVersion.set(item.versionPublicId, entry);
  }
  return [...byVersion.values()].sort((a, b) => b.versionNumber - a.versionNumber);
}

/** Editable intake field shape used by the builder (strings for numeric inputs). */
export interface FieldDraft {
  id: string;
  key: string;
  section: string;
  label: string;
  helpText: string;
  type: IntakeFieldType;
  required: boolean;
  sensitive: boolean;
  minLength: string;
  maxLength: string;
  options: string;
  minNumber: string;
  maxNumber: string;
  minSelections: string;
  maxSelections: string;
}

let draftSeq = 0;
export function blankField(): FieldDraft {
  draftSeq += 1;
  return { id: `f${draftSeq}`, key: "", section: "", label: "", helpText: "", type: "short_text", required: true, sensitive: true, minLength: "", maxLength: "", options: "", minNumber: "", maxNumber: "", minSelections: "", maxSelections: "" };
}

type StoredField = QuestionnaireDetail["versions"][number]["fields"][number];
export function fieldToDraft(field: StoredField): FieldDraft {
  const str = (value: number | undefined | null) => (value === undefined || value === null ? "" : String(value));
  return {
    ...blankField(),
    key: field.key,
    section: field.section ?? "",
    label: field.label,
    helpText: field.helpText ?? "",
    type: field.type,
    required: field.required,
    sensitive: field.sensitive,
    minLength: str(field.minLength),
    maxLength: str(field.maxLength),
    options: (field.options ?? []).map((o) => (o.value === o.label ? o.value : `${o.value} | ${o.label}`)).join("\n"),
    minNumber: str(field.minNumber),
    maxNumber: str(field.maxNumber),
    minSelections: str(field.minSelections),
    maxSelections: str(field.maxSelections),
  };
}

/** Validates builder drafts and converts them to API field definitions, or returns the first problem. */
export function draftsToFields(drafts: readonly FieldDraft[]): { fields: IntakeFieldInput[] } | { error: string } {
  if (drafts.length < 1 || drafts.length > 40) return { error: "A questionnaire needs between 1 and 40 questions." };
  const keys = new Set<string>();
  const fields: IntakeFieldInput[] = [];
  for (const [index, d] of drafts.entries()) {
    const n = `Question ${index + 1}`;
    const key = d.key.trim();
    if (key.length < 2 || key.length > 64 || !FIELD_KEY.test(key)) return { error: `${n}: the key must be 2–64 characters, start with a lowercase letter and use only a–z, 0–9 and _.` };
    if (keys.has(key)) return { error: `${n}: the key "${key}" is already used.` };
    keys.add(key);
    if (!d.label.trim()) return { error: `${n}: enter the question text.` };
    const field: IntakeFieldInput = { key, label: d.label.trim(), type: d.type, required: d.required, sensitive: d.sensitive };
    if (d.section.trim()) field.section = d.section.trim();
    if (d.helpText.trim()) field.helpText = d.helpText.trim();
    const int = (raw: string, label: string, min: number, max: number): number | undefined | string => {
      if (!raw.trim()) return undefined;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < min || value > max) return `${n}: ${label} must be a whole number from ${min} to ${max}.`;
      return value;
    };
    if (d.type === "short_text" || d.type === "long_text") {
      const limit = d.type === "short_text" ? 500 : 8000;
      const min = int(d.minLength, "minimum length", 0, limit);
      const max = int(d.maxLength, "maximum length", 1, limit);
      if (typeof min === "string") return { error: min };
      if (typeof max === "string") return { error: max };
      if (min !== undefined && max !== undefined && min > max) return { error: `${n}: the minimum length cannot exceed the maximum.` };
      if (min !== undefined) field.minLength = min;
      if (max !== undefined) field.maxLength = max;
    }
    if (d.type === "number") {
      const parse = (raw: string) => (raw.trim() ? Number(raw) : undefined);
      const min = parse(d.minNumber);
      const max = parse(d.maxNumber);
      if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max))) return { error: `${n}: enter valid number limits.` };
      if (min !== undefined && max !== undefined && min > max) return { error: `${n}: the minimum cannot exceed the maximum.` };
      if (min !== undefined) field.minNumber = min;
      if (max !== undefined) field.maxNumber = max;
    }
    if (d.type === "single_choice" || d.type === "multi_choice") {
      const options = d.options
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [value = "", ...rest] = line.split("|");
          const label = rest.join("|").trim();
          return { value: value.trim(), label: label || value.trim() };
        });
      if (options.length < 1 || options.length > 50) return { error: `${n}: list between 1 and 50 options, one per line.` };
      if (new Set(options.map((o) => o.value)).size !== options.length) return { error: `${n}: option values must be unique.` };
      field.options = options;
      if (d.type === "multi_choice") {
        const min = int(d.minSelections, "minimum selections", 0, 50);
        const max = int(d.maxSelections, "maximum selections", 1, 50);
        if (typeof min === "string") return { error: min };
        if (typeof max === "string") return { error: max };
        if (min !== undefined && max !== undefined && min > max) return { error: `${n}: minimum selections cannot exceed the maximum.` };
        if (min !== undefined) field.minSelections = min;
        if (max !== undefined) field.maxSelections = max;
      }
    }
    fields.push(field);
  }
  return { fields };
}

/** Renders an intake answer as text for review screens. */
export function answerText(value: unknown, options?: readonly { value: string; label: string }[]): string {
  if (value === null || value === undefined || value === "") return "—";
  const label = (v: string) => options?.find((o) => o.value === v)?.label ?? v;
  if (Array.isArray(value)) return value.length ? value.map((v) => label(String(v))).join(", ") : "—";
  return label(String(value));
}
