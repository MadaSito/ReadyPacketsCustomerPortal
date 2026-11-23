/**
 * Test-only fixture-backed tRPC harness for Package I (`reports.test.tsx`). Never imported by app code.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import type { AppRouter } from "@server/trpc/root";
import type { AuthApi, MeResult } from "@/lib/authApi";
import { dropInfiniteDirectionLink, TRPCProvider } from "@/lib/trpc";
import { createTestQueryClient, fakeAuthApi, renderUi } from "@/ui/testing";

export type Role = "customer" | "staff" | "admin";
export type Fixtures = Record<string, (input: unknown) => unknown>;

const SHELL_PROMPT_HANDLERS: Fixtures = {
  "compliance.policies.enforcement.pending": () => [],
  "compliance.policies.myStatus": () => ({ pendingRequired: [] }),
};

export function meFor(role: Role): MeResult {
  return {
    user: {
      publicId: "01JD0000000000000000000001",
      role,
      name: role === "admin" ? "Ada Admin" : role === "staff" ? "Sam Staff" : "Cara Customer",
      email: `${role}@example.test`,
      customerRef: role === "customer" ? "RP-CUST01" : null,
      status: "active",
    },
    state: "full",
    pendingSteps: [],
    nextStep: null,
  } as MeResult;
}

export function throwSafeError(
  domainCode: string,
  safeMessage: string,
  extra: { code?: string; details?: Record<string, unknown> } = {},
): never {
  const code = extra.code ?? "BAD_REQUEST";
  const err = new Error(safeMessage) as Error & { safe: Record<string, unknown> };
  err.safe = {
    code,
    domainCode,
    reasonCode: domainCode,
    safeMessage,
    ...(extra.details ? { details: extra.details } : {}),
  };
  throw err;
}

export function renderReportsWithTrpc(
  ui: ReactElement,
  records: Fixtures,
  options: { path?: string; role?: Role; authOverrides?: Partial<AuthApi> } = {},
) {
  const queryClient = createTestQueryClient();
  const calls: { path: string; input: unknown }[] = [];

  const client = createTRPCClient<AppRouter>({
    links: [
      dropInfiniteDirectionLink,
      httpBatchLink({
        url: "https://portal.example.test/rpc",
        transformer: superjson,
        fetch: async (request, init) => {
          const url = new URL(String(request));
          const data = JSON.parse(
            (typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}",
          ) as Record<string, Parameters<typeof superjson.deserialize>[0]>;
          const paths = url.pathname.slice("/rpc/".length).split(",");
          const result = paths.map((path, index) => {
            const respond = records[path] ?? SHELL_PROMPT_HANDLERS[path];
            if (!respond) {
              return {
                error: superjson.serialize({
                  message: `not in fixture: ${path}`,
                  code: -32004,
                  data: { code: "NOT_FOUND", httpStatus: 404, path },
                }),
              };
            }
            const input =
              data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
            calls.push({ path, input });
            try {
              return { result: { data: superjson.serialize(respond(input)) } };
            } catch (thrown) {
              const safe = (thrown as { safe?: Record<string, unknown> }).safe;
              if (!safe) throw thrown;
              const code = String(safe.code ?? "BAD_REQUEST");
              const httpStatus =
                code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : code === "CONFLICT" ? 409 : 400;
              return {
                error: superjson.serialize({
                  message: String(safe.safeMessage ?? "Request refused"),
                  code: code === "NOT_FOUND" ? -32004 : -32003,
                  data: { code, httpStatus, safe },
                }),
              };
            }
          });
          return Response.json(result);
        },
      }),
    ],
  });

  const api = fakeAuthApi({
    me: async () => meFor(options.role ?? "admin"),
    ...options.authOverrides,
  });

  const rendered = renderUi(ui, {
    api,
    queryClient,
    path: options.path ?? "/admin/reports",
    wrapper: (node) => (
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {node}
      </TRPCProvider>
    ),
  });

  return { ...rendered, calls };
}
