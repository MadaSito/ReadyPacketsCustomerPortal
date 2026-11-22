/**
 * Client tests for `AnalyticsConsentSlot` shared `@/lib/consent` cutover (J-01, J-04),
 * separate `analytics` vs `session_replay` category gates, `/accessibility` & unsafe URL exclusion,
 * withdrawal / cross-tab / expiry teardown, and INT-01 synchronous `markRealmTainted` quarantine.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router, Switch, useLocation } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealmTaintBoundary, TaintedRouteGate } from "@/app/RealmTaint";
import { AuthApiProvider, ME_QUERY_KEY, type MeResult } from "@/lib/authApi";
import {
  CONSENT_STORAGE_KEY,
  __setConsentForTests,
  __storageForTests,
  applyConsentDecision,
  consent,
} from "@/lib/consent";
import {
  __resetRealmTaintForTests,
  __setHardNavigateForTests,
  isRealmTainted,
  realmTaintVendors,
} from "@/lib/realmTaint";
import { useSession } from "@/lib/session";
import { createApiClient, TRPCProvider } from "@/lib/trpc";
import { StepUpProvider, ThemeProvider, ToastProvider } from "@/ui";
import { createTestQueryClient, fakeAuthApi } from "@/ui/testing";
import {
  ANALYTICS_CONSENT_COPY,
  AnalyticsConsentSlot,
  CLIENT_ALLOWED_ANALYTICS_PATHS,
  isAnalyticsRealmTainted,
  isEligibleAnalyticsPath,
  isPostHogCapturingEnabled,
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

describe("AnalyticsConsentSlot — shared @/lib/consent cutover (J-01, J-04) & INT-01 quarantine", () => {
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
    delete (window as Window & { posthog?: unknown }).posthog;
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    window.history.replaceState(null, "", "/");
  });

  it("renders no legacy opt-in UI and loads zero vendor code when privacy.consent is off or undecided", async () => {
    // 1. Default disabled config
    const first = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={DISABLED_DEFAULT_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await act(async () => {});
    expect(screen.queryByText(ANALYTICS_CONSENT_COPY.heading)).toBeNull();
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isRealmTainted()).toBe(false);
    first.unmount();

    // 2. Both vendors admin-configured, BUT shared `privacy.consent` feature is OFF (`enabled: false`),
    //    even if choices object is passed — zero legacy opt-in banner, zero network/script activity (J-04)
    __setConsentForTests({
      enabled: false,
      policyVersion: 1,
      choices: { preferences: true, analytics: true, session_replay: true },
    });
    const second = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await act(async () => {});
    expect(screen.queryByText(ANALYTICS_CONSENT_COPY.heading)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isPostHogCapturingEnabled()).toBe(false);
    expect(isRealmTainted()).toBe(false);
    expect(realmTaintVendors()).toEqual([]);
    second.unmount();

    // 3. `privacy.consent` enabled, visitor undecided (`choices: null`) -> nothing loads before explicit choice
    __setConsentForTests({ enabled: true, policyVersion: 1, choices: null });
    const third = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await act(async () => {});
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isRealmTainted()).toBe(false);
    third.unmount();
  });

  it("gates PostHog on 'analytics' and Clarity on 'session_replay' independently, calling vendor consent APIs and markRealmTainted synchronously before execution", async () => {
    let taintedBeforeScriptAppend = false;
    let vendorsBeforeScriptAppend: readonly string[] = [];
    let taintedBeforePostHogFetch = false;
    let vendorsBeforePostHogFetch: readonly string[] = [];

    const posthogStub = {
      opt_in_capturing: vi.fn(),
      opt_out_capturing: vi.fn(),
      reset: vi.fn(),
    };
    (window as Window & { posthog?: typeof posthogStub }).posthog = posthogStub;

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
      renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
        initialUrl: "/privacy",
      });
      await act(async () => {});
      expect(isRealmTainted()).toBe(false);

      // Step 1: Grant ONLY `analytics` (`session_replay: false`) -> PostHog runs, Clarity stays completely absent
      act(() => {
        __setConsentForTests({
          enabled: true,
          policyVersion: 1,
          choices: { preferences: false, analytics: true, session_replay: false },
        });
      });

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(posthogStub.opt_in_capturing).toHaveBeenCalled();
      expect(isPostHogCapturingEnabled()).toBe(true);
      expect(taintedBeforePostHogFetch).toBe(true);
      expect(vendorsBeforePostHogFetch).toContain("posthog");
      expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();

      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://eu.i.posthog.com/capture/");
      expect(init?.credentials).toBe("omit");
      const parsedBody = JSON.parse(String(init?.body));
      expect(parsedBody).toMatchObject({
        api_key: "phc_ValidProjectToken123456",
        event: "$pageview",
        properties: { $pathname: "/privacy", $process_person_profile: false },
      });

      // Step 2: Also grant `session_replay` -> Clarity mounts, receives `clarity("consent")`, and masks root
      act(() => {
        __setConsentForTests({
          enabled: true,
          policyVersion: 1,
          choices: { preferences: false, analytics: true, session_replay: true },
        });
      });

      await waitFor(() => {
        const script = document.querySelector('script[data-rp-clarity="true"]') as HTMLScriptElement | null;
        expect(script).not.toBeNull();
        expect(script?.src).toBe("https://www.clarity.ms/tag/clarityProj99");
      });

      expect(taintedBeforeScriptAppend).toBe(true);
      expect(vendorsBeforeScriptAppend).toContain("clarity");
      expect(document.documentElement.getAttribute("data-clarity-mask")).toBe("true");
      const clarityQueue = (window as Window & { clarity?: { q?: unknown[][] } }).clarity?.q ?? [];
      expect(clarityQueue).toContainEqual(["consent"]);
      expect(clarityQueue).toContainEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]);
      expect(isAnalyticsRealmTainted()).toBe(true);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("tears down Clarity/PostHog, purges vendor cookies, and reloads tainted realm on withdrawal, cross-tab storage revoke, or renewal expiry", async () => {
    const hardNavCalls: Array<[string, string]> = [];
    __setHardNavigateForTests((mode, url) => {
      hardNavCalls.push([mode, url]);
    });

    const posthogStub = {
      opt_in_capturing: vi.fn(),
      opt_out_capturing: vi.fn(),
      reset: vi.fn(),
    };
    (window as Window & { posthog?: typeof posthogStub }).posthog = posthogStub;

    // 1. Direct withdrawal
    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      choices: { preferences: false, analytics: true, session_replay: true },
    });
    const first = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).not.toBeNull());
    document.cookie = "_clck=abc; path=/";
    document.cookie = "ph_proj_posthog=xyz; path=/";

    const claritySpy = vi.fn();
    (window as Window & { clarity?: (...args: unknown[]) => void }).clarity = claritySpy;

    act(() => {
      __setConsentForTests({
        enabled: true,
        policyVersion: 1,
        choices: { preferences: false, analytics: false, session_replay: false },
      });
    });

    expect(posthogStub.opt_out_capturing).toHaveBeenCalled();
    expect(isPostHogCapturingEnabled()).toBe(false);
    expect(claritySpy).toHaveBeenCalledWith("consent", false);
    expect(claritySpy).toHaveBeenCalledWith("stop");
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(document.documentElement.getAttribute("data-clarity-mask")).toBeNull();
    expect((window as Window & { clarity?: unknown }).clarity).toBeUndefined();
    expect(document.cookie).not.toContain("_clck=");
    expect(document.cookie).not.toContain("ph_proj_posthog=");
    expect(hardNavCalls).toEqual([["replace", "/privacy"]]);
    first.unmount();

    // 2. Cross-tab `storage` revocation from another tab
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    hardNavCalls.length = 0;

    const store = __storageForTests();
    const nowIso = "2026-11-21T12:00:00.000Z";
    const baseMs = Date.parse(nowIso);
    let currentClock = baseMs;
    store.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        receipt: null,
        policyVersion: 1,
        decidedAt: nowIso,
        bySignal: false,
        choices: { preferences: false, analytics: true, session_replay: true },
      }),
    );
    __setConsentForTests({ enabled: true, policyVersion: 1, renewMonths: 6, clock: () => currentClock });

    const second = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).not.toBeNull());

    act(() => {
      store.setItem(
        CONSENT_STORAGE_KEY,
        JSON.stringify({
          v: 1,
          receipt: null,
          policyVersion: 1,
          decidedAt: nowIso,
          bySignal: false,
          choices: { preferences: false, analytics: false, session_replay: false },
        }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_STORAGE_KEY }));
    });

    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(hardNavCalls).toEqual([["replace", "/privacy"]]);
    second.unmount();

    // 3. Renewal deadline expiry on focus wake-up
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    hardNavCalls.length = 0;
    currentClock = baseMs;
    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      renewMonths: 6,
      clock: () => currentClock,
      decidedAt: nowIso,
      choices: { preferences: false, analytics: true, session_replay: true },
    });
    store.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        receipt: null,
        policyVersion: 1,
        decidedAt: nowIso,
        bySignal: false,
        choices: { preferences: false, analytics: true, session_replay: true },
      }),
    );

    const third = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).not.toBeNull());

    act(() => {
      currentClock = baseMs + 200 * 24 * 60 * 60 * 1000; // > 6 months
      window.dispatchEvent(new Event("focus"));
    });

    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(hardNavCalls).toEqual([["replace", "/privacy"]]);
    third.unmount();
  });

  it("excludes /accessibility, ?query/#hash URLs, non-legal paths, and authenticated sessions even with full consent", async () => {
    expect(CLIENT_ALLOWED_ANALYTICS_PATHS).toEqual(["/privacy", "/terms"]);
    expect(isEligibleAnalyticsPath("/accessibility")).toBe(false);

    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      choices: { preferences: true, analytics: true, session_replay: true },
    });

    for (const unsafeUrl of [
      "/accessibility",
      "/accessibility?ref=footer",
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
      expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(isRealmTainted()).toBe(false);
      unmount();
    }

    // Authenticated customer on clean `/privacy` NEVER loads tags even when browser has consent stored
    const { unmount } = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
      meImpl: async () => signedInCustomer,
    });
    await act(async () => {});
    expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isRealmTainted()).toBe(false);
    unmount();
  });

  it("quarantines non-public routes (including /accessibility) and authenticated session transitions in a tainted realm with zero private DOM commits", async () => {
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

    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      choices: { preferences: false, analytics: true, session_replay: true },
    });
    const { unmount } = renderWithBrowserRouter(<GuardedAppHarness />, { initialUrl: "/privacy" });
    await waitFor(() => expect(isRealmTainted()).toBe(true));

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

      // 2. Navigating `/terms` -> `/orders?token=SECRET_TOKEN#frag` is intercepted BEFORE `history.pushState`
      fireEvent.click(screen.getByRole("button", { name: "Go Private Orders" }));
      expect(window.location.pathname).toBe("/terms");
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
      expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull();
      expect(screen.queryByTestId("private-orders-secret")).toBeNull();
      expect(leakedPrivateNodes).toEqual([]);
      expect(hardNavCalls).toEqual([["assign", "/orders"]]);

      // Subsequent history attempts in the dying document remain blocked while async reload is pending
      window.history.pushState(null, "", "/sign-in?token=SECOND_SECRET#frag2");
      expect(window.location.pathname).toBe("/terms");
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
      expect(hardNavCalls).toEqual([["assign", "/orders"]]);
    } finally {
      observer.disconnect();
      unmount();
    }

    // 3. Session transition anonymous -> authenticated while on `/privacy` never commits `Alice Customer`
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    hardNavCalls.length = 0;

    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      choices: { preferences: false, analytics: true, session_replay: true },
    });
    const second = renderWithBrowserRouter(<GuardedAppHarness />, { initialUrl: "/privacy" });
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

  it("tears down and reloads tainted realm on runtime provider disable/ID rotation, standalone non-anonymous session transition, and keeps local denial durable before reload", async () => {
    const hardNavCalls: Array<[string, string]> = [];
    __setHardNavigateForTests((mode, url) => {
      hardNavCalls.push([mode, url]);
    });

    // 1. Runtime Clarity disable or projectId rotation observed on refetch while visitor stays consented
    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      choices: { preferences: false, analytics: true, session_replay: true },
    });
    const first = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).not.toBeNull());

    first.rerender(
      <ThemeProvider>
        <QueryClientProvider client={first.queryClient}>
          <TRPCProvider trpcClient={createApiClient()} queryClient={first.queryClient}>
            <AuthApiProvider api={fakeAuthApi({ me: () => Promise.reject(unauthError()) })}>
              <ToastProvider>
                <StepUpProvider>
                  <Router>
                    <AnalyticsConsentSlot
                      configOverride={{
                        clarity: { enabled: true, projectId: "rotatedProj88" },
                        posthog: ACTIVE_CONFIG.posthog,
                      }}
                    />
                  </Router>
                </StepUpProvider>
              </ToastProvider>
            </AuthApiProvider>
          </TRPCProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull());
    expect(hardNavCalls).toEqual([["replace", "/privacy"]]);
    first.unmount();

    // 2. Standalone slot (even without RealmTaintBoundary) tears down & reloads when session becomes non-anonymous
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    hardNavCalls.length = 0;

    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      choices: { preferences: false, analytics: true, session_replay: true },
    });
    const second = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).not.toBeNull());

    act(() => {
      second.queryClient.setQueryData(ME_QUERY_KEY, signedInCustomer);
    });
    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).toBeNull());
    expect(isPostHogCapturingEnabled()).toBe(false);
    expect(hardNavCalls).toEqual([["replace", "/privacy"]]);
    second.unmount();

    // 3. Local denial via `applyConsentDecision` is already written to `rp.consent.v1` at the exact instant
    //    `requestCleanRealm` fires (so reload preempting the async ledger RPC never resurrects consent)
    resetAnalyticsConsentForTests();
    __resetRealmTaintForTests();
    hardNavCalls.length = 0;

    let storedAtReloadMoment: string | null = null;
    __setHardNavigateForTests((mode, url) => {
      storedAtReloadMoment = __storageForTests().getItem(CONSENT_STORAGE_KEY);
      hardNavCalls.push([mode, url]);
    });

    __setConsentForTests({
      enabled: true,
      policyVersion: 1,
      choices: { preferences: false, analytics: true, session_replay: true },
    });
    const third = renderWithBrowserRouter(<AnalyticsConsentSlot configOverride={ACTIVE_CONFIG} />, {
      initialUrl: "/privacy",
    });
    await waitFor(() => expect(document.querySelector('script[data-rp-clarity="true"]')).not.toBeNull());

    act(() => {
      applyConsentDecision(
        { preferences: false, analytics: false, session_replay: false },
        { policyVersion: 1 },
      );
    });

    expect(hardNavCalls).toEqual([["replace", "/privacy"]]);
    expect(storedAtReloadMoment).not.toBeNull();
    expect(JSON.parse(storedAtReloadMoment!).choices).toEqual({
      preferences: false,
      analytics: false,
      session_replay: false,
    });
    expect(consent.has("analytics")).toBe(false);
    expect(consent.has("session_replay")).toBe(false);
    third.unmount();
  });

  it("spreads integrationsAdminRoutes, productionAdminRoutes, webhookRoutes, nav, and orderTabs into integrationsFeature", () => {
    expect(integrationsFeature.routes.map((r) => r.path)).toEqual([
      "/admin/integrations",
      "/admin/integrations/smtp",
      "/admin/integrations/analytics",
      "/admin/integrations/egress",
      "/admin/integrations/production",
      "/admin/integrations/webhooks",
      "/admin/integrations/webhooks/inbound",
      "/admin/integrations/webhooks/deliveries",
    ]);
    expect(integrationsFeature.nav?.map((n) => n.href)).toEqual([
      "/admin/integrations",
      "/admin/integrations/production",
      "/admin/integrations/webhooks",
    ]);
    expect(integrationsFeature.orderTabs).toHaveLength(1);
    expect(["production", "automation"]).toContain(integrationsFeature.orderTabs?.[0]?.key);
  });
});
