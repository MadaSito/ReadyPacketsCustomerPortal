import { screen } from "@testing-library/react";
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
import { CountriesPage, EventsPage, IpListsPage, OverviewPage, RateLimitsPage, RulesPage } from "./pages";
import { protectionPages } from "./routes";

const sampleTime = new Date("2026-11-21T13:00:00.000Z");
const testId = "01JD0000000000000000000001";
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
    category: "api", defaults: { maxRequests: 300, windowSeconds: 60 }, budget: { maxRequests: 300, windowSeconds: 60 },
    bounds: { min: 40, max: 1200, maxWindow: 300 },
  }],
  "protection.listBlocks": { automatic: [], rateLimits: [{ publicId: testId, expiresAt: sampleTime, category: "api" }] },
  "protection.listEvents": {
    items: [{ publicId: testId, createdAt: sampleTime, rule: "managed.traversal", method: "GET", route: "/api/:route",
      country: "US", agent: "Firefox", correlationId: "synthetic-correlation", action: "detect", ipAddress: "192.0.2.42" }],
    nextCursor: null,
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

const pages = [
  [OverviewPage, "Sampled detections"], [RulesPage, "Managed rules"], [IpListsPage, "Manual IP lists"],
  [CountriesPage, "Country codes"], [RateLimitsPage, "Requests per window"], [EventsPage, "From (local time)"],
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
