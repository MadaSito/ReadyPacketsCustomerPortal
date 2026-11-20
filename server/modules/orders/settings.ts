/** Orders settings declarations (platform settings registry). */
import { z } from "zod";
import { defineSetting } from "../platform/index.js";

export const ORDER_REFERENCE_PREFIX = defineSetting({
  key: "orders.reference.prefix",
  owner: "orders",
  group: "orders",
  label: "Order reference prefix",
  description: "Uppercase prefix for generated order references, e.g. RP-2026-000123.",
  schema: z.string().regex(/^[A-Z]{2,6}$/),
  default: "RP",
  sensitivity: "internal",
});

export const ORDER_NOTIFY_MAIL = defineSetting({
  key: "orders.notify.mail",
  owner: "orders",
  group: "orders",
  label: "E-mail customers on status changes",
  description: "In-app notifications are always sent; this additionally queues an e-mail when mail delivery is configured.",
  schema: z.boolean(),
  default: false,
  sensitivity: "internal",
});

export const ORDER_INVITE_TTL_DAYS = defineSetting({
  key: "orders.sharing.invite_ttl_days",
  owner: "orders",
  group: "orders",
  label: "Share invitation lifetime (days)",
  description: "Pending share invitations expire after this many days.",
  schema: z.number().int().min(1).max(90),
  default: 14,
  sensitivity: "internal",
});
