/**
 * Typed tRPC proxy bridge for `trpc.integrations.production.*`.
 * Keeps `client/src/features/integrations/production/**` strictly typed both before and after
 * the server router mount lands in `server/modules/integrations/router.ts`.
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

export interface ProductionTRPCProxy {
  pathKey: () => readonly unknown[];
  settings: {
    get: VoidQueryProcedure<ProductionSettingsView>;
    update: MutationProcedure<ProductionSettingsUpdateInput, ProductionSettingsView>;
    test: MutationProcedure<{ phase: ProductionPhase }, ProductionDestinationTestResult>;
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
