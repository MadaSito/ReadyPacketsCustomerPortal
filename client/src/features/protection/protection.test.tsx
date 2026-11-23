import { screen, waitFor, within } from "@testing-library/react";
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
import { CountriesPage, EventsPage, IpListsPage, OverviewPage, RateLimitsPage, RulesPage, SignInBansPage } from "./pages";
import { protectionPages } from "./routes";

const sampleTime = new Date("2026-11-21T13:00:00.000Z");
const testId = "01JD0000000000000000000001";
const backoff = { enabled: true, factor: 2, maxSeconds: 900, resetAfterMinutes: 30 };
const responses: Record<string, unknown> = {
  "protection.overview": { mode: "detect", bypassed: false, countrySourceConfigured: false, detected: 4, blocked: 0 },
  "protection.getPolicy": {
    version: 1,
    policy: {
      mode: "detect", managed: { injection: "detect", traversal: "detect", protocol: "detect", scanner: "detect", oversize: "detect" },
      custom: [], ipLists: [], countries: { mode: "off", codes: ["US"] }, automatic: { enabled: false, threshold: 8, minutes: 10 },
    },
  },
  "protection.getRateLimits": [{
    category: "api", defaults: { maxRequests: 300, windowSeconds: 60, backoff }, budget: { maxRequests: 300, windowSeconds: 60, backoff },
    bounds: { min: 40, max: 1200, maxWindow: 300 },
  }],
  "protection.listBlocks": { automatic: [], rateLimits: [{ publicId: testId, expiresAt: sampleTime, category: "api" }] },
  "protection.listSignInBans": {
    determinable: false, bypassed: false,
    policy: { enabled: true, threshold: 10, windowMinutes: 10, banMinutes: 15,
      escalation: { factor: 4, maxMinutes: 1440, memoryHours: 24 }, permanentAfter: null, countDistinctAccounts: true },
    items: [{ publicId: testId, address: "192.0.2.42", source: "automatic", reason: "Repeated failed sign-in attempts",
      strikes: 10, expiresAt: sampleTime, createdAt: sampleTime }],
  },
  "protection.listEvents": {
    items: [{ publicId: testId, createdAt: sampleTime, rule: "managed.traversal", method: "GET", route: "/api/:route",
      country: "US", agent: "Firefox", correlationId: "synthetic-correlation", action: "detect", ipAddress: "192.0.2.42" }],
    nextCursor: null,
  },
};

function renderPage(Component: ComponentType, path: string, title: string, fixtures = { ...responses }) {
  const queryClient = createTestQueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc", transformer: superjson,
      fetch: async (request) => {
        const routes = new URL(String(request)).pathname.slice("/rpc/".length).split(",");
        return Response.json(routes.map((route) => {
          if (!Object.hasOwn(fixtures, route)) throw new Error(`Unexpected synthetic request: ${route}`);
          const fixture = fixtures[route];
          return { result: { data: superjson.serialize(typeof fixture === "function" ? fixture() : fixture) } };
        }));
      },
    })],
  });
  return renderUi(<main><RouteFocus title={title} path={path} /><Component /></main>, {
    path, queryClient,
    wrapper: (tree) => <TRPCProvider queryClient={queryClient} trpcClient={client}>{tree}</TRPCProvider>,
  });
}

const pages = [
  [OverviewPage, "Sampled detections"], [RulesPage, "Managed rules"], [IpListsPage, "Manual IP lists"],
  [CountriesPage, "Country codes"], [RateLimitsPage, "Requests per window"], [EventsPage, "From (local time)"],
  [SignInBansPage, "Failure threshold"],
] as const;

for (const [index, page] of protectionPages.entries()) {
  const [Component, content] = pages[index]!;
  pageA11y(page.path, async () => {
    renderPage(Component, page.path, page.title);
    await screen.findByRole("heading", { level: 1, name: page.title });
    if (index >= 3) await screen.findByLabelText(content, { exact: false, selector: "input" });
    else await screen.findByText(content);
    expect(screen.getByRole("link", { name: page.navigation })).toHaveAttribute("aria-current", "page");
  });
}

it("keeps policy changes in a draft and returns focus when confirmation is cancelled", async () => {
  const user = userEvent.setup();
  renderPage(RulesPage, "/admin/protection/rules", "Protection rules");
  const protectionMode = await screen.findByLabelText("Protection mode");
  const review = screen.getByRole("button", { name: "Review policy changes" });
  expect(review).toBeDisabled();
  await user.selectOptions(protectionMode, "enforce");
  await user.click(review);
  expect(await screen.findByRole("alertdialog", { name: "Save protection policy?" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(review).toHaveFocus();
});

it("shows unverified address warning, disables manual bans, and keeps unban reachable", async () => {
  const user = userEvent.setup();
  renderPage(SignInBansPage, "/admin/protection/bans", "Sign-in bans");
  expect(await screen.findByText("Client address cannot be verified")).toBeVisible();
  expect(screen.getByRole("button", { name: "Review manual ban" })).toBeDisabled();
  const table = within(screen.getByRole("table", { name: "Active sign-in bans" }));
  expect(table.getByText("Repeated failed sign-in attempts")).toBeVisible();
  const unban = table.getByRole("button", { name: "Unban 192.0.2.42" });
  await user.click(unban);
  expect(await screen.findByRole("alertdialog", { name: "Release this sign-in ban?" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(unban).toHaveFocus();
});

it("stages rate back-off edits and asks for confirmation before saving", async () => {
  const user = userEvent.setup();
  renderPage(RateLimitsPage, "/admin/protection/rate-limits", "Protection rate limits");
  const backoffToggle = await screen.findByRole("checkbox", { name: "Increase waits after repeated refusals" });
  const review = screen.getByRole("button", { name: "Review limit" });
  expect(review).toBeDisabled();
  expect(backoffToggle).toBeChecked();
  await user.click(backoffToggle);
  expect(backoffToggle).not.toBeChecked();
  await user.click(review);
  expect(await screen.findByRole("alertdialog", { name: "Save rate limit?" })).toBeVisible();
});

it("moves focus to the ban results when a successful unban removes the trigger", async () => {
  const user = userEvent.setup();
  const list = responses["protection.listSignInBans"] as { items: unknown[] };
  let released = false;
  renderPage(SignInBansPage, "/admin/protection/bans", "Sign-in bans", {
    ...responses,
    "protection.listSignInBans": () => released ? { ...list, items: [] } : list,
    "protection.releaseSignInBan": () => { released = true; return { released }; },
  });
  const table = within(await screen.findByRole("table", { name: "Active sign-in bans" }));
  await user.click(table.getByRole("button", { name: "Unban 192.0.2.42" }));
  await user.click(await screen.findByRole("button", { name: "Unban address" }));
  await screen.findByRole("heading", { name: "No active sign-in bans" });
  await waitFor(() => expect(screen.getByRole("heading", { name: "Active sign-in bans" })).toContainElement(document.activeElement as HTMLElement));
});
