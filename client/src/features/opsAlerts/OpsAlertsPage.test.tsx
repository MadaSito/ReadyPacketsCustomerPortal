import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type * as wouter from "wouter";
import type * as trpcModule from "@/lib/trpc";
import { renderUi } from "@/ui/testing";
import OpsAlertsPage from "./OpsAlertsPage";

const mocks = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { user: { role: "staff" } } }) }));
vi.mock("wouter", async (load) => ({ ...await load<typeof wouter>(), useSearch: () => "state=open" }));
vi.mock("@/lib/trpc", async (load) => ({
  ...await load<typeof trpcModule>(),
  useTRPC: () => ({
    opsAlerts: {
      list: {
        infiniteQueryOptions: (input: unknown, options: object) => ({
          queryKey: ["alerts.list", input], queryFn: () => mocks.list(input), initialPageParam: null, ...options,
        }),
        pathKey: () => ["alerts.list"],
      },
      summary: { queryKey: () => ["alerts.summary"] },
      acknowledge: { mutationOptions: (options: object) => ({ mutationFn: vi.fn(), ...options }) },
      resolve: { mutationOptions: (options: object) => ({ mutationFn: mocks.resolve, ...options }) },
    },
  }),
}));

it("keeps keyboard focus during resolve and moves it to the result when the Open row disappears", async () => {
  const alert = { publicId: "alert-test", title: "Example warning", state: "open",
    source: "attention", severity: "warning", createdAt: new Date(), orderPublicId: null };
  let open = true;
  let finish!: () => void;
  mocks.list.mockImplementation(() => ({ items: open ? [alert] : [], nextCursor: null }));
  mocks.resolve.mockImplementation(() => new Promise<{ changed: true }>((res) => {
    finish = () => { open = false; res({ changed: true }); };
  }));
  const user = userEvent.setup();
  renderUi(<OpsAlertsPage />, { path: "/admin/alerts" });
  const [action] = await screen.findAllByRole("button", { name: "Resolve: Example warning" });
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ state: "open" }));
  action!.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(action).toHaveAttribute("aria-disabled", "true"));
  expect(action).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  finish();
  const status = await screen.findByText("Alert resolved.");
  await waitFor(() => expect(status).toHaveFocus());
  expect(screen.queryByRole("button", { name: "Resolve: Example warning" })).not.toBeInTheDocument();
});
