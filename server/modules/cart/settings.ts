/**
 * Cart, checkout, and upsell settings and feature switches (Increments 04–06).
 * Owner: recovery_ops_engineer.
 *
 * Both feature flags ship disabled by default (`feature.cart = false`, `feature.cart.upsell = false`);
 * every toggle is durably audited (`platform.feature.changed` / `cart.upsell_feature_toggled`).
 */
import { z } from "zod";
import { defineFeatureFlag, defineSetting } from "../platform/index.js";

export const CART_FEATURE_FLAG = defineFeatureFlag({
  flag: "cart",
  owner: "cart",
  label: "Shopping cart and checkout",
  description:
    "Allow customers to add packets and items to a persistent server-side cart and check out via invoice or hosted card payment.",
  clientVisible: true,
});

export const CART_UPSELL_FEATURE_FLAG = defineFeatureFlag({
  flag: "cart.upsell",
  owner: "cart",
  label: "Cart suggestions (upsell)",
  description:
    "Show up to three relevant add-on, tier-upgrade, or bundle-completion suggestions inside the customer cart when the cart feature is enabled.",
  clientVisible: true,
});

export const CART_ABANDONED_TTL_HOURS = defineSetting({
  key: "cart.abandoned_ttl_hours",
  owner: "cart",
  group: "orders",
  label: "Abandoned cart expiry (hours)",
  description: "Hours of inactivity after which an open customer cart is automatically marked expired by the background sweep.",
  schema: z.number().int().min(1).max(2160),
  default: 168,
  sensitivity: "internal",
  fields: {
    "": {
      label: "Abandoned cart expiry (hours)",
      help: "Between 1 hour and 2160 hours (90 days). Default is 168 hours (7 days).",
    },
  },
});

/**
 * Internal ledger of starter `seed_key`s already provisioned automatically at startup (Increment 06, D3).
 * Ensures that if an administrator deletes a seeded offer, startup never resurrects it automatically, while
 * clicking "Add suggested offers" on `/admin/carts/suggestions` still inserts any missing starter rows.
 */
const normalizeSeededKeysInput = (items: readonly unknown[]): string[] =>
  Array.from(
    new Set(
      items
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && v.length <= 96),
    ),
  );

const seededKeysArraySchema = z
  .preprocess(
    (raw) =>
      Array.isArray(raw)
        ? normalizeSeededKeysInput(raw)
        : typeof raw === "object" && raw !== null && Array.isArray((raw as { keys?: unknown }).keys)
          ? normalizeSeededKeysInput((raw as { keys: unknown[] }).keys)
          : [],
    z.array(z.string().min(1).max(96)).max(500),
  )
  .catch([]);

export function parseCartUpsellSeededKeysSetting(raw: unknown): string[] {
  return seededKeysArraySchema.parse(raw);
}

export const CART_UPSELL_SEEDED_KEYS = defineSetting({
  key: "cart.upsell_seeded_keys",
  owner: "cart",
  group: "orders",
  label: "Provisioned starter cart suggestion keys",
  description:
    "Internal list of starter suggestion keys already seeded automatically so deleted starter rows are not re-added on restart.",
  schema: seededKeysArraySchema,
  default: [],
  sensitivity: "internal",
  exportable: false,
});
