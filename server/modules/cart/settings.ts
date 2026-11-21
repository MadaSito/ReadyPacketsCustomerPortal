/**
 * Cart & checkout settings and feature switch (Increment 04, Package L).
 * Owner: recovery_ops_engineer.
 *
 * Ships disabled by default (`feature.cart = false`); toggling requires admin + step-up
 * and is durably audited (`platform.feature.changed`).
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
