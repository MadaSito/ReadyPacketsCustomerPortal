import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Lock,
  MessageSquare,
} from "lucide-react";
import { Badge, type SelectOption, type Tone } from "@/ui";
import type {
  NotificationPreferenceCategory,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from "@server/modules/engagement/types";

export function makeIdempotencyKey(prefix = "eng"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Ensures notification/search links are strictly same-origin relative paths (`/...`). */
export function safeInternalPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.length > 512) {
    return null;
  }
  return raw;
}

export const TICKET_STATUS_META: Record<
  TicketStatus,
  { label: string; tone: Tone }
> = {
  open: { label: "Open", tone: "info" },
  pending_staff: { label: "Awaiting support", tone: "info" },
  pending_customer: { label: "Awaiting your reply", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

export function TicketStatusBadge({ status, staffView = false }: { status: TicketStatus; staffView?: boolean }) {
  const meta = TICKET_STATUS_META[status];
  const label =
    staffView && status === "pending_customer"
      ? "Awaiting customer"
      : staffView && status === "pending_staff"
        ? "Needs staff reply"
        : meta.label;
  const icon =
    status === "resolved" ? (
      <CheckCircle2 aria-hidden="true" />
    ) : status === "closed" ? (
      <Lock aria-hidden="true" />
    ) : status === "pending_customer" ? (
      <AlertCircle aria-hidden="true" />
    ) : (
      <Clock aria-hidden="true" />
    );
  return (
    <Badge tone={meta.tone} icon={icon}>
      {label}
    </Badge>
  );
}

export const TICKET_PRIORITY_META: Record<
  TicketPriority,
  { label: string; tone: Tone }
> = {
  low: { label: "Low", tone: "neutral" },
  normal: { label: "Normal", tone: "info" },
  high: { label: "High", tone: "warning" },
  urgent: { label: "Urgent", tone: "danger" },
};

export function TicketPriorityBadge({ priority }: { priority: TicketPriority }) {
  const meta = TICKET_PRIORITY_META[priority];
  const icon =
    priority === "urgent" || priority === "high" ? (
      <AlertTriangle aria-hidden="true" />
    ) : (
      <MessageSquare aria-hidden="true" />
    );
  return (
    <Badge tone={meta.tone} icon={icon}>
      {meta.label} priority
    </Badge>
  );
}

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  general: "General inquiry",
  order: "Order question",
  billing: "Billing & payment",
  technical: "Technical issue",
  deliverable: "Deliverable review",
  account: "Account & security",
};

export function TicketCategoryBadge({ category }: { category: TicketCategory }) {
  return (
    <Badge tone="neutral" icon={<HelpCircle aria-hidden="true" />}>
      {TICKET_CATEGORY_LABELS[category]}
    </Badge>
  );
}

export const TICKET_CATEGORY_OPTIONS: SelectOption[] = [
  { value: "general", label: "General inquiry" },
  { value: "order", label: "Order question" },
  { value: "deliverable", label: "Deliverable review" },
  { value: "billing", label: "Billing & payment" },
  { value: "technical", label: "Technical issue" },
  { value: "account", label: "Account & security" },
];

export const TICKET_STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: "", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "pending_staff", label: "Awaiting support" },
  { value: "pending_customer", label: "Awaiting customer" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

export const TICKET_PRIORITY_OPTIONS: SelectOption[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export const NOTIFICATION_CATEGORY_INFO: Record<
  NotificationPreferenceCategory,
  { label: string; description: string }
> = {
  security: {
    label: "Security & sign-in alerts",
    description: "Mandatory in-app security alerts for MFA, password, and session events.",
  },
  order: {
    label: "Order status updates",
    description: "Progress updates, assignment changes, and milestone completions on your orders.",
  },
  message: {
    label: "Order messages",
    description: "Notifications when a participant posts a new message on an order.",
  },
  ticket: {
    label: "Support tickets",
    description: "Updates when support replies or changes the status of your ticket.",
  },
  file: {
    label: "Files & deliverables",
    description: "Alerts when new packet deliverables or supporting files are available.",
  },
  invoice: {
    label: "Billing & invoices",
    description: "Receipts, invoice availability, and billing status notifications.",
  },
  compliance: {
    label: "Privacy & data requests",
    description: "Updates on data export or account privacy requests.",
  },
  system: {
    label: "Platform announcements",
    description: "Scheduled maintenance notices and service announcements.",
  },
};
