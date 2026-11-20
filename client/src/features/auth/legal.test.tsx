import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResult } from "@/lib/authApi";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { AppRoutes } from "@/app/AppRouter";
import {
  AnalyticsConsentSlot,
  CLIENT_ALLOWED_ANALYTICS_PATHS,
  isEligibleAnalyticsPath,
  resetAnalyticsConsentForTests,
} from "@/features/integrations/consent";
import { authFeature } from "./routes";
import { MARKETING_POLICY_URLS } from "./legal/LegalLayout";
import PrivacyPage from "./pages/PrivacyPage";

vi.mock("@/app/slots", () => ({ NotificationSlot: () => null, GlobalSearchSlot: () => null, AnalyticsConsentSlot: () => null }));
vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpcModule>()),
  useTRPC: () => ({
    integrations: { publicAnalyticsConfig: { queryOptions: () => ({ queryKey: ["rp", "integrations", "publicAnalyticsConfig"], queryFn: async () => null }) } },
  }),
}));

const unauth = () => Promise.reject(Object.assign(new Error("UNAUTHENTICATED"), { data: { safe: { domainCode: "UNAUTHENTICATED" } } }));
const customer: MeResult = {
  user: { publicId: "u1", role: "customer", name: "Avery Example", email: "a@example.test", status: "active" },
  state: "full",
  pendingSteps: [],
  nextStep: null,
};
const LEGAL_ROUTES = authFeature.routes.filter((route) => route.path === "/privacy" || route.path === "/terms");

describe("public legal pages", () => {
  it("registers /privacy and /terms as public routes", () => {
    expect(LEGAL_ROUTES.map((route) => [route.path, route.access])).toEqual([
      ["/privacy", "public"],
      ["/terms", "public"],
    ]);
  });

  for (const [path, title, canonical] of [
    ["/privacy", "Portal privacy notice", MARKETING_POLICY_URLS.privacy],
    ["/terms", "Portal terms of use", MARKETING_POLICY_URLS.terms],
  ] as const) {
    it(`${path} renders for an anonymous visitor with one h1, a draft notice, the canonical link and no axe violations`, async () => {
      const { container, location } = renderUi(<AppRoutes routes={authFeature.routes} />, { path, api: fakeAuthApi({ me: unauth }) });
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(location.history?.at(-1)).toBe(path); // no redirect to sign-in
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(screen.getByText("Draft — pending legal review")).toBeInTheDocument();
      const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
      expect(links).toContain(canonical);
      for (const link of screen.getAllByRole("link")) {
        if (link.getAttribute("target") === "_blank") expect(link).toHaveAttribute("rel", "noopener noreferrer");
      }
      await expectNoAxeViolations(container);
    });

    it(`${path} also renders for a signed-in customer (inside the customer shell, not a redirect)`, async () => {
      const { location } = renderUi(<AppRoutes routes={authFeature.routes} />, { path, api: fakeAuthApi({ me: async () => customer }) });
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(location.history?.at(-1)).toBe(path);
      expect(document.querySelectorAll("h1")).toHaveLength(1);
    });
  }

  it("/privacy discloses the production pipeline as a recipient of order metadata, client name and email when an order is started", async () => {
    const { container } = renderUi(<AppRoutes routes={authFeature.routes} />, {
      path: "/privacy",
      api: fakeAuthApi({ me: unauth }),
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Who receives your information" })).toBeInTheDocument();
    expect(screen.getByText(/Production pipeline \(when an order is started\):/)).toBeInTheDocument();
    expect(screen.getByText(/order metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/order owner's name and email address/i)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe("consent-gated analytics on the legal pages", () => {
  beforeEach(() => {
    resetAnalyticsConsentForTests();
    window.history.replaceState(null, "", "/privacy");
  });
  afterEach(() => {
    resetAnalyticsConsentForTests();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("the loader's allowlist is exactly the two routes this feature serves", () => {
    expect([...CLIENT_ALLOWED_ANALYTICS_PATHS].sort()).toEqual(LEGAL_ROUTES.map((route) => route.path).sort());
    for (const route of LEGAL_ROUTES) {
      expect(isEligibleAnalyticsPath(route.path)).toBe(true);
    }
    expect(isEligibleAnalyticsPath("/sign-in")).toBe(false);
  });

  it("an anonymous visitor on /privacy gets a reachable consent control; allowing sends only a credential-less pageview", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderUi(
      <>
        <PrivacyPage />
        <AnalyticsConsentSlot
          configOverride={{ clarity: { enabled: false, projectId: null }, posthog: { enabled: true, key: "phc_testkey1234567890", host: "https://eu.i.posthog.com" } }}
        />
      </>,
      { path: "/privacy", api: fakeAuthApi({ me: unauth }) },
    );
    const panel = await screen.findByRole("region", { name: "Optional public-page analytics" });
    expect(panel).toBeInTheDocument();
    const allow = screen.getByRole("button", { name: "Allow for session" });
    const decline = screen.getByRole("button", { name: "Decline" });
    for (const button of [allow, decline]) {
      button.focus();
      expect(button).toHaveFocus();
    }
    expect(fetchMock).not.toHaveBeenCalled(); // nothing before consent
    await expectNoAxeViolations(container);

    fireEvent.click(allow);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://eu.i.posthog.com/capture/");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body)).properties.$pathname).toBe("/privacy");
    expect(await screen.findByRole("button", { name: "Withdraw consent" })).toBeInTheDocument();
  });

  it("stays silent for a signed-in user on the same page", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderUi(
      <>
        <PrivacyPage />
        <AnalyticsConsentSlot
          configOverride={{ clarity: { enabled: false, projectId: null }, posthog: { enabled: true, key: "phc_testkey1234567890", host: "https://eu.i.posthog.com" } }}
        />
      </>,
      { path: "/privacy", api: fakeAuthApi({ me: async () => customer }) },
    );
    await screen.findByRole("heading", { level: 1, name: "Portal privacy notice" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Optional public-page analytics" })).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
