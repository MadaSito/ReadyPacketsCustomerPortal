/**
 * Typed tRPC + HTTP bridge for `client/src/features/referrals/**` (Package G).
 * Keeps `tc.sh` clean both before and after `/root` mounts `referrals: referralsRouter` on `AppRouter`.
 */
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  REFERRAL_CODE_REGEX,
  type AdminReferralItemView,
  type AdminReferralsSettingsView,
  type AdminRewardLedgerItemView,
  type CursorPage,
  type CustomerReferralHistoryItemView,
  type CustomerReferralOverviewView,
  type ReferralExportPayload,
  type ReferralLedgerEntryType,
  type ReferralPayoutMethod,
  type ReferralProgramConfig,
  type ReferralStatus,
} from "./model";

interface QueryProcNoInput<TOutput> {
  queryOptions(
    opts?: Record<string, unknown>,
  ): UseQueryOptions<TOutput, unknown, TOutput, readonly unknown[]>;
  queryKey(): readonly unknown[];
}

interface QueryProc<TInput, TOutput> {
  queryOptions(
    input: TInput,
    opts?: Record<string, unknown>,
  ): UseQueryOptions<TOutput, unknown, TOutput, readonly unknown[]>;
  queryKey(input?: TInput): readonly unknown[];
}

interface MutationProc<TInput, TOutput> {
  mutationOptions(
    opts?: UseMutationOptions<TOutput, unknown, TInput>,
  ): UseMutationOptions<TOutput, unknown, TInput>;
}

export interface AdminListInput {
  status?: ReferralStatus;
  query?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface AdminLedgerInput {
  entryType?: ReferralLedgerEntryType;
  cursor?: string;
  limit?: number;
}

export interface ReferralsTRPCProxy {
  publicStatus: QueryProc<
    { code?: string } | undefined,
    { enabled: boolean; codeAcceptedFormat: boolean; normalizedCode: string | null }
  >;
  meOverview: QueryProcNoInput<CustomerReferralOverviewView>;
  meHistory: QueryProc<
    { cursor?: string; limit?: number } | undefined,
    CursorPage<CustomerReferralHistoryItemView>
  >;
  meSendInviteEmail: MutationProc<{ recipientEmail: string }, { accepted: true }>;
  adminGetSettings: QueryProcNoInput<AdminReferralsSettingsView>;
  adminUpdateSettings: MutationProc<
    { enabled: boolean; config: ReferralProgramConfig },
    AdminReferralsSettingsView
  >;
  adminList: QueryProc<AdminListInput | undefined, CursorPage<AdminReferralItemView>>;
  adminLedger: QueryProc<AdminLedgerInput | undefined, CursorPage<AdminRewardLedgerItemView>>;
  adminApprove: MutationProc<
    {
      referralPublicId: string;
      expectedVersion: number;
      overrideAmountMinor?: number;
      note?: string;
    },
    AdminReferralItemView
  >;
  adminReject: MutationProc<
    {
      referralPublicId: string;
      expectedVersion: number;
      reason: string;
    },
    AdminReferralItemView
  >;
  adminMarkCredited: MutationProc<
    {
      referralPublicId: string;
      expectedVersion: number;
      payoutMethod: ReferralPayoutMethod;
      reference: string;
      note?: string;
    },
    AdminReferralItemView
  >;
  adminExport: MutationProc<
    {
      format: "csv" | "json";
      status?: ReferralStatus;
      query?: string;
      from?: Date;
      to?: Date;
    },
    ReferralExportPayload
  >;
}

export interface ReferralsDirectClient {
  sendInviteEmail(input: { recipientEmail: string }): Promise<{ accepted: true }>;
  updateSettings(input: {
    enabled: boolean;
    config: ReferralProgramConfig;
  }): Promise<AdminReferralsSettingsView>;
  approve(input: {
    referralPublicId: string;
    expectedVersion: number;
    overrideAmountMinor?: number;
    note?: string;
  }): Promise<AdminReferralItemView>;
  reject(input: {
    referralPublicId: string;
    expectedVersion: number;
    reason: string;
  }): Promise<AdminReferralItemView>;
  markCredited(input: {
    referralPublicId: string;
    expectedVersion: number;
    payoutMethod: ReferralPayoutMethod;
    reference: string;
    note?: string;
  }): Promise<AdminReferralItemView>;
  exportReferrals(input: {
    format: "csv" | "json";
    status?: ReferralStatus;
    query?: string;
    from?: Date;
    to?: Date;
  }): Promise<ReferralExportPayload>;
}

export function useReferralsTRPC(): ReferralsTRPCProxy {
  const trpc = useTRPC() as unknown as {
    referrals: {
      publicStatus: ReferralsTRPCProxy["publicStatus"];
      me: {
        overview: ReferralsTRPCProxy["meOverview"];
        history: ReferralsTRPCProxy["meHistory"];
        sendInviteEmail: ReferralsTRPCProxy["meSendInviteEmail"];
      };
      admin: {
        getSettings: ReferralsTRPCProxy["adminGetSettings"];
        updateSettings: ReferralsTRPCProxy["adminUpdateSettings"];
        list: ReferralsTRPCProxy["adminList"];
        ledger: ReferralsTRPCProxy["adminLedger"];
        approve: ReferralsTRPCProxy["adminApprove"];
        reject: ReferralsTRPCProxy["adminReject"];
        markCredited: ReferralsTRPCProxy["adminMarkCredited"];
        export: ReferralsTRPCProxy["adminExport"];
      };
    };
  };

  return {
    publicStatus: trpc.referrals.publicStatus,
    meOverview: trpc.referrals.me.overview,
    meHistory: trpc.referrals.me.history,
    meSendInviteEmail: trpc.referrals.me.sendInviteEmail,
    adminGetSettings: trpc.referrals.admin.getSettings,
    adminUpdateSettings: trpc.referrals.admin.updateSettings,
    adminList: trpc.referrals.admin.list,
    adminLedger: trpc.referrals.admin.ledger,
    adminApprove: trpc.referrals.admin.approve,
    adminReject: trpc.referrals.admin.reject,
    adminMarkCredited: trpc.referrals.admin.markCredited,
    adminExport: trpc.referrals.admin.export,
  };
}

export function useReferralsClient(): ReferralsDirectClient {
  const client = useTRPCClient() as unknown as {
    referrals: {
      me: {
        sendInviteEmail: {
          mutate(input: { recipientEmail: string }): Promise<{ accepted: true }>;
        };
      };
      admin: {
        updateSettings: {
          mutate(input: {
            enabled: boolean;
            config: ReferralProgramConfig;
          }): Promise<AdminReferralsSettingsView>;
        };
        approve: {
          mutate(input: {
            referralPublicId: string;
            expectedVersion: number;
            overrideAmountMinor?: number;
            note?: string;
          }): Promise<AdminReferralItemView>;
        };
        reject: {
          mutate(input: {
            referralPublicId: string;
            expectedVersion: number;
            reason: string;
          }): Promise<AdminReferralItemView>;
        };
        markCredited: {
          mutate(input: {
            referralPublicId: string;
            expectedVersion: number;
            payoutMethod: ReferralPayoutMethod;
            reference: string;
            note?: string;
          }): Promise<AdminReferralItemView>;
        };
        export: {
          mutate(input: {
            format: "csv" | "json";
            status?: ReferralStatus;
            query?: string;
            from?: Date;
            to?: Date;
          }): Promise<ReferralExportPayload>;
        };
      };
    };
  };

  return {
    sendInviteEmail: (input) => client.referrals.me.sendInviteEmail.mutate(input),
    updateSettings: (input) => client.referrals.admin.updateSettings.mutate(input),
    approve: (input) => client.referrals.admin.approve.mutate(input),
    reject: (input) => client.referrals.admin.reject.mutate(input),
    markCredited: (input) => client.referrals.admin.markCredited.mutate(input),
    exportReferrals: (input) => client.referrals.admin.export.mutate(input),
  };
}

let inMemoryHeldCode: string | null = null;

export function getInMemoryHeldReferralCode(): string | null {
  return inMemoryHeldCode;
}

export async function holdReferralCodeFirstParty(rawCode: string): Promise<void> {
  const normalized = rawCode.trim().toUpperCase();
  if (!REFERRAL_CODE_REGEX.test(normalized)) return;
  inMemoryHeldCode = normalized;
  try {
    await sessionFetch(apiUrl("/api/referrals/hold"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: normalized }),
    });
  } catch {
    // Best-effort hold; URL `?ref=` and in-memory fallback remain available.
  }
}

export async function fetchHeldReferralCodeFirstParty(): Promise<string | null> {
  try {
    const res = await sessionFetch(apiUrl("/api/referrals/hold"), {
      method: "GET",
    });
    if (!res.ok) return inMemoryHeldCode;
    const payload = (await res.json()) as { code?: unknown };
    if (typeof payload.code === "string" && REFERRAL_CODE_REGEX.test(payload.code)) {
      inMemoryHeldCode = payload.code;
      return payload.code;
    }
    return inMemoryHeldCode;
  } catch {
    return inMemoryHeldCode;
  }
}

export async function clearHeldReferralCodeFirstParty(): Promise<void> {
  inMemoryHeldCode = null;
  try {
    await sessionFetch(apiUrl("/api/referrals/hold"), {
      method: "DELETE",
    });
  } catch {
    // Best-effort cleanup after registration completes.
  }
}
