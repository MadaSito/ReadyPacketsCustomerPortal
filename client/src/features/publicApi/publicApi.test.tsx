import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ComponentType } from "react";
import superjson from "superjson";
import { expect, it } from "vitest";
import { RouteFocus } from "@/app/RouteFocus";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, renderUi } from "@/ui/testing";
import type { AppRouter } from "@server/trpc/root";
import { KeysPage, LogPage, RequestDetailPage } from "./pages";

const time = new Date("2026-11-21T13:00:00.000Z");
const keyId = "01JD0000000000000000000001";
const requestId = "01JD0000000000000000000002";
const key = {
  keyId, name: "ERP sync", prefix: "rpk_abcdefghjkmn", scopes: ["orders:read"], expiresAt: null, ipAllowList: [], rateLimitPerMinute: 120,
  requireSigning: false, state: "active", version: 1, lastUsedAt: time, createdAt: time, rotatedAt: null, revokedAt: null,
};
const responses: Record<string, unknown> = {
  "publicApi.admin.settings.get": { enabled: false, retentionDays: 30, version: 0 },
  "publicApi.admin.keys.list": { items: [key], nextCursor: null },
  "publicApi.admin.log.list": {
    items: [{ requestId, keyId, method: "GET", route: "/orders", path: "/orders", status: 200, durationMs: 12, correlationId: "c:synthetic", errorCode: null, replayOf: null, createdAt: time }],
    nextCursor: null,
  },
  "publicApi.admin.log.get": {
    requestId, keyId, method: "POST", route: "/orders", path: "/orders", status: 201, durationMs: 15, correlationId: "c:synthetic", errorCode: null,
    requestBytes: 40, responseBytes: 120, ipAddress: "192.0.2.10", idempotencyKey: "digest", replayOf: null, replayable: true, bodyTruncated: false,
    request: { headers: { "content-type": "application/json", authorization: "[redacted]" }, query: {}, body: { customerId: "01JD0000000000000000000003" } },
    response: { data: { id: "01JD0000000000000000000004" } }, replays: [], createdAt: time,
  },
};

function renderPage(Component: ComponentType, path: string, title: string) {
  const queryClient = createTestQueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc", transformer: superjson,
      fetch: async (request) => {
        const routes = new URL(String(request)).pathname.slice("/rpc/".length).split(",");
        return Response.json(routes.map((route) => {
          if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected synthetic request: ${route}`);
          return { result: { data: superjson.serialize(responses[route]) } };
        }));
      },
    })],
  });
  return renderUi(<main><RouteFocus title={title} path={path} /><Component /></main>, {
    path, queryClient,
    wrapper: (tree) => <TRPCProvider queryClient={queryClient} trpcClient={client}>{tree}</TRPCProvider>,
  });
}

pageA11y("/admin/api ready", async () => {
  renderPage(KeysPage, "/admin/api", "API keys");
  await screen.findByRole("heading", { level: 1, name: "API keys" });
  expect((await screen.findAllByText("rpk_abcdefghjkmn")).length).toBeGreaterThan(0);
});

pageA11y("/admin/api create dialog open", async () => {
  const user = userEvent.setup();
  renderPage(KeysPage, "/admin/api", "API keys");
  await user.click(await screen.findByRole("button", { name: "Create API key" }));
  await screen.findByRole("dialog", { name: "Create API key" });
});

pageA11y("/admin/api/log ready", async () => {
  renderPage(LogPage, "/admin/api/log", "API request log");
  await screen.findByRole("heading", { level: 1, name: "API request log" });
  expect((await screen.findAllByText("GET /orders")).length).toBeGreaterThan(0);
});

pageA11y("/admin/api/log/:requestId ready", async () => {
  renderPage(RequestDetailPage, `/admin/api/log/${requestId}`, "API request details");
  await screen.findByRole("heading", { level: 1, name: "API request details" });
  await screen.findByText("192.0.2.10");
});

it("validates the create form before sending and closes on Escape", async () => {
  const user = userEvent.setup();
  renderPage(KeysPage, "/admin/api", "API keys");
  const open = await screen.findByRole("button", { name: "Create API key" });
  await user.click(open);
  const dialog = await screen.findByRole("dialog", { name: "Create API key" });
  await user.click(within(dialog).getByRole("button", { name: "Create key" }));
  expect(await within(dialog).findByText("Enter a name.")).toBeVisible();
  await user.type(within(dialog).getByLabelText("Name", { exact: false }), "Billing");
  await user.click(within(dialog).getByRole("button", { name: "Create key" }));
  expect(await within(dialog).findByText("Choose at least one scope.")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("asks for confirmation before replaying a write call", async () => {
  const user = userEvent.setup();
  renderPage(RequestDetailPage, `/admin/api/log/${requestId}`, "API request details");
  await user.click(await screen.findByRole("button", { name: "Replay request" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Replay this request?" });
  expect(within(dialog).getByText(/write call/u)).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});
