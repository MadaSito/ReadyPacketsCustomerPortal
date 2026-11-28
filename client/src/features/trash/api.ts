/**
 * Typed tRPC bridge for `trpc.trash.*` (increment 09 D2; router owner recovery_ops_engineer, UI audit_engineer).
 * Every type is inferred from the mounted server router, so the Trash centre cannot drift from the API. The server
 * decides scope, counts and permissions (D2.8): the client sends public ids, typed confirmations and idempotency keys.
 */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { useTRPC } from "@/lib/trpc";

type Out = inferRouterOutputs<AppRouter>["trash"];
type In = inferRouterInputs<AppRouter>["trash"];

export type TrashListInput = In["list"];
export type TrashListOutput = Out["list"];
export type TrashRow = TrashListOutput["items"][number];
export type TrashKind = TrashRow["kind"];
export type TrashState = TrashRow["state"];
export type TrashSort = TrashListInput["sort"];
export type TrashCounts = Out["counts"];
export type TrashSummary = Out["summarize"];
export type TrashItemRef = In["restore"]["items"][number];
export type TrashResults = Out["restore"];
export type TrashItemResult = Out["restore"]["results"][number] | Out["purge"]["results"][number];
export type TrashSettings = Out["settings"]["get"];
export type RetentionValues = In["settings"]["preview"];

export function useTrashApi() {
  return useTRPC().trash;
}
export type TrashApi = ReturnType<typeof useTrashApi>;
