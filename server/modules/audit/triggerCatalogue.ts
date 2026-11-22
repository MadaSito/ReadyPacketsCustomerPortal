/**
 * Curated automation trigger catalogue (increment 03, package J). Owner: audit engineer, with each owning
 * module (the `owner` column). Data only — no code runs from here.
 *
 * An entry is a business event an automation may listen to. It names:
 * - the DURABLE audit event that carries it (`eventName`) and the outcomes that count (`outcomes`) — e.g. a
 *   refused registration for an existing address must never trigger anything (enumeration side channel);
 * - optional fixed `match` conditions on safe attributes (e.g. "ticket closed" = status change to `closed`);
 * - `fields`: what conditions and templates may use. `from: "event"` fields come from the validated audit
 *   envelope; `from: "context"` fields are resolved by the owning module's context resolver
 *   (`registerAutomationTrigger`) in the worker, under the automation's authority, never from the request.
 *   `personal: true` fields may appear in templates only — never in conditions, run records, logs or audit;
 * - `recipients`: the people an action can address, resolved by the owning module to user ids at run
 *   time (never an address taken from the event). Fixed addresses are configured on the action instead.
 *
 * Events whose correlation id carries the automation-origin marker never reach automations (tap.ts).
 */
import type { AuditTapEvent } from "./tap.js";

export type TriggerFieldType = "string" | "number" | "boolean" | "enum" | "money_minor" | "datetime" | "public_id";

export interface TriggerField {
  key: string;
  label: string;
  type: TriggerFieldType;
  enumValues?: readonly string[];
  from: "event" | "context";
  /** Template-only; never usable in conditions or recorded. */
  personal?: boolean;
}

export interface TriggerRecipient {
  key: string;
  label: string;
  kind: "user" | "role";
}

export interface TriggerCatalogueEntry {
  key: string;
  label: string;
  description: string;
  group: "Accounts" | "Orders" | "Files and messages" | "Support" | "Billing" | "Operations";
  owner: "identity" | "orders" | "files" | "engagement" | "compliance" | "jobs" | "backup" | "integrations" | "community" | "payments" | "referrals" | "knowledge" | "promotions";
  eventName: string;
  outcomes: readonly AuditTapEvent["outcome"][];
  match?: Readonly<Record<string, string | boolean>>;
  resourceType: string | null;
  fields: readonly TriggerField[];
  recipients: readonly TriggerRecipient[];
  /**
   * Staff-internal event: actions may address staff / administrators only — never a customer, a fixed external
   * address or a webhook (the automations module enforces this when saving and when running).
   */
  staffOnly?: boolean;
}

const TICKET_STATUSES = ["open", "pending_customer", "pending_staff", "resolved", "closed"] as const;
const TICKET_CATEGORIES = ["general", "order", "billing", "technical", "deliverable", "account"] as const;
const INVOICE_STATUSES = ["draft", "issued", "paid", "void"] as const;
const PAYMENT_METHODS = ["bank_transfer", "wire", "ach", "check", "card_manual", "waiver", "provider_online", "imported_historical", "other"] as const;
const FILE_CATEGORIES = ["supporting", "intake_attachment", "deliverable"] as const;
const ROLES = ["admin", "staff", "customer", "system", "anonymous"] as const;

const f = (key: string, label: string, type: TriggerFieldType, from: TriggerField["from"] = "event", extra: Partial<TriggerField> = {}): TriggerField => ({ key, label, type, from, ...extra });
const actorRole = f("actor_role", "Acting role", "enum", "event", { enumValues: ROLES });
const person = (key: string, label: string): TriggerRecipient => ({ key, label, kind: "user" });
const ADMINS: TriggerRecipient = { key: "administrators", label: "Administrators", kind: "role" };
const STAFF: TriggerRecipient = { key: "staff", label: "All staff", kind: "role" };
const ACTOR = person("actor", "The person who did it");
const ORDER_OWNER = person("order_owner", "Order owner (customer)");
const ORDER_ASSIGNEE = person("order_assignee", "Assigned staff member");
const recipientName = f("recipient_name", "Recipient name", "string", "context", { personal: true });
const orderContext = [
  f("order_public_id", "Order id", "public_id"),
  f("order_reference", "Order reference", "string", "context"),
  f("order_status_label", "Order status", "string", "context"),
  f("order_link", "Link to the order", "string", "context"),
];

const ENTRIES: TriggerCatalogueEntry[] = [
  {
    key: "account.registered", label: "Account registered", group: "Accounts", owner: "identity",
    description: "A new customer account was created through self-registration.",
    eventName: "auth.register.requested", outcomes: ["completed"], resourceType: "user",
    fields: [recipientName], recipients: [ACTOR, ADMINS],
  },
  {
    key: "account.activated", label: "Account activated", group: "Accounts", owner: "identity",
    description: "A user activated an invited account.",
    eventName: "auth.account.activated", outcomes: ["completed"], resourceType: "user",
    fields: [actorRole, recipientName], recipients: [ACTOR, ADMINS],
  },
  {
    key: "account.password_reset_requested", label: "Password reset requested", group: "Accounts", owner: "identity",
    description: "Someone asked for a password reset. The account is not identified, so only administrators can be told.",
    eventName: "auth.password.reset_requested", outcomes: ["attempted"], resourceType: "user",
    fields: [], recipients: [ADMINS],
  },
  {
    key: "account.password_changed", label: "Password changed", group: "Accounts", owner: "identity",
    description: "A user changed their password.",
    eventName: "auth.password.changed", outcomes: ["completed"], resourceType: "user",
    fields: [f("forced", "Change was required", "boolean"), recipientName], recipients: [ACTOR, ADMINS],
  },
  {
    key: "order.created", label: "Order created", group: "Orders", owner: "orders",
    description: "A new order was placed.",
    eventName: "order.created", outcomes: ["completed"], resourceType: "order",
    fields: [f("currency", "Currency", "string"), f("total_minor", "Order total", "money_minor"), f("on_behalf", "Placed by staff for the customer", "boolean"),
      ...orderContext.slice(1), recipientName],
    recipients: [ORDER_OWNER, ACTOR, ADMINS, STAFF],
  },
  {
    key: "order.status_changed", label: "Order status changed", group: "Orders", owner: "orders",
    description: "An order moved to another status.",
    eventName: "order.status.changed", outcomes: ["completed"], resourceType: "order",
    fields: [f("from_status", "Previous status", "string"), f("to_status", "New status", "string"), actorRole, ...orderContext.slice(1), recipientName],
    recipients: [ORDER_OWNER, ORDER_ASSIGNEE, ACTOR, ADMINS],
  },
  {
    key: "order.assigned", label: "Order reassigned", group: "Orders", owner: "orders",
    description: "An order was moved to another customer account.",
    eventName: "order.reassigned", outcomes: ["completed"], resourceType: "order",
    fields: [...orderContext.slice(1), recipientName], recipients: [ORDER_OWNER, ACTOR, ADMINS],
  },
  {
    key: "file.uploaded", label: "File uploaded", group: "Files and messages", owner: "files",
    description: "A customer-visible file was added to an order. Staff-only uploads never match.",
    eventName: "file.uploaded", outcomes: ["completed"], match: { file_visibility: "customer_visible" }, resourceType: "file",
    fields: [actorRole, f("file_category", "File category", "enum", "context", { enumValues: FILE_CATEGORIES }), ...orderContext, recipientName],
    recipients: [ORDER_OWNER, ORDER_ASSIGNEE, ACTOR, ADMINS],
  },
  {
    key: "message.posted", label: "Order message posted", group: "Files and messages", owner: "engagement",
    description: "A customer-visible message was posted on an order. Internal staff notes never fire this trigger.",
    eventName: "engagement.message.sent", outcomes: ["completed"], match: { visibility: "customer" }, resourceType: "order_message",
    fields: [actorRole, f("attachment_count", "Attachments", "number"), ...orderContext, recipientName],
    recipients: [ORDER_OWNER, ORDER_ASSIGNEE, ACTOR, STAFF],
  },
  {
    key: "message.internal_note", label: "Internal order note posted", group: "Files and messages", owner: "engagement",
    description: "A staff-only note was posted on an order. Only staff can be addressed; the customer is never told.",
    eventName: "engagement.message.sent", outcomes: ["completed"], match: { visibility: "internal" }, resourceType: "order_message",
    staffOnly: true,
    fields: [actorRole, f("attachment_count", "Attachments", "number"), ...orderContext, recipientName],
    recipients: [ORDER_ASSIGNEE, ACTOR, STAFF],
  },
  {
    key: "ticket.opened", label: "Support ticket opened", group: "Support", owner: "engagement",
    description: "A support ticket was opened.",
    eventName: "engagement.ticket.created", outcomes: ["completed"], resourceType: "ticket",
    fields: [actorRole, f("ticket_number", "Ticket number", "string"), f("category", "Category", "enum", "event", { enumValues: TICKET_CATEGORIES }),
      f("has_related_order", "About an order", "boolean"), f("ticket_link", "Link to the ticket", "string", "context"), recipientName],
    recipients: [person("ticket_requester", "Ticket requester"), ACTOR, STAFF, ADMINS],
  },
  {
    key: "ticket.replied", label: "Support ticket replied", group: "Support", owner: "engagement",
    description: "Someone replied on a support ticket (internal notes never trigger).",
    eventName: "engagement.ticket.replied", outcomes: ["completed"], match: { internal_only: false }, resourceType: "ticket",
    fields: [actorRole, f("ticket_number", "Ticket number", "string"), f("ticket_link", "Link to the ticket", "string", "context"), recipientName],
    recipients: [person("ticket_requester", "Ticket requester"), person("ticket_assignee", "Assigned staff member"), ACTOR, STAFF],
  },
  {
    key: "ticket.closed", label: "Support ticket closed", group: "Support", owner: "engagement",
    description: "A support ticket was closed.",
    eventName: "engagement.ticket.status.changed", outcomes: ["completed"], match: { to_status: "closed" }, resourceType: "ticket",
    fields: [actorRole, f("ticket_number", "Ticket number", "string"), f("from_status", "Previous status", "enum", "event", { enumValues: TICKET_STATUSES }),
      f("ticket_link", "Link to the ticket", "string", "context"), recipientName],
    recipients: [person("ticket_requester", "Ticket requester"), person("ticket_assignee", "Assigned staff member"), ACTOR],
  },
  {
    key: "community.topic_created", label: "Community topic started", group: "Support", owner: "community", staffOnly: true,
    description: "A member started a community topic (published or held for review). Fires only while the forum is switched on.",
    eventName: "community.topic.created", outcomes: ["completed"], resourceType: "community_topic",
    fields: [actorRole, f("post_state", "Opening post state", "enum", "event", { enumValues: ["published", "pending"] }),
      f("held_reason", "Held for review because", "string"), f("topic_link", "Link to the topic", "string", "context")],
    recipients: [STAFF, ADMINS],
  },
  {
    key: "community.post_reported", label: "Community post reported", group: "Support", owner: "community", staffOnly: true,
    description: "A member reported a community post. Hidden automatically when the report threshold is reached.",
    eventName: "community.post.reported", outcomes: ["completed"], resourceType: "community_post",
    fields: [f("report_reason", "Report reason", "enum", "event", { enumValues: ["spam", "abuse", "off_topic", "personal_info", "other"] }),
      f("auto_hidden", "Hidden automatically", "boolean"), f("queue_link", "Link to the moderation queue", "string", "context")],
    recipients: [STAFF, ADMINS],
  },
  {
    key: "invoice.issued", label: "Invoice issued", group: "Billing", owner: "compliance",
    description: "An invoice was issued to a customer.",
    eventName: "invoice.issued", outcomes: ["completed"], resourceType: "invoice",
    fields: [f("invoice_number", "Invoice number", "string"), f("currency", "Currency", "string"), f("total_minor", "Invoice total", "money_minor"),
      f("status", "Invoice status", "enum", "event", { enumValues: INVOICE_STATUSES }), ...orderContext, f("invoice_link", "Link to the invoice", "string", "context"), recipientName],
    recipients: [ORDER_OWNER, ADMINS],
  },
  {
    key: "invoice.paid", label: "Invoice payment recorded", group: "Billing", owner: "compliance",
    description: "A payment was recorded against an invoice.",
    eventName: "invoice.payment.recorded", outcomes: ["completed"], resourceType: "invoice_payment",
    fields: [f("invoice_public_id", "Invoice id", "public_id"), f("method", "Payment method", "enum", "event", { enumValues: PAYMENT_METHODS }),
      f("amount_minor", "Amount paid", "money_minor"), f("currency", "Currency", "string"),
      f("derived_invoice_status", "Invoice status after payment", "enum", "event", { enumValues: INVOICE_STATUSES }),
      ...orderContext, f("invoice_number", "Invoice number", "string", "context"), recipientName],
    recipients: [ORDER_OWNER, ADMINS],
  },
  /* Increment 05 (D3). Attributes from server/modules/promotions/API.md (camelCase → snake_case by the envelope).
     Staff-only: the code itself is never an attribute, and customers are told about discounts on their order. */
  {
    key: "promotion.redeemed", label: "Discount code used on an order", group: "Billing", owner: "promotions", staffOnly: true,
    description: "An order was placed with a discount code. Only the label and amounts are available, never the code.",
    eventName: "promotion.redeemed", outcomes: ["completed"], resourceType: "promotion",
    fields: [f("promo_public_id", "Discount code id", "public_id"), f("label", "Discount label", "string"), f("promo_discount_minor", "Code discount", "money_minor"),
      f("discount_minor", "Total discount", "money_minor"), f("currency", "Currency", "string"), f("order_public_id", "Order id", "public_id")],
    recipients: [STAFF, ADMINS],
  },
  {
    key: "promotion.attempts_blocked", label: "Discount code attempts blocked", group: "Operations", owner: "promotions", staffOnly: true,
    description: "Too many unsuccessful discount code attempts from one account; code checks are paused for it. May indicate code guessing.",
    eventName: "promotion.attempts_blocked", outcomes: ["refused"], resourceType: "user",
    fields: [f("failed_count", "Failed attempts", "number"), f("window_minutes", "Within minutes", "number"), f("pause_minutes", "Paused for minutes", "number")],
    recipients: [ADMINS, STAFF],
  },
  {
    key: "maintenance.enabled", label: "Maintenance mode switched on", group: "Operations", owner: "jobs",
    description: "An administrator switched maintenance mode on (background work pauses).",
    eventName: "job.maintenance.changed", outcomes: ["completed"], match: { reason_code: "MAINTENANCE_ENABLED" }, resourceType: "job_maintenance",
    fields: [], recipients: [ACTOR, ADMINS, STAFF],
  },
  {
    key: "customer_maintenance.configured", label: "Customer maintenance scheduled or changed", group: "Operations", owner: "jobs",
    description: "An administrator switched customer maintenance on, scheduled it or changed its window. Fires when the setting changes, not when the window starts.",
    eventName: "job.customer_maintenance.changed", outcomes: ["completed"], match: { reason_code: "CUSTOMER_MAINTENANCE_CONFIGURED" }, resourceType: "customer_maintenance",
    fields: [f("starts_at", "Starts", "datetime"), f("ends_at", "Expected end", "datetime"), f("enabled", "Switched on", "boolean")],
    recipients: [ACTOR, ADMINS, STAFF],
  },
  {
    key: "backup.completed", label: "Backup completed", group: "Operations", owner: "backup",
    description: "An encrypted backup archive was written.",
    eventName: "backup.archive.completed", outcomes: ["completed"], resourceType: "backup_archive",
    fields: [f("trigger", "Started by", "string"), f("encrypted_bytes", "Archive size (bytes)", "number")], recipients: [ADMINS],
  },
  {
    key: "backup.failed", label: "Backup failed", group: "Operations", owner: "backup",
    description: "A backup could not be written.",
    eventName: "backup.archive.failed", outcomes: ["failed"], resourceType: "backup_archive",
    fields: [f("reason_code", "Reason", "string"), f("trigger", "Started by", "string")], recipients: [ADMINS],
  },
  {
    key: "backup.verify_failed", label: "Backup verification failed", group: "Operations", owner: "backup",
    description: "A stored backup failed its integrity verification.",
    eventName: "backup.verify.failed", outcomes: ["failed"], resourceType: "backup_archive",
    fields: [f("reason_code", "Reason", "string")], recipients: [ADMINS],
  },
  {
    key: "backup.remote_copy_completed", label: "Off-host backup copy completed", group: "Operations", owner: "backup",
    description: "A verified encrypted backup was copied to the assigned storage connection.",
    eventName: "backup.remote_copy.completed", outcomes: ["completed"], resourceType: "backup_archive",
    fields: [f("connection_public_id", "Storage connection", "public_id"), f("verified_bytes", "Verified size (bytes)", "number")], recipients: [ADMINS],
  },
  {
    key: "backup.remote_copy_failed", label: "Off-host backup copy failed", group: "Operations", owner: "backup",
    description: "A backup could not be copied to the assigned storage connection.",
    eventName: "backup.remote_copy.failed", outcomes: ["failed"], resourceType: "backup_archive",
    fields: [f("reason_code", "Reason", "string"), f("connection_public_id", "Storage connection", "public_id"), f("attempt_count", "Attempts", "number")], recipients: [ADMINS],
  },
  {
    key: "backup.policy_unmet", label: "3-2-1 backup policy not met", group: "Operations", owner: "backup",
    description: "Recent verified backups do not satisfy all three 3-2-1 conditions (three copies, two storage systems, one off-site).",
    eventName: "backup.policy.unmet", outcomes: ["failed"], resourceType: "backup_policy",
    fields: [f("reason_code", "Reason", "string"), f("verified_copies", "Verified copies", "number"), f("storage_systems", "Storage systems", "number"),
      f("offsite_copies", "Off-site copies", "number"), f("window_days", "Evaluation window (days)", "number")],
    recipients: [ADMINS],
  },
  {
    key: "mail.delivery_failed", label: "E-mail delivery failed", group: "Operations", owner: "jobs",
    description: "An e-mail could not be delivered. Failures of mail sent by an automation never trigger automations.",
    eventName: "job.mail.failed", outcomes: ["failed"], resourceType: "mail",
    fields: [f("reason_code", "Reason", "string")], recipients: [ADMINS],
  },
];

export const TRIGGER_CATALOGUE: readonly TriggerCatalogueEntry[] = Object.freeze(ENTRIES);

const BY_EVENT = new Map<string, TriggerCatalogueEntry[]>();
for (const entry of TRIGGER_CATALOGUE) BY_EVENT.set(entry.eventName, [...(BY_EVENT.get(entry.eventName) ?? []), entry]);

/** Every audit event name the catalogue can listen to (for the tap's `listens`). */
export const CATALOGUE_EVENT_NAMES: ReadonlySet<string> = new Set(BY_EVENT.keys());

export function catalogueEntry(key: string): TriggerCatalogueEntry | undefined {
  return TRIGGER_CATALOGUE.find((entry) => entry.key === key);
}

/** Value of an event field: attribute, safe count, or the envelope's reason code / actor role. */
export function eventFieldValue(event: AuditTapEvent, key: string): string | number | boolean | null | undefined {
  if (key === "reason_code") return event.reasonCode;
  if (key === "actor_role") return event.actor.role;
  if (key in event.attributes) return event.attributes[key];
  if (key in event.safeCounts) return event.safeCounts[key];
  return undefined;
}

/** Catalogue entries this event fulfils (event name, outcome, resource type and fixed matches). */
export function entriesForEvent(event: AuditTapEvent): TriggerCatalogueEntry[] {
  const candidates = BY_EVENT.get(event.eventName);
  if (!candidates) return [];
  return candidates.filter((entry) =>
    entry.outcomes.includes(event.outcome)
    && (entry.resourceType === null || event.resource?.type === entry.resourceType)
    && Object.entries(entry.match ?? {}).every(([key, expected]) => eventFieldValue(event, key) === expected));
}
