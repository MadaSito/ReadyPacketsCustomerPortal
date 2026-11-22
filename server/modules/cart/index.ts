/**
 * Cart & Checkout module public surface and factory (Increments 04 & 05, Packages L & B).
 * Owner: recovery_ops_engineer.
 * See ./API.md for the cross-module contract, procedures, and security invariants.
 */
import type { ModuleDeps } from "../../container.js";
import "./settings.js";
import { createCartService } from "./service.js";
import type { CartModule } from "./types.js";

export { CART_JOB_EXPIRE_ABANDONED, CART_SCHEDULE_EXPIRE_ABANDONED } from "./service.js";
export { CART_ABANDONED_TTL_HOURS, CART_FEATURE_FLAG, CART_UPSELL_FEATURE_FLAG } from "./settings.js";
export { BUNDLE_COMPLETION_OFFER_KEY } from "./types.js";
export type * from "./types.js";

export function createCartModule(deps: ModuleDeps): CartModule {
  return createCartService(deps);
}
