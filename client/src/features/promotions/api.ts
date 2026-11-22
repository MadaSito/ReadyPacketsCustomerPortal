/**
 * Typed tRPC bridge for `trpc.promotions.admin.*` (server/modules/promotions, siem_engineer, C1). Owner: audit engineer.
 * Shapes are the agreed contract so the client type-checks before and after the router is mounted. Every call
 * goes through the session transport (POST for anything carrying a code); the server enforces capability,
 * feature flag and step-up — hiding a button here is never authorisation.
 */
import type { UseInfiniteQueryOptions, UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import type { PromotionCsvExportView } from "@server/modules/promotions/contracts";
import type { CreatePromotionInput, PromoDerivedStatus, PromoDiscountType, PromoRedemptionStatus, PromotionSettings, PromotionStats, PromotionView, RedemptionView, UpdatePromotionInput } from "./model";

export interface Page<T> { items: T[]; nextCursor: string | null }

interface Query<I, O> {
  queryOptions(input: I, opts?: Record<string, unknown>): UseQueryOptions<O, unknown, O, readonly unknown[]>;
  queryKey(input?: I): readonly unknown[];
  pathFilter(): { queryKey: readonly unknown[] };
}
interface InfiniteQuery<I, O> extends Query<I & { cursor?: string | null }, O> {
  infiniteQueryOptions(input: I, opts: { getNextPageParam: (last: O) => string | null | undefined }): UseInfiniteQueryOptions<O, unknown, { pages: O[] }, readonly unknown[], string | null>;
}
interface Mutation<I, O> {
  mutationOptions(opts?: UseMutationOptions<O, unknown, I>): UseMutationOptions<O, unknown, I>;
}

export type ListFilters = { status?: PromoDerivedStatus; type?: PromoDiscountType; endingWithinDays?: number; query?: string; limit?: number };
export type RedemptionFilters = { promotionPublicId?: string; status?: PromoRedemptionStatus; limit?: number };
export type CsvFile = PromotionCsvExportView;
type Ref = { publicId: string; expectedVersion: number };

/** server/modules/promotions/API.md — `trpc.promotions.admin.*`. */
export interface PromotionsAdminApi {
  list: InfiniteQuery<ListFilters, Page<PromotionView>>;
  get: Query<{ publicId: string }, PromotionView>;
  stats: Query<{ promotionPublicId?: string }, PromotionStats>;
  create: Mutation<CreatePromotionInput, { promotion: PromotionView; initialCode: string | null; generatedCount: number }>;
  update: Mutation<UpdatePromotionInput, PromotionView>;
  pause: Mutation<Ref, PromotionView>;
  resume: Mutation<Ref, PromotionView>;
  revoke: Mutation<Ref, PromotionView>;
  generateBatch: Mutation<{ publicId: string; count: number; prefix?: string | null; idempotencyKey: string }, { promotion: PromotionView; generated: number }>;
  reveal: Mutation<{ publicId: string; codePublicId?: string }, { code: string }>;
  redemptions: InfiniteQuery<RedemptionFilters, Page<RedemptionView>>;
  releaseRedemption: Mutation<{ redemptionPublicId: string; reason: string }, RedemptionView>;
  exportCodes: Mutation<{ publicId: string }, CsvFile>;
  exportRedemptions: Mutation<RedemptionFilters, CsvFile>;
  getSettings: Query<undefined, PromotionSettings>;
  updateSettings: Mutation<Partial<PromotionSettings>, PromotionSettings>;
}

export function usePromotionsApi(): PromotionsAdminApi {
  return (useTRPC() as unknown as { promotions: { admin: PromotionsAdminApi } }).promotions.admin;
}
