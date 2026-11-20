import { z } from "zod";
import { defineSetting } from "../platform/index.js";

export const ENGAGEMENT_NOTIFICATIONS_RETENTION_DAYS = defineSetting({
  key: "engagement.notifications.retention_days",
  owner: "engagement",
  group: "engagement",
  label: "In-app notification retention (days)",
  description: "Number of days to keep read and unread in-app notifications before automatic purge.",
  schema: z.number().int().min(7).max(365),
  default: 90,
  sensitivity: "internal",
  exportable: true,
});

export const ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED = defineSetting({
  key: "engagement.notifications.email_enabled",
  owner: "engagement",
  group: "engagement",
  label: "Enable generic notification e-mails",
  description: "Allow opt-in category notifications to enqueue generic secret-free e-mail alerts when SMTP is configured.",
  schema: z.boolean(),
  default: false,
  sensitivity: "internal",
  exportable: true,
});

export const ENGAGEMENT_TICKETS_REOPEN_WINDOW_DAYS = defineSetting({
  key: "engagement.tickets.reopen_window_days",
  owner: "engagement",
  group: "engagement",
  label: "Support ticket reopen window (days)",
  description: "Days after resolution during which a customer may reopen a resolved ticket.",
  schema: z.number().int().min(1).max(90),
  default: 14,
  sensitivity: "internal",
  exportable: true,
});

export const ENGAGEMENT_SEARCH_TIME_BUDGET_MS = defineSetting({
  key: "engagement.search.time_budget_ms",
  owner: "engagement",
  group: "engagement",
  label: "Bounded search time budget (ms)",
  description: "Maximum wall-clock time budget in milliseconds for a single cross-domain search request.",
  schema: z.number().int().min(100).max(5000),
  default: 1500,
  sensitivity: "internal",
  exportable: true,
});
