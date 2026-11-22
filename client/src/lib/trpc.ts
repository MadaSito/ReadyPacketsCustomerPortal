/**
 * Typed tRPC client + TanStack Query wiring. Owner: UI foundation engineer (integrator-seeded baseline).
 *
 * Usage in components:
 *   const trpc = useTRPC();
 *   const orders = useQuery(trpc.orders.list.queryOptions({ cursor }));
 *   const create = useMutation(trpc.orders.create.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.orders.list.queryKey() }) }));
 *
 * Session transport is handled in `sessionTransport.ts`; feature code never touches tokens.
 */
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, httpLink, splitLink, type TRPCClientErrorLike, type TRPCLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import superjson from "superjson";
import type { AppRouter } from "@server/trpc/root";
import type { SafeErrorData } from "@server/trpc/trpc";
import { TRPC_CLIENT_MAX_URL_LENGTH, TRPC_MAX_BATCH_SIZE } from "@shared/apiLimits";
import { apiUrl } from "./runtime";
import { sessionFetch } from "./sessionTransport";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          const code = safeError(error)?.domainCode;
          if (code && code !== "UNAVAILABLE" && code !== "INTERNAL") return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Infinite queries make the tRPC client add a `direction` field ("forward" | "backward") to the input.
 * No server procedure declares it, and server inputs are strict (unknown fields are rejected), so it is
 * removed here, in one place, instead of loosening validation on every paged procedure.
 */
export const dropInfiniteDirectionLink: TRPCLink<AppRouter> = () => ({ op, next }) => {
  const input: unknown = op.input;
  if (op.type !== "query" || typeof input !== "object" || input === null || Array.isArray(input)) return next(op);
  const record = input as Record<string, unknown>;
  if (record.direction !== "forward" && record.direction !== "backward") return next(op);
  const { direction: _direction, ...rest } = record;
  return next({ ...op, input: rest });
};

export function createApiClient() {
  const transport = { url: apiUrl("/api/trpc"), transformer: superjson, fetch: sessionFetch };
  return createTRPCClient<AppRouter>({
    links: [dropInfiniteDirectionLink, splitLink({
      // These two mutations have a dedicated, non-batch HTTP body budget for workflow packages.
      condition: ({ type, path }) => type === "mutation" &&
        (path === "orders.admin.workflows.transfer.preview" || path === "orders.admin.workflows.transfer.applyImport"),
      true: httpLink(transport),
      false: httpBatchLink({ ...transport, maxItems: TRPC_MAX_BATCH_SIZE, maxURLLength: TRPC_CLIENT_MAX_URL_LENGTH }),
    })],
  });
}

/** Extracts the server's safe, user-presentable error (never raw internals). */
export function safeError(error: unknown): SafeErrorData | undefined {
  const data = (error as TRPCClientErrorLike<AppRouter> | undefined)?.data as { safe?: SafeErrorData } | undefined;
  return data?.safe;
}

export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  return safeError(error)?.safeMessage ?? fallback;
}
