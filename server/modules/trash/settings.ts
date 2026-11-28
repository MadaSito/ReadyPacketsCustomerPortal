/**
 * Trash retention clean-up settings (Increment 09, Decision D2.4 & D2.8).
 * Owner: recovery_ops_engineer.
 *
 * Keys follow `SETTING_KEY_PATTERN` (`lowercase.snake_case`), default to automatic clean-up ON at 30 days
 * for both orders and customers (`1..3650`), and set `ownerWriteOnly: true` (`exportable: false`) so generic
 * platform settings mutations and portable config imports cannot bypass D2.8 CAS + typed confirmation.
 */
import { z } from "zod";
import { defineSetting } from "../platform/index.js";

const managedByTrashCentre = {
  href: "/admin/trash",
  label: "Trash centre",
} as const;

export const TRASH_RETENTION_MIN_DAYS = 1;
export const TRASH_RETENTION_MAX_DAYS = 3650;
export const TRASH_RETENTION_DEFAULT_DAYS = 30;

export function parseRetentionDays(raw: unknown, fallback = TRASH_RETENTION_DEFAULT_DAYS): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= TRASH_RETENTION_MIN_DAYS && raw <= TRASH_RETENTION_MAX_DAYS) {
    return raw;
  }
  return fallback;
}

export const TRASH_AUTO_PURGE_ENABLED = defineSetting({
  key: "trash.auto_purge.enabled",
  owner: "trash",
  group: "privacy",
  label: "Automatic trash clean-up",
  description:
    "Automatically permanently delete trashed orders and suspended customer accounts once their current retention period expires.",
  schema: z.boolean(),
  default: true,
  sensitivity: "internal",
  writeCapability: "trash.retention.manage",
  managedBy: managedByTrashCentre,
  ownerWriteOnly: true,
  exportable: false,
  fields: {
    "": {
      label: "Automatic trash clean-up",
      help: "When enabled, the hourly background job permanently deletes trashed items past their due date.",
    },
  },
});

export const TRASH_RETENTION_ORDER_DAYS = defineSetting({
  key: "trash.retention.order_days",
  owner: "trash",
  group: "privacy",
  label: "Order retention in trash (days)",
  description:
    "Days a standalone trashed order remains restorable in the Trash centre before permanent deletion (1 to 3650 days).",
  schema: z.number().int().min(TRASH_RETENTION_MIN_DAYS).max(TRASH_RETENTION_MAX_DAYS),
  default: TRASH_RETENTION_DEFAULT_DAYS,
  sensitivity: "internal",
  writeCapability: "trash.retention.manage",
  managedBy: managedByTrashCentre,
  ownerWriteOnly: true,
  exportable: false,
  fields: {
    "": {
      label: "Order retention in trash (days)",
      help: "Between 1 and 3650 days. Default is 30 days.",
    },
  },
});

export const TRASH_RETENTION_CUSTOMER_DAYS = defineSetting({
  key: "trash.retention.customer_days",
  owner: "trash",
  group: "privacy",
  label: "Customer account retention in trash (days)",
  description:
    "Days a trashed customer account (and orders trashed with it) remains restorable before permanent deletion (1 to 3650 days).",
  schema: z.number().int().min(TRASH_RETENTION_MIN_DAYS).max(TRASH_RETENTION_MAX_DAYS),
  default: TRASH_RETENTION_DEFAULT_DAYS,
  sensitivity: "internal",
  writeCapability: "trash.retention.manage",
  managedBy: managedByTrashCentre,
  ownerWriteOnly: true,
  exportable: false,
  fields: {
    "": {
      label: "Customer account retention in trash (days)",
      help: "Between 1 and 3650 days. Default is 30 days.",
    },
  },
});
