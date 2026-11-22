/**
 * Referrals module — public service surface and factory. Owner: siem_engineer (Package G).
 */
import "./settings.js";
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { registerReferralsMailTemplates } from "./mail.js";
import {
  createReferralsService,
  type AdminReferralItemView,
  type AdminReferralsSettingsView,
  type AdminRewardLedgerItemView,
  type AttributeRegistrationResult,
  type CursorPage,
  type CustomerReferralHistoryItemView,
  type CustomerReferralOverviewView,
  type InvoicePaidReferralEvent,
  type InvoiceRefundedReferralEvent,
  type OnInvoicePaidReferralOutcome,
  type OnInvoicePaidReferralResult,
  type OnInvoiceRefundedReferralOutcome,
  type OnInvoiceRefundedReferralResult,
  type ReferralAttributionRefusalCode,
  type ReferralsService,
  type ValidateReferralCodeResult,
} from "./service.js";

export * from "./settings.js";
export type {
  AdminReferralItemView,
  AdminReferralsSettingsView,
  AdminRewardLedgerItemView,
  AttributeRegistrationResult,
  CursorPage,
  CustomerReferralHistoryItemView,
  CustomerReferralOverviewView,
  InvoicePaidReferralEvent,
  InvoiceRefundedReferralEvent,
  OnInvoicePaidReferralOutcome,
  OnInvoicePaidReferralResult,
  OnInvoiceRefundedReferralOutcome,
  OnInvoiceRefundedReferralResult,
  ReferralAttributionRefusalCode,
  ValidateReferralCodeResult,
};

export interface ReferralsModule extends ModuleLifecycle, ReferralsService {}

export function createReferralsModule(deps: ModuleDeps): ReferralsModule {
  registerReferralsMailTemplates(deps.mailer);
  const service = createReferralsService(deps);

  return {
    ...service,
    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const { enabled, totalReferrals } = await service.healthCounts();
        return [
          {
            component: "referrals",
            state: enabled ? "ok" : "disabled",
            summary: enabled
              ? "Customer referral programme is enabled."
              : "Customer referral programme is disabled.",
            metrics: { referrals: totalReferrals },
            checkedAt,
          },
        ];
      } catch {
        return [
          {
            component: "referrals",
            state: "failing",
            summary: "Referral store health check failed.",
            checkedAt,
          },
        ];
      }
    },
  };
}
