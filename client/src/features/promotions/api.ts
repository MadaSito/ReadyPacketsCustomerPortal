/**
 * Typed access to `trpc.promotions.admin.*` (server/modules/promotions, siem_engineer, C1). Owner: audit engineer.
 * Types come straight from the mounted AppRouter (no cast). Every call goes through the session transport
 * (POST for anything carrying a code); the server enforces capability, feature flag and step-up — hiding a
 * button here is never authorisation.
 */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { useTRPC } from "@/lib/trpc";

type AdminIn = inferRouterInputs<AppRouter>["promotions"]["admin"];
type AdminOut = inferRouterOutputs<AppRouter>["promotions"]["admin"];

export type Page<T> = { items: T[]; nextCursor: string | null };
export type ListFilters = Omit<NonNullable<AdminIn["list"]>, "cursor">;
export type RedemptionFilters = Omit<NonNullable<AdminIn["redemptions"]>, "cursor">;
export type CsvFile = AdminOut["exportCodes"];

export function usePromotionsApi() {
  return useTRPC().promotions.admin;
}
