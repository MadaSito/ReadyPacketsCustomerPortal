/**
 * Client tests for `AnalyticsConsentSlot`, clean URL gating, input masking, zero browser storage,
 * WCAG AA (`axe-core`) accessibility, and INT-01 synchronous `markRealmTainted` ordering + quarantine.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router, Switch, useLocation } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealmTaintBoundary, TaintedRouteGate } from "@/app/RealmTaint";
import { AuthApiProvider, ME_QUERY_KEY, type MeResult } from "@/lib/authApi";
import {
  __resetRealmTaintForTests,
  __setHardNavigateForTests,
  isRealmTainted,
  realmTaintVendors,
} from "@/lib/realmTaint";
import { useSession } from "@/lib/session";
import { createApiClient, TRPCProvider } from "@/lib/trpc";
import { StepUpProvider, ThemeProvider, ToastProvider } from "@/ui";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi } from "@/ui/testing";
import {
  ANALYTICS_CONSENT_COPY,
  AnalyticsConsentSlot,
  isAnalyticsRealmTainted,
  resetAnalyticsConsentForTests,
} from "./consent";
import { integrationsFeature } from "./routes";

const unauthError = () =>
  Object.assign(new Error("UNAUTHENTICATED"), {
    data: { safe: { domainCode: "UNAUTHENTICATED" } },
  });

const signedInCustomer: MeResult = {
  user: {
    publicId: "01CUST00000000000000000001",
    role: "customer",
    name: "Alice Customer",
    email: "alice@example.test",
    status: "active",
  },
  state: "full",
  pendingSteps: [],
  nextStep: null,
};

const DISABLED_DEFAULT_CONFIG = {
  clarity: { enabled: false, projectId: null },
  posthog: { enabled: false, key: null, host: null },
};

const ACTIVE_CONFIG = {
  clarity: { enabled: true, projectId: "clarityProj99" },
  posthog: { enabled: true, key: "phc_ValidProjectToken123456", host: "https://eu.i.posthog.com" },
};

function renderWithBrowserRouter(
  ui: React.ReactElement,
  options: { initialUrl: string; meImpl?: () => Promise<MeResult> },
) {
  window.history.replaceState(null, "", options.initialUrl);
  const queryClient = createTestQueryClient();
  const trpcClient = createApiClient();
  const api = fakeAuthApi({
    me: options.meImpl ?? (() => Promise.reject(unauthError())),
  });
  const result = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <AuthApiProvider api={api}>
            <ToastProvider>
              <StepUpProvider>
                <Router>{ui}</Router>
              </StepUpProvider>
            </ToastProvider>
          </AuthApiProvider>
        </TRPCProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...result, queryClient };
}

describe("AnalyticsConsentSlot — privacy, default-disabled, markRealmTainted ordering & INT-01 quarantine", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    __setHardNavigateForTests(null);
    window.history.replaceState(null, "", "/privacy");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __setHardNavigateForTests(null);
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    window.history.replaceState(null, "", "/");
  });

  it("keeps Clarity and PostHog disabled by default and never taints the realm", async () => {
    renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={DISABLED_DEFAULT_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await act(async () => {});

    expect(screen.queryByText(ANALYTICS_CONSENT_COPY.heading)).toBeNull();
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isRealmTainted()).toBe(false);
    expect(realmTaintVendors()).toEqual([]);
  });

  it("sets markRealmTainted('clarity') BEFORE appending <script> and markRealmTainted('posthog') BEFORE fetch()", async () => {
    let taintedBeforeScriptAppend = false;
    let vendorsBeforeScriptAppend: readonly string[] = [];
    let taintedBeforePostHogFetch = false;
    let vendorsBeforePostHogFetch: readonly string[] = [];

    const origAppendChild = document.head.appendChild.bind(document.head);
    const appendSpy = vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement && node.getAttribute("data-rp-clarity") === "true") {
        taintedBeforeScriptAppend = isRealmTainted();
        vendorsBeforeScriptAppend = realmTaintVendors();
      }
      return origAppendChild(node);
    });

    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/capture/")) {
        taintedBeforePostHogFetch = isRealmTainted();
        vendorsBeforePostHogFetch = realmTaintVendors();
      }
      return new Response("{}", { status: 200 });
    });

    try {
      const { container } = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
        initialUrl: "/privacy",
      });

      expect(await screen.findByText(ANALYTICS_CONSENT_COPY.heading)).toBeInTheDocument();
      expect(isRealmTainted()).toBe(false);
      await expectNoAxeViolations(container);

      // Grant consent for session
      fireEvent.click(screen.getByRole("button", { name: ANALYTICS_CONSENT_COPY.allow }));

      await waitFor(() => {
        const script = document.querySelector('script[data-rp-clarity="true"]') as HTMLScriptElement | null;
        expect(script).not.toBeNull();
        expect(script?.src).toBe("https://www.clarity.ms/tag/clarityProj99");
      });

      // Verify synchronous taint flag ordering BEFORE `<script>` was appended and BEFORE `fetch()` ran
      expect(taintedBeforeScriptAppend).toBe(true);
      expect(vendorsBeforeScriptAppend).toContain("clarity");
      expect(taintedBeforePostHogFetch).toBe(true);
      expect(vendorsBeforePostHogFetch).toContain("posthog");

      // Root strict masking attribute set on `<html>`
      expect(document.documentElement.getAttribute("data-clarity-mask")).toBe("true");
      expect(isAnalyticsRealmTainted()).toBe(true);

      // PostHog direct capture sent without cookies/credentials and with person profiles disabled
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://eu.i.posthog.com/capture/");
      expect(init?.credentials).toBe("omit");
      const parsedBody = JSON.parse(String(init?.body));
      expect(parsedBody).toMatchObject({
        api_key: "phc_ValidProjectToken123456",
        event: "$pageview",
        properties: { $pathname: "/privacy", $process_person_profile: false },
      });
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("refuses to render or mount analytics when /privacy or /terms carries any ?query or #hash, on excluded paths, or when authenticated", async () => {
    for (const unsafeUrl of [
      "/privacy?reset_token=secret123",
      "/terms#invite=secret456",
      "/sign-in",
      "/orders",
      "/admin/integrations",
    ]) {
      const { unmount } = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
        initialUrl: unsafeUrl,
      });
      await act(async () => {});
      expect(screen.queryByText(ANALYTICS_CONSENT_COPY.heading)).toBeNull();
      expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(isRealmTainted()).toBe(false);
      unmount();
    }

    // Authenticated customer on clean `/privacy` NEVER sees banner or loads tags
    const { unmount } = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
      meImpl: async () => signedInCustomer,
    });
    await act(async () => {});
    expect(screen.queryByText(ANALYTICS_CONSENT_COPY.heading)).toBeNull();
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(isRealmTainted()).toBe(false);
    unmount();
  });

  it("quarantines non-public routes and authenticated session transitions in a tainted realm with zero private DOM commits", async () => {
    const hardNavCalls: Array<[string, string]> = [];
    __setHardNavigateForTests((mode, url) => {
      hardNavCalls.push([mode, url]);
    });

    function InnerGuardedRoutes() {
      const [, navigate] = useLocation();
      const { view, me } = useSession();
      return (
        <TaintedRouteGate>
          <div>
            {view.status === "full" && <header data-testid="private-shell">{me?.user.name}</header>}
            <button type="button" onClick={() => navigate("/terms")}>
              Go Terms
            </button>
            <button type="button" onClick={() => navigate("/orders?token=SECRET_TOKEN#frag")}>
              Go Private Orders
            </button>
            <Switch>
              <Route path="/privacy">
                <div data-testid="public-privacy">Privacy policy content</div>
              </Route>
              <Route path="/terms">
                <div data-testid="public-terms">Terms of service content</div>
              </Route>
              <Route path="/orders">
                <div data-testid="private-orders-secret">TOP SECRET CUSTOMER ORDER</div>
              </Route>
            </Switch>
          </div>
        </TaintedRouteGate>
      );
    }

    function GuardedAppHarness() {
      return (
        <>
          <RealmTaintBoundary>
            <InnerGuardedRoutes />
          </RealmTaintBoundary>
          <AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />
        </>
      );
    }

    const { unmount } = renderWithBrowserRouter(<GuardedAppHarness />, { initialUrl: "/privacy" });

    expect(await screen.findByText(ANALYTICS_CONSENT_COPY.heading)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ANALYTICS_CONSENT_COPY.allow }));
    await waitFor(() => expect(isRealmTainted()).toBe(true));

    // Observe EVERY DOM node ever added while tainted
    const leakedPrivateNodes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          const text = node.textContent ?? "";
          if (text.includes("TOP SECRET CUSTOMER ORDER") || text.includes("Alice Customer")) {
            leakedPrivateNodes.push(text);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      // 1. Clean public legal route `/privacy` -> `/terms` stays permitted
      fireEvent.click(screen.getByRole("button", { name: "Go Terms" }));
      expect(await screen.findByTestId("public-terms")).toBeInTheDocument();
      expect(hardNavCalls).toEqual([]);

      // 2. Navigating `/terms` -> `/orders?token=SECRET_TOKEN#frag` is intercepted BEFORE `history.pushState`:
      //    `window.location` NEVER exposes `/orders`, `?token=SECRET_TOKEN`, or `#frag` in the tainted realm,
      //    Clarity script/globals tear down synchronously, zero `/orders` DOM commits, and `requestCleanRealm` fires.
      fireEvent.click(screen.getByRole("button", { name: "Go Private Orders" }));
      expect(window.location.pathname).toBe("/terms");
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
      expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
      expect(screen.queryByTestId("private-orders-secret")).toBeNull();
      expect(leakedPrivateNodes).toEqual([]);
      expect(hardNavCalls).toEqual([["assign", "/orders"]]);
    } finally {
      observer.disconnect();
      unmount();
    }

    // 3. Session transition anonymous -> authenticated while on `/privacy` never commits `Alice Customer`
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    hardNavCalls.length = 0;

    const second = renderWithBrowserRouter(<GuardedAppHarness />, { initialUrl: "/privacy" });
    expect(await screen.findByText(ANALYTICS_CONSENT_COPY.heading)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ANALYTICS_CONSENT_COPY.allow }));
    await waitFor(() => expect(isRealmTainted()).toBe(true));

    const leakedSessionNodes: string[] = [];
    const sessionObserver = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (node.textContent?.includes("Alice Customer")) {
            leakedSessionNodes.push(node.textContent);
          }
        });
      }
    });
    sessionObserver.observe(document.body, { childList: true, subtree: true });

    try {
      act(() => {
        second.queryClient.setQueryData(ME_QUERY_KEY, signedInCustomer);
      });
      expect(await screen.findByTestId("realm-reloading")).toBeInTheDocument();
      expect(screen.queryByTestId("private-shell")).toBeNull();
      expect(leakedSessionNodes).toEqual([]);
      expect(hardNavCalls).toEqual([["replace", "/privacy"]]);
    } finally {
      sessionObserver.disconnect();
      second.unmount();
    }
  });

  it("spreads integrationsAdminRoutes and integrationsAdminNav into integrationsFeature", () => {
    expect(integrationsFeature.routes.map((r) => r.path)).toEqual([
      "/admin/integrations",
      "/admin/integrations/smtp",
      "/admin/integrations/analytics",
      "/admin/integrations/egress",
    ]);
    expect(integrationsFeature.nav?.map((n) => n.href)).toEqual(["/admin/integrations"]);
  });
});
