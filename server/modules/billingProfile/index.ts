/**
 * Billing profile module public surface and factory (Increment 08, Decision D4).
 * Owner: compliance_engineer.
 * See ./API.md for cross-module port contracts, tRPC procedures, and security invariants.
 */
import type { ModuleDeps } from "../../container.js";
import { billingProfileDetailsAad, createBillingProfileService } from "./service.js";
import type { BillingProfileModule } from "./types.js";

export { billingProfileDetailsAad };
export {
  BILLING_PROFILE_WRITE_SOURCES,
  billingDetailsSchema,
  clearBillingProfileInputSchema,
  saveBillingProfileInputSchema,
  type BillingDetails,
  type BillingDetailsInput,
  type BillingProfileModule,
  type BillingProfileRecord,
  type BillingProfileView,
  type BillingProfileWriteActor,
  type BillingProfileWriteSource,
  type ClearBillingProfileInput,
  type ClearBillingProfileResult,
  type GetBillingProfileInTxOptions,
  type SaveBillingProfileInput,
} from "./types.js";

export function createBillingProfileModule(deps: ModuleDeps): BillingProfileModule {
  return createBillingProfileService(deps);
}
