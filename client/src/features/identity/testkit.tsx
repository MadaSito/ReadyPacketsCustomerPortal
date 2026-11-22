/** Test-only helpers for identity suites: a tRPC client answering from fixtures. Never imported by app code. */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import type { AppRouter } from "@server/trpc/root";
import type { MeResult } from "@/lib/authApi";
import { TRPCProvider } from "@/lib/trpc";
import { createTestQueryClient, fakeAuthApi, renderUi } from "@/ui/testing";

export type Role = "customer" | "staff" | "admin";
export type Fixtures = Record<string, (input: unknown) => unknown>;

export function meFor(role: Role): MeResult {
  return {
    user: { publicId: "01JD0000000000000000000001", role, name: "Avery Example", email: "avery@example.test", customerRef: role === "customer" ? "RP-ABC1234" : null, status: "active" },
    state: "full",
    pendingSteps: [],
    nextStep: null,
  } as MeResult;
}

/** Renders `ui` with a fixture-backed tRPC client. A fixture that throws `{ safe }` answers as a tRPC error. */
export function renderWithTrpc(ui: ReactElement, records: Fixtures, options: { path?: string; role?: Role } = {}) {
  const queryClient = createTestQueryClient();
  const calls: { path: string; input: unknown }[] = [];
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc",
      transformer: superjson,
      fetch: async (request, init) => {
        const url = new URL(String(request));
        const data = JSON.parse((typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}") as
          Record<string, Parameters<typeof superjson.deserialize>[0]>;
        const paths = url.pathname.slice("/rpc/".length).split(",");
        const result = paths.map((path, index) => {
          const respond = records[path];
          // Shell requests (platform bootstrap, notifications …) answer NOT_FOUND per entry so the batch survives.
          if (!respond) return { error: superjson.serialize({ message: "not in fixture", code: -32004, data: { code: "NOT_FOUND", httpStatus: 404, path } }) };
          const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
          calls.push({ path, input });
          try {
            return { result: { data: superjson.serialize(respond(input)) } };
          } catch (thrown) {
            const safe = (thrown as { safe?: Record<string, unknown> }).safe;
            if (!safe) throw thrown;
            return { error: superjson.serialize({ message: String(safe.safeMessage ?? "error"), code: -32003, data: { code: "FORBIDDEN", httpStatus: 403, safe } }) };
          }
        });
        return Response.json(result);
      },
    })],
  });
  const api = fakeAuthApi({ me: async () => meFor(options.role ?? "admin") });
  const rendered = renderUi(ui, {
    api, queryClient, path: options.path, wrapper: (node) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{node}</TRPCProvider>,
  });
  return { ...rendered, calls };
}
