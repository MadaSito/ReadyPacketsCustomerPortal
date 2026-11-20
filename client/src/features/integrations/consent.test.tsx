/**
 * Client tests for `AnalyticsConsentSlot`, clean URL gating, input masking, zero browser storage,
 * WCAG AA (`axe-core`) accessibility, and synchronous JS-realm taint isolation.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router, Switch, useLocation } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiProvider, ME_QUERY_KEY, type MeResult } from "@/lib/authApi";
import { createApiClient, TRPCProvider } from "@/lib/trpc";
import { StepUpProvider, ThemeProvider, ToastProvider } from "@/ui";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi } from "@/ui/testing";
import {
  __setAnalyticsTestHooks,
  ANALYTICS_CONSENT_COPY,
  AnalyticsConsentSlot,
  isAnalyticsRealmQuarantined,
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

describe("AnalyticsConsentSlot — privacy, query/hash exclusion, masking & synchronous realm isolation", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAnalyticsConsentForTests();
    window.history.replaceState(null, "", "/privacy");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetAnalyticsConsentForTests();
    window.history.replaceState(null, "", "/");
  });

  it("renders accessible consent banner on clean /privacy, enforces data-clarity-mask, and never touches storage or cookies", async () => {
    const { container } = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });

    expect(await screen.findByText(ANALYTICS_CONSENT_COPY.heading)).toBeInTheDocument();
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    await expectNoAxeViolations(container);

    // Grant consent for session
    fireEvent.click(screen.getByRole("button", { name: ANALYTICS_CONSENT_COPY.allow }));

    await waitFor(() => {
      const script = document.querySelector('script[data-rp-clarity="true"]') as HTMLScriptElement | null;
      expect(script).not.toBeNull();
      expect(script?.src).toBe("https://www.clarity.ms/tag/clarityProj99");
    });

    // Root strict masking attribute set before tag execution
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

    // Consent is volatile in-memory only: withdrawing or resetting updates synchronously without reloads/storage
    expect(screen.getByText(ANALYTICS_CONSENT_COPY.grantedStatus)).toBeInTheDocument();
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
      // Give query resolution a tick
      await act(async () => {});
      expect(screen.queryByText(ANALYTICS_CONSENT_COPY.heading)).toBeNull();
      expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
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
    unmount();
  });

  it("synchronously blocks SPA private route commits in a Clarity-tainted realm and triggers hard navigation instead", async () => {
    const hardNavTargets: Array<string | undefined> = [];
    __setAnalyticsTestHooks({
      onRealmPurge: (targetUrl) => {
        hardNavTargets.push(targetUrl);
      },
    });

    function NavHarness() {
      const [, navigate] = useLocation();
      return (
        <div>
          <button type="button" onClick={() => navigate("/terms")}>
            Go Terms
          </button>
          <button type="button" onClick={() => navigate("/orders")}>
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
          <AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />
        </div>
      );
    }

    const { queryClient } = renderWithBrowserRouter(<NavHarness />, { initialUrl: "/privacy" });

    expect(await screen.findByText(ANALYTICS_CONSENT_COPY.heading)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ANALYTICS_CONSENT_COPY.allow }));
    await waitFor(() => expect(isAnalyticsRealmTainted()).toBe(true));

    // Observe EVERY DOM node ever added to `document.body` while the realm was tainted!
    const committedPrivateText: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (node.textContent?.includes("TOP SECRET CUSTOMER ORDER")) {
            committedPrivateText.push(node.textContent);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      // Navigating between clean public legal routes (`/privacy` -> `/terms`) is permitted without purging
      fireEvent.click(screen.getByRole("button", { name: "Go Terms" }));
      expect(await screen.findByTestId("public-terms")).toBeInTheDocument();
      expect(hardNavTargets).toHaveLength(0);
      expect(isAnalyticsRealmTainted()).toBe(true);

      // Navigating to `/orders` is intercepted SYNCHRONOUSLY inside `history.pushState` BEFORE wouter updates route!
      fireEvent.click(screen.getByRole("button", { name: "Go Private Orders" }));

      expect(hardNavTargets).toHaveLength(1);
      expect(hardNavTargets[0]).toMatch(/\/orders$/);
      expect(isAnalyticsRealmQuarantined()).toBe(true);
      expect(screen.queryByTestId("private-orders-secret")).toBeNull();
      expect(committedPrivateText).toEqual([]);
      expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
      expect(document.documentElement.getAttribute("data-clarity-mask")).toBeNull();
    } finally {
      observer.disconnect();
    }

    // Also verify synchronous `ME_QUERY_KEY` cache transition triggers quarantine immediately
    resetAnalyticsConsentForTests();
    const sessionPurges: Array<string | undefined> = [];
    __setAnalyticsTestHooks({ onRealmPurge: (u) => sessionPurges.push(u) });

    window.history.replaceState(null, "", "/privacy");
    const second = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    expect(await screen.findByText(ANALYTICS_CONSENT_COPY.heading)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ANALYTICS_CONSENT_COPY.allow }));
    await waitFor(() => expect(isAnalyticsRealmTainted()).toBe(true));

    act(() => {
      second.queryClient.setQueryData(ME_QUERY_KEY, signedInCustomer);
    });
    expect(sessionPurges).toHaveLength(1);
    expect(isAnalyticsRealmQuarantined()).toBe(true);
    void queryClient;
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
