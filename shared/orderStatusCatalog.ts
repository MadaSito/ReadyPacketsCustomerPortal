/**
 * Increment 07 (D2) — global order status catalogue shared contracts, Zod schemas, built-in seeds, and fallback helper.
 *
 * Owner: recovery_ops_engineer (Package C).
 * Consumers: ui_foundation_engineer (A), orders_engineer (B), engagement_engineer (F), siem_engineer (G),
 * portable_contract_engineer (J).
 */
import { z } from "zod";

export const ORDER_STATUS_CATEGORIES = ["start", "working", "waiting", "done", "canceled"] as const;
export type OrderStatusCategory = (typeof ORDER_STATUS_CATEGORIES)[number];

export const ORDER_STATUS_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type OrderStatusTone = (typeof ORDER_STATUS_TONES)[number];

export const ORDER_STATUS_ATTENTIONS = ["none", "staff_review", "customer_response"] as const;
export type OrderStatusAttention = (typeof ORDER_STATUS_ATTENTIONS)[number];

export const ORDER_ACTIVE_ATTENTIONS = ["staff_review", "customer_response"] as const;
export type OrderActiveAttention = (typeof ORDER_ACTIVE_ATTENTIONS)[number];

export const statusCatalogKeySchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscores, starting with a letter.");

export const statusCatalogLabelSchema = z
  .string()
  .transform((value) =>
    // eslint-disable-next-line no-control-regex -- strip control characters cleanly
    value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim(),
  )
  .pipe(
    z
      .string()
      .min(1, "Enter a label.")
      .max(60, "Keep labels within 60 characters.")
      .refine((value) => !/<\s*[a-z!/?]/i.test(value), "Use plain text without markup."),
  );

/**
 * Bidirectional cancel invariant (Contract §1 D2):
 * A status key containing `cancel` must have category `canceled`, and a status with category `canceled`
 * must have a key containing `cancel` (integrations and cancellation presentation rely on it).
 */
export function validateStatusCancelCategoryRule(key: string, category: OrderStatusCategory): string | null {
  const hasCancel = key.includes("cancel");
  if (hasCancel && category !== "canceled") {
    return "A status key containing 'cancel' must use the 'Canceled' category.";
  }
  if (!hasCancel && category === "canceled") {
    return "A status in the 'Canceled' category must include 'cancel' in its key.";
  }
  return null;
}

export interface StatusCatalogLookup {
  key: string;
  staffLabel: string;
  customerLabel: string;
  tone: OrderStatusTone;
  category: OrderStatusCategory;
  attention: OrderStatusAttention;
  retired: boolean;
}

export interface StatusCatalogUsage {
  activeOrderCount: number;
  draftCount: number;
  publishedVersionCount: number;
}

export interface StatusCatalogItem extends StatusCatalogLookup {
  publicId: string;
  position: number;
  retiredAt: Date | string | null;
  version: number;
  usage?: StatusCatalogUsage;
}

export interface BuiltInStatusSeed {
  key: string;
  staffLabel: string;
  customerLabel: string;
  tone: OrderStatusTone;
  category: OrderStatusCategory;
  attention: OrderStatusAttention;
  position: number;
}

/**
 * Built-in status catalogue entries seeded idempotently at start-up alongside any custom keys found in
 * published workflow versions. Existing rows are never overwritten on restart so administrator renames,
 * reorderings, and retirements persist across upgrades.
 */
export const BUILT_IN_STATUS_CATALOG: readonly BuiltInStatusSeed[] = [
  {
    key: "awaiting_payment",
    staffLabel: "Awaiting payment",
    customerLabel: "Awaiting payment",
    tone: "warning",
    category: "start",
    attention: "none",
    position: 0,
  },
  {
    key: "submitted",
    staffLabel: "Submitted",
    customerLabel: "Submitted",
    tone: "info",
    category: "start",
    attention: "staff_review",
    position: 1,
  },
  {
    key: "intake_open",
    staffLabel: "Intake open",
    customerLabel: "Upload your materials",
    tone: "warning",
    category: "waiting",
    attention: "customer_response",
    position: 2,
  },
  {
    key: "in_review",
    staffLabel: "Intake review",
    customerLabel: "In review",
    tone: "info",
    category: "working",
    attention: "staff_review",
    position: 3,
  },
  {
    key: "in_progress",
    staffLabel: "Synthesis",
    customerLabel: "In progress",
    tone: "info",
    category: "working",
    attention: "none",
    position: 4,
  },
  {
    key: "awaiting_customer",
    staffLabel: "Customer review",
    customerLabel: "Ready for your review",
    tone: "warning",
    category: "waiting",
    attention: "customer_response",
    position: 5,
  },
  {
    key: "revisions",
    staffLabel: "Revisions",
    customerLabel: "Revisions in progress",
    tone: "info",
    category: "working",
    attention: "staff_review",
    position: 6,
  },
  {
    key: "delivery_preparing",
    staffLabel: "Preparing delivery",
    customerLabel: "Preparing delivery",
    tone: "info",
    category: "working",
    attention: "none",
    position: 7,
  },
  {
    key: "delivered",
    staffLabel: "Delivered",
    customerLabel: "Delivered",
    tone: "success",
    category: "done",
    attention: "none",
    position: 8,
  },
  {
    key: "completed",
    staffLabel: "Closed",
    customerLabel: "Closed",
    tone: "success",
    category: "done",
    attention: "none",
    position: 9,
  },
  {
    key: "canceled",
    staffLabel: "Canceled",
    customerLabel: "Canceled",
    tone: "neutral",
    category: "canceled",
    attention: "none",
    position: 10,
  },
] as const;

const BUILT_IN_BY_KEY: ReadonlyMap<string, BuiltInStatusSeed> = new Map(
  BUILT_IN_STATUS_CATALOG.map((item) => [item.key, item]),
);

export function humanizeStatusKey(key: string): string {
  const cleaned = key.replace(/_+/g, " ").trim();
  if (!cleaned) return key;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Deterministic fallback when a status key is not yet in `order_status_catalog`
 * (for example, an unseeded test database or an older custom workflow status).
 */
export function fallbackStatusCatalogLookup(
  key: string,
  snapshot?: {
    staffLabel?: string;
    customerLabel?: string;
    tone?: OrderStatusTone;
    kind?: "initial" | "active" | "terminal";
  },
): StatusCatalogLookup {
  const builtIn = BUILT_IN_BY_KEY.get(key);
  if (builtIn) {
    return {
      key: builtIn.key,
      staffLabel: snapshot?.staffLabel ?? builtIn.staffLabel,
      customerLabel: snapshot?.customerLabel ?? builtIn.customerLabel,
      tone: snapshot?.tone ?? builtIn.tone,
      category: builtIn.category,
      attention: builtIn.attention,
      retired: false,
    };
  }

  let category: OrderStatusCategory;
  if (key.includes("cancel")) {
    category = "canceled";
  } else if (snapshot?.kind === "initial") {
    category = "start";
  } else if (snapshot?.kind === "terminal" || /complet|deliver|done|closed/.test(key)) {
    category = "done";
  } else if (/await|wait|customer|intake_open/.test(key)) {
    category = "waiting";
  } else {
    category = "working";
  }

  let attention: OrderStatusAttention = "none";
  if (category === "waiting") {
    attention = "customer_response";
  } else if (/review|revis/.test(key)) {
    attention = "staff_review";
  }

  const defaultTone: OrderStatusTone =
    category === "done"
      ? "success"
      : category === "waiting"
        ? "warning"
        : category === "canceled"
          ? "neutral"
          : "info";

  const fallbackLabel = humanizeStatusKey(key);
  return {
    key,
    staffLabel: snapshot?.staffLabel ?? fallbackLabel,
    customerLabel: snapshot?.customerLabel ?? snapshot?.staffLabel ?? fallbackLabel,
    tone: snapshot?.tone ?? defaultTone,
    category,
    attention,
    retired: false,
  };
}
