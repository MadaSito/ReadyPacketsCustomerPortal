import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { expect, it } from "vitest";
import { RouteFocus } from "@/app/RouteFocus";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, renderUi } from "@/ui/testing";
import type { AppRouter } from "@server/trpc/root";
import { CopyLogPage } from "./CopyLogPage";

const path = "/admin/storage/copies";
const publicId = "01JD0000000000000000000001";
const connectionPublicId = "01JD0000000000000000000002";
const time = new Date("2026-11-21T13:00:00.000Z");
const row = {
  publicId, connectionPublicId, connectionName: "Office storage", provider: "dropbox", jobPublicId: publicId,
  sourcePublicId: "01JD0000000000000000000003", kind: "order_file", attempt: 1, createdAt: time,
  startedAt: time, finishedAt: time, bytes: 481, state: "written", verified: false,
  verification: null, errorCode: null, correlationId: "copy-test",
};

function renderCopyLog() {
  const queryClient = createTestQueryClient();
  const requests: Array<{ route: string; input: unknown }> = [];
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc", transformer: superjson,
      fetch: async (request) => {
        const url = new URL(String(request));
        const input = JSON.parse(url.searchParams.get("input") ?? "{}") as Record<string, Parameters<typeof superjson.deserialize>[0]>;
        const routes = url.pathname.slice("/rpc/".length).split(",");
        return Response.json(routes.map((route, index) => {
          const envelope = input[String(index)];
          const data = envelope ? superjson.deserialize(envelope) : null;
          requests.push({ route, input: data });
          const result = route === "storage.copies.list"
            ? { items: [row], totals: { queued: 0, written: 1, verified: 0, failed: 0, not_written: 0 }, nextCursor: null }
            : route === "storage.copies.connections" ? { items: [{ publicId: connectionPublicId, name: row.connectionName }], nextCursor: null }
            : route === "storage.copies.detail" ? { ...row, canRetry: false } : null;
          if (!result) throw new Error(`Unexpected synthetic request: ${route}`);
          return { result: { data: superjson.serialize(result) } };
        }));
      },
    })],
  });
  renderUi(<main><RouteFocus title="Copy log" path={path} /><CopyLogPage /></main>, {
    queryClient, path, wrapper: (tree) => <TRPCProvider queryClient={queryClient} trpcClient={trpcClient}>{tree}</TRPCProvider>,
  });
  return requests;
}

pageA11y(path, async () => {
  renderCopyLog();
  await screen.findByRole("heading", { level: 1, name: "Copy log" });
  await screen.findByRole("table", { name: "Storage copy attempts" });
});

it("applies named filters and opens unverified write details by keyboard", async () => {
  const user = userEvent.setup();
  const requests = renderCopyLog();
  await screen.findByRole("option", { name: "Office storage" });
  await user.selectOptions(screen.getByLabelText("Connection"), connectionPublicId);
  await user.selectOptions(screen.getByLabelText("State"), "written");
  await user.type(screen.getByRole("searchbox", { name: "Search" }), "copy-test");
  await user.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() => expect(requests).toContainEqual({
    route: "storage.copies.list", input: { connectionPublicId, direction: "forward", state: "written", text: "copy-test" },
  }));
  const details = await within(screen.getByRole("table", { name: "Storage copy attempts" }))
    .findByRole("button", { name: /View Order file copy attempt/ });
  details.focus();
  await user.keyboard("{Enter}");
  const drawer = await screen.findByRole("dialog", { name: "Copy attempt details" });
  expect(await within(drawer).findByText("Not verified")).toBeVisible();
  expect(within(drawer).getByRole("link", { name: "View audit trail" })).toHaveAttribute("href", "/admin/audit?correlationId=copy-test");
  expect(within(drawer).queryByRole("button", { name: "Retry backup copy" })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(details).toHaveFocus());
});
