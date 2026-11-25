/**
 * Typed tRPC proxy bridge for `trpc.integrations.production.*`.
 * Keeps `client/src/features/integrations/production/**` strictly typed against the server surface.
 */
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type {
  ProductionDestinationTestResult,
  ProductionDispatchItem,
  ProductionListDispatchesInput,
  ProductionOrderPreview,
  ProductionPhase,
  ProductionSettingsUpdateInput,
  ProductionSettingsView,
  SetWorkflowAutoQueueInput,
  WorkflowAutoQueueItemView,
} from "./model";

interface QueryProcedure<TInput, TOutput> {
  queryOptions: (
    input: TInput,
  ) => UseQueryOptions<TOutput, unknown, TOutput, readonly unknown[]>;
  queryKey: (input?: TInput) => readonly unknown[];
}

interface VoidQueryProcedure<TOutput> {
  queryOptions: () => UseQueryOptions<TOutput, unknown, TOutput, readonly unknown[]>;
  queryKey: () => readonly unknown[];
}

interface MutationProcedure<TInput, TOutput> {
  mutationOptions: (
    opts?: UseMutationOptions<TOutput, unknown, TInput>,
  ) => UseMutationOptions<TOutput, unknown, TInput>;
}

export interface ProductionRedeliverInput {
  orderPublicId: string;
  dispatchPublicId: string;
  reason: string;
  confirmation: string;
  idempotencyKey: string;
}

export interface ProductionStopInput {
  orderPublicId: string;
  dispatchPublicId: string;
  reason?: string | null;
}

export interface ProductionRotateSigningSecretResult {
  settings: ProductionSettingsView;
  signingSecretOnce: string;
}

export interface ProductionTRPCProxy {
  pathKey: () => readonly unknown[];
  settings: {
    get: VoidQueryProcedure<ProductionSettingsView>;
    update: MutationProcedure<ProductionSettingsUpdateInput, ProductionSettingsView>;
    test: MutationProcedure<{ phase: ProductionPhase }, ProductionDestinationTestResult>;
    rotateSigningSecret: MutationProcedure<
      { overlapMinutes?: number } | undefined,
      ProductionRotateSigningSecretResult
    >;
    setSigningEnabled: MutationProcedure<{ signingEnabled: boolean }, ProductionSettingsView>;
  };
  workflowAutoQueue: {
    list: VoidQueryProcedure<{ items: WorkflowAutoQueueItemView[] }>;
    set: MutationProcedure<SetWorkflowAutoQueueInput, { items: WorkflowAutoQueueItemView[] }>;
  };
  order: {
    pathKey: () => readonly unknown[];
    preview: QueryProcedure<
      { orderPublicId: string; releaseStatus?: string },
      ProductionOrderPreview
    >;
    requestP101: MutationProcedure<
      { orderPublicId: string; releaseStatus?: string },
      ProductionDispatchItem
    >;
    requestP201: MutationProcedure<
      { orderPublicId: string; phase1ArtifactsConfirmed: boolean },
      ProductionDispatchItem
    >;
    requestP301: MutationProcedure<{ orderPublicId: string }, ProductionDispatchItem>;
    requestP401: MutationProcedure<{ orderPublicId: string }, ProductionDispatchItem>;
    stop: MutationProcedure<ProductionStopInput, ProductionDispatchItem>;
    retry: MutationProcedure<
      { orderPublicId: string; dispatchPublicId: string },
      ProductionDispatchItem
    >;
    redeliver: MutationProcedure<ProductionRedeliverInput, ProductionDispatchItem>;
    resend: MutationProcedure<
      {
        orderPublicId: string;
        phase: ProductionPhase;
        reason: string;
        releaseStatus?: string;
        phase1ArtifactsConfirmed?: boolean;
      },
      ProductionDispatchItem
    >;
    history: QueryProcedure<{ orderPublicId: string }, { items: ProductionDispatchItem[] }>;
  };
  admin: {
    listDispatches: QueryProcedure<
      ProductionListDispatchesInput,
      { items: ProductionDispatchItem[] }
    >;
  };
}

export interface ProductionTRPCClient {
  settings: {
    update: { mutate: (input: ProductionSettingsUpdateInput) => Promise<ProductionSettingsView> };
    test: {
      mutate: (input: { phase: ProductionPhase }) => Promise<ProductionDestinationTestResult>;
    };
    rotateSigningSecret: {
      mutate: (
        input?: { overlapMinutes?: number },
      ) => Promise<ProductionRotateSigningSecretResult>;
    };
    setSigningEnabled: {
      mutate: (input: { signingEnabled: boolean }) => Promise<ProductionSettingsView>;
    };
  };
  workflowAutoQueue: {
    set: {
      mutate: (input: SetWorkflowAutoQueueInput) => Promise<{ items: WorkflowAutoQueueItemView[] }>;
    };
  };
  order: {
    requestP101: {
      mutate: (input: {
        orderPublicId: string;
        releaseStatus?: string;
      }) => Promise<ProductionDispatchItem>;
    };
    requestP201: {
      mutate: (input: {
        orderPublicId: string;
        phase1ArtifactsConfirmed: boolean;
      }) => Promise<ProductionDispatchItem>;
    };
    requestP301: {
      mutate: (input: { orderPublicId: string }) => Promise<ProductionDispatchItem>;
    };
    requestP401: {
      mutate: (input: { orderPublicId: string }) => Promise<ProductionDispatchItem>;
    };
    stop: {
      mutate: (input: ProductionStopInput) => Promise<ProductionDispatchItem>;
    };
    retry: {
      mutate: (input: {
        orderPublicId: string;
        dispatchPublicId: string;
      }) => Promise<ProductionDispatchItem>;
    };
    redeliver: {
      mutate: (input: ProductionRedeliverInput) => Promise<ProductionDispatchItem>;
    };
    resend: {
      mutate: (input: {
        orderPublicId: string;
        phase: ProductionPhase;
        reason: string;
        releaseStatus?: string;
        phase1ArtifactsConfirmed?: boolean;
      }) => Promise<ProductionDispatchItem>;
    };
  };
}

export function useProductionTRPC(): ProductionTRPCProxy {
  const trpc = useTRPC();
  return (trpc.integrations as unknown as { production: ProductionTRPCProxy }).production;
}

export function useProductionClient(): ProductionTRPCClient {
  const client = useTRPCClient();
  return (client.integrations as unknown as { production: ProductionTRPCClient }).production;
}
