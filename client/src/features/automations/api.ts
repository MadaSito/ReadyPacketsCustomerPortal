/**
 * Typed tRPC bridge for `trpc.automations.*` (server/modules/automations/API.md §3). Owner: audit engineer.
 * The types come from the published contract so the client type-checks before and after the router is mounted.
 * Every call still goes through the normal session transport; the server enforces capabilities and step-up.
 */
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import type {
  AutomationDetailView,
  AutomationRunState,
  AutomationRunView,
  AutomationSettingsView,
  AutomationSummaryView,
  AutomationTestRunResult,
  AutomationTriggerMode,
  AutomationVersionView,
} from "@server/modules/automations/contracts";
import type { Catalogue, toSaveInput } from "./model";

interface Query<I, O> {
  queryOptions(input: I, opts?: Record<string, unknown>): UseQueryOptions<O, unknown, O, readonly unknown[]>;
  queryKey(input?: I): readonly unknown[];
  pathFilter(): { queryKey: readonly unknown[] };
}
interface QueryNoInput<O> {
  queryOptions(input?: undefined, opts?: Record<string, unknown>): UseQueryOptions<O, unknown, O, readonly unknown[]>;
  queryKey(): readonly unknown[];
  pathFilter(): { queryKey: readonly unknown[] };
}
interface Mutation<I, O> {
  mutationOptions(opts?: UseMutationOptions<O, unknown, I>): UseMutationOptions<O, unknown, I>;
}

export type SaveInput = ReturnType<typeof toSaveInput>;
export type ListInput = { cursor?: string | null; limit?: number; enabled?: boolean; triggerMode?: AutomationTriggerMode; query?: string };
export type RunsInput = { automationPublicId?: string; state?: AutomationRunState; cursor?: string | null; limit?: number };
export type TestRunInput = Omit<SaveInput, "name" | "description" | "maxRunsPerHour" | "canvasLayout"> & { publicId?: string; sampleFields?: Record<string, string | number | boolean | null>; orderPublicId?: string; executeLive?: boolean };

export interface AutomationsApi {
  catalogue: QueryNoInput<Catalogue>;
  settings: { get: QueryNoInput<AutomationSettingsView>; update: Mutation<Partial<AutomationSettingsView>, AutomationSettingsView> };
  list: Query<ListInput, { items: AutomationSummaryView[]; nextCursor: string | null }>;
  get: Query<{ publicId: string }, AutomationDetailView>;
  versions: Query<{ publicId: string; limit?: number }, { items: AutomationVersionView[] }>;
  create: Mutation<SaveInput & { enabled?: boolean }, AutomationDetailView>;
  update: Mutation<SaveInput & { publicId: string; expectedVersion: number }, AutomationDetailView>;
  setEnabled: Mutation<{ publicId: string; expectedVersion: number; enabled: boolean }, AutomationDetailView>;
  duplicate: Mutation<{ publicId: string; name?: string }, AutomationDetailView>;
  delete: Mutation<{ publicId: string; expectedVersion: number }, { deleted: true }>;
  triggerManual: Mutation<{ publicId: string; orderPublicId?: string }, { runPublicId: string; jobId: string }>;
  testRun: Mutation<TestRunInput, AutomationTestRunResult>;
  runs: { list: Query<RunsInput, { items: AutomationRunView[]; nextCursor: string | null }>; get: Query<{ runPublicId: string }, AutomationRunView> };
}

export function useAutomationsApi(): AutomationsApi {
  return (useTRPC() as unknown as { automations: AutomationsApi }).automations;
}
