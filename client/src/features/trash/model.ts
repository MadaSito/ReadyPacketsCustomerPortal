/**
 * Trash centre wording and pure helpers (increment 09 D2.3, D2.6, D2.7). Owner: audit_engineer.
 * Everything a dialog says about what is erased or kept comes from here, so the words match the contract.
 */
import { formatDateTime } from "@/ui";
import type { TrashItemResult, TrashKind, TrashState } from "./api";

export const KIND_NOUN: Record<TrashKind, { one: string; many: string }> = {
  order: { one: "order", many: "orders" },
  customer: { one: "customer account", many: "customer accounts" },
};

export function countNoun(kind: TrashKind, n: number): string {
  return `${n} ${n === 1 ? KIND_NOUN[kind].one : KIND_NOUN[kind].many}`;
}

export const STATE_META: Record<TrashState, { label: string; tone: "info" | "warning" | "danger" }> = {
  in_trash: { label: "In trash", tone: "info" },
  deleting: { label: "Deleting", tone: "warning" },
  failed: { label: "Deletion failed", tone: "danger" },
};

export const KEPT_UNTIL_DELETED = "Kept until an administrator deletes it";

/** The text for "Deletes on": the date, or that automatic clean-up is off. */
export const EXTERNAL_COPIES_UNREACHABLE = "EXTERNAL_COPIES_UNREACHABLE";

/** Plain explanation for a run that stopped because recorded external copies could not be reached. */
export function unreachableCopiesText(n: number): string {
  const copies = n === 1 ? "1 copy" : `${n} copies`;
  return `Stopped: ${copies} in a connected storage service could not be reached, so ${n === 1 ? "it was" : "they were"} not deleted. Clean-up tries again; reconnect the storage, or finish and leave the copies in place.`;
}

export function dueText(dueAt: string | Date | null | undefined): string {
  return dueAt ? formatDateTime(dueAt, "date") : KEPT_UNTIL_DELETED;
}

/** Typed word for bulk permanent deletion (checked again on the server, D2.8). */
export const bulkConfirmation = (count: number): string => `DELETE ${count}`;
/** Typed word for turning on clean-up or shortening retention (same strength as a permanent deletion). */
export const retentionConfirmation = (count: number, serverPhrase?: string | null): string => serverPhrase?.trim() || `DELETE ${count}`;

/** `paidInvoices` → "paid invoices"; counts never carry personal data. */
export function countLabel(key: string, n: number): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.]+/g, " ").toLowerCase().trim();
  const singular = n === 1 && words.endsWith("s") && !words.endsWith("ss") ? words.slice(0, -1) : words;
  return `${n} ${singular}`;
}

/** Non-zero counts as readable lines, largest first. */
export function summaryLines(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => countLabel(k, n));
}

export const ERASED: Record<TrashKind, readonly string[]> = {
  order: [
    "Project details and working data, phase progress and checklists",
    "Notes, messages and support tickets for the order",
    "Files and recordings, including the stored copies the portal controls",
    "Intake answers, questionnaires and acknowledgements for the order",
    "Access grants and invitations",
    "Production copies, SharePoint mapping, cart references and automation run data",
  ],
  customer: [
    "Every order of the account, with everything listed for an order",
    "Name, e-mail address, password, multi-factor methods, sessions and tokens",
    "Single sign-on links, API keys, billing profile and notification preferences",
    "Consent choices and referral links",
    "Community posts (removed or shown as \u201cDeleted account\u201d)",
  ],
};

export const KEPT: readonly string[] = [
  "Issued invoices and receipts, with their own frozen copies",
  "Payment and refund records",
  "Policy acceptance records kept as evidence",
  "Audit and security log entries",
  "The order number and customer ID (never reused)",
];

export const NOT_TOUCHED: readonly string[] = [
  "Records at Stripe and folders already written to SharePoint or other external storage",
  "E-mails already delivered",
  "Backups and SIEM copies (backups expire under the backup retention)",
];

export const PURGE_WARNING =
  "This cannot be undone. Copies remain in backups until those backups expire.";

/** Customer wording for the server's reason codes (the server's safe message is the fallback). */
const REASON_MESSAGES: Record<string, string> = {
  CUSTOMER_NOT_SUSPENDED: "Suspend this account first.",
  OWNER_IN_TRASH: "Restore the customer account first.",
  ROOT_IN_TRASH: "Restore the order this one was added to first.",
  RESTORE_CONFLICT: "This item can't be restored as it is. Nothing was changed.",
  PURGE_IN_PROGRESS: "Permanent deletion has started for this item, so it can no longer be restored.",
  CONFIRMATION_MISMATCH: "The confirmation you typed doesn't match. Nothing was deleted.",
  SETTINGS_CHANGED: "The settings or the number of items due changed meanwhile. Review again.",
  STALE_VERSION: "This changed meanwhile. Review again.",
  STALE: "The settings or the number of items due changed meanwhile. Review again.",
  ALREADY_IN_TRASH: "This is already in the trash.",
  NOT_IN_TRASH: "This is no longer in the trash.",
  STEP_UP_REQUIRED: "Confirm your identity to continue.",
  ORDER_ON_LEGAL_HOLD: "Release the legal hold first.",
  EXTERNAL_COPIES_UNREACHABLE: "Copies in a connected storage service could not be reached, so they were not deleted.",
};

export function trashErrorMessage(reasonCode: string | null | undefined, safeMessage?: string | null): string {
  if (reasonCode && REASON_MESSAGES[reasonCode]) return REASON_MESSAGES[reasonCode];
  return safeMessage || "Something went wrong. Nothing was changed. Please try again.";
}

/** "2 orders restored. 1 could not be restored: …" — one sentence per outcome, for the live region. */
export function resultSentence(kind: TrashKind, verb: "restored" | "deleted permanently", results: readonly TrashItemResult[], labels?: ReadonlyMap<string, string>): string {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const parts: string[] = [];
  if (ok) parts.push(`${countNoun(kind, ok)} ${verb}.`);
  // One clause per distinct reason, so a legal hold on one item is not hidden behind another item's reason.
  const byReason = new Map<string, string[]>();
  for (const f of failed) {
    const message = trashErrorMessage(f.reasonCode, f.safeMessage);
    byReason.set(message, [...(byReason.get(message) ?? []), labels?.get(f.publicId) ?? ""]);
  }
  for (const [message, names] of byReason) {
    const named = names.filter(Boolean);
    const who = named.length === names.length && names.length <= 5 ? ` (${named.join(", ")})` : "";
    parts.push(`${names.length} could not be ${verb === "restored" ? "restored" : "deleted"}${who}: ${message}`);
  }
  return parts.join(" ") || "Nothing was changed.";
}

/** Retention days: whole numbers 1–3650 (D2.4). */
export function retentionError(value: string): string | null {
  if (!/^\d{1,4}$/.test(value.trim())) return "Enter a whole number of days from 1 to 3650.";
  const n = Number(value);
  return n >= 1 && n <= 3650 ? null : "Enter a whole number of days from 1 to 3650.";
}

/** Needs the typed confirmation + step-up: turning clean-up on, or shortening a period (D2.4, D2.8). */
export function retentionNeedsConfirmation(
  before: { autoPurgeEnabled: boolean; orderDays: number; customerDays: number },
  after: { autoPurgeEnabled: boolean; orderDays: number; customerDays: number },
): boolean {
  if (!after.autoPurgeEnabled) return false;
  if (!before.autoPurgeEnabled) return true;
  return after.orderDays < before.orderDays || after.customerDays < before.customerDays;
}

export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `k${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
