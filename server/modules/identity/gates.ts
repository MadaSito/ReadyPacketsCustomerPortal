/**
 * Increment 04 (package D): gates other modules own, consumed through their published ports.
 * - Customer maintenance (package E): `jobAdmin.maintenance.customerAccess(tx?)`.
 * - Referral attribution (package G): `referrals.attributeRegistration(code, newUserId, tx)`.
 * A port that is not mounted (tests, partial deployments) means "no gate" / "no attribution".
 */
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";

export interface CustomerAccessStatus {
  active: boolean;
  message: string | null;
  expectedEnd: string | null;
}

type MaintenancePort = { maintenance?: { customerAccess?: (tx?: Tx) => Promise<CustomerAccessStatus> } };
type ReferralsPort = { attributeRegistration?: (code: string, newUserId: number, tx: Tx) => Promise<{ attributed: boolean; reasonCode?: string }> };

export const REFERRAL_CODE = /^[0-9A-Z]{10}$/;

export const customerMaintenance = (status: CustomerAccessStatus) =>
  new DomainError(
    "FORBIDDEN",
    "CUSTOMER_MAINTENANCE",
    status.expectedEnd
      ? "Customer sign-in is paused for scheduled maintenance. Please try again after the time shown on the sign-in page."
      : "Customer sign-in is paused for scheduled maintenance. Please try again later.",
    status.expectedEnd ? { expectedEnd: status.expectedEnd } : undefined,
  );

export function createGates(deps: ModuleDeps) {
  const services = deps.services as unknown as { jobAdmin?: MaintenancePort; referrals?: ReferralsPort };
  return {
    /** Throws CUSTOMER_MAINTENANCE while customer maintenance is active. Pass `tx` for the authoritative check. */
    async assertCustomerAccess(tx?: Tx): Promise<void> {
      const port = services.jobAdmin?.maintenance?.customerAccess;
      if (!port) return;
      const status = await port(tx);
      if (status.active) throw customerMaintenance(status);
    },

    /** Never throws for an unknown / disabled / self code. Returns whether a referral was attributed. */
    async attributeReferral(code: string | undefined, newUserId: number, tx: Tx): Promise<{ attributed: boolean; reasonCode?: string }> {
      if (!code) return { attributed: false };
      const normalized = code.trim().toUpperCase();
      if (!REFERRAL_CODE.test(normalized)) return { attributed: false, reasonCode: "CODE_FORMAT" };
      const port = services.referrals?.attributeRegistration;
      if (!port) return { attributed: false, reasonCode: "REFERRALS_UNAVAILABLE" };
      try {
        return await port(normalized, newUserId, tx);
      } catch (error) {
        // Attribution is never a reason to refuse an account (a failed MySQL statement rolls back on its own).
        deps.logger.warn("identity.referral.attribution_failed", { errorName: error instanceof Error ? error.name : "unknown" });
        return { attributed: false, reasonCode: "ATTRIBUTION_FAILED" };
      }
    },
  };
}
export type Gates = ReturnType<typeof createGates>;
