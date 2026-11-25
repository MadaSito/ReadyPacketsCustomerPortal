/**
 * Typed tRPC bridge for `trpc.automations.*` (server/modules/automations/API.md §3).
 * Owner: siem_engineer (Increment 07 Package G client).
 * The types come from the published contract so the client type-checks before and after the router is mounted.
 * Every call goes through the normal session transport; the server enforces capabilities and step-up.
 */
import type { UseInfiniteQueryOptions, UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
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
  CompletionJobState,
  OrderCompletionJobView,
  OrderStageActionsRunResult,
  OrderStageActionsView,
  OrderStageBundlePreviewView,
  OrderStageRunView,
  RunOrderStageBundleResult,
} from "@server/modules/automations/contracts";
import type { Catalogue, toSaveInput } from "./model";

interface Query<I, O> {
  queryOptions(input: I, opts?: Record<string, unknown>): UseQueryOptions<O, unknown, O, readonly unknown[]>;
  queryKey(input?: I): readonly unknown[];
  pathFilter(): { queryKey: readonly unknown[] };
}
interface InfiniteQuery<I, O extends { nextCursor: string | null }> extends Query<I, O> {
  infiniteQueryOptions(
    input: I,
    opts: { getNextPageParam: (lastPage: O) => string | undefined } & Record<string, unknown>,
  ): UseInfiniteQueryOptions<O, unknown, { pages: O[]; pageParams: unknown[] }, readonly unknown[], string | null>;
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
export type ListInput = {
  cursor?: string | null;
  limit?: number;
  enabled?: boolean;
  triggerMode?: AutomationTriggerMode;
  query?: string;
};
export type RunsInput = {
  automationPublicId?: string;
  orderPublicId?: string;
  state?: AutomationRunState;
  cursor?: string | null;
  limit?: number;
};
export type TestRunInput = Omit<SaveInput, "name" | "description" | "maxRunsPerHour" | "canvasLayout"> & {
  publicId?: string;
  sampleFields?: Record<string, string | number | boolean | null>;
  orderPublicId?: string;
  executeLive?: boolean;
};

export interface OrderStageActionsApi {
  pathFilter(): { queryKey: readonly unknown[] };
  get: Query<{ orderPublicId: string; runLimit?: number }, OrderStageActionsView>;
  listRuns: InfiniteQuery<
    { orderPublicId: string; cursor?: string | null; limit?: number },
    { items: AutomationRunView[]; nextCursor: string | null }
  >;
  runForOrder: Mutation<
    { orderPublicId: string; stepKey: string; idempotencyKey: string },
    OrderStageActionsRunResult
  >;
  previewBundle: Query<
    { orderPublicId: string; stageKey: string },
    OrderStageBundlePreviewView & { confirmationToken?: string }
  >;
  runBundle: Mutation<
    {
      orderPublicId: string;
      stageKey: string;
      idempotencyKey: string;
      confirmationToken: string;
      statusOverrideReason?: string | null;
    },
    RunOrderStageBundleResult
  >;
  listBundleRuns: InfiniteQuery<
    { orderPublicId: string; stageKey?: string; cursor?: string | null; limit?: number },
    { items: OrderStageRunView[]; nextCursor: string | null }
  >;
  listCompletionJobs: InfiniteQuery<
    {
      orderPublicId: string;
      stageKey?: string;
      state?: CompletionJobState;
      cursor?: string | null;
      limit?: number;
    },
    { items: OrderCompletionJobView[]; nextCursor: string | null }
  >;
  cancelCompletionJob: Mutation<
    { completionJobPublicId: string; reason?: string | null },
    OrderCompletionJobView
  >;
}

export interface AutomationsApi {
  catalogue: QueryNoInput<Catalogue>;
  settings: {
    get: QueryNoInput<AutomationSettingsView>;
    update: Mutation<Partial<AutomationSettingsView>, AutomationSettingsView>;
  };
  list: Query<ListInput, { items: AutomationSummaryView[]; nextCursor: string | null }>;
  get: Query<{ publicId: string }, AutomationDetailView>;
  versions: Query<{ publicId: string; limit?: number }, { items: AutomationVersionView[] }>;
  create: Mutation<SaveInput & { enabled?: boolean }, AutomationDetailView>;
  update: Mutation<SaveInput & { publicId: string; expectedVersion: number }, AutomationDetailView>;
  setEnabled: Mutation<{ publicId: string; expectedVersion: number; enabled: boolean }, AutomationDetailView>;
  duplicate: Mutation<{ publicId: string; name?: string }, AutomationDetailView>;
  delete: Mutation<{ publicId: string; expectedVersion: number }, { deleted: true }>;
  reorder: Mutation<{ orderedPublicIds: string[] }, { orderedPublicIds: string[] }>;
  triggerManual: Mutation<{ publicId: string; orderPublicId?: string }, { runPublicId: string; jobId: string }>;
  testRun: Mutation<TestRunInput, AutomationTestRunResult>;
  runs: {
    list: Query<RunsInput, { items: AutomationRunView[]; nextCursor: string | null }>;
    get: Query<{ runPublicId: string }, AutomationRunView>;
  };
  orderStageActions: OrderStageActionsApi;
}

export function useAutomationsApi(): AutomationsApi {
  return (useTRPC() as unknown as { automations: AutomationsApi }).automations;
}
