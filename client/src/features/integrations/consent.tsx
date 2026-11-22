/**
 * Shared-Consent-Gated Public-Route Analytics Loader (`AnalyticsConsentSlot`, `useAnalyticsConsent`).
 *
 * Increment 04 Package J cutover:
 *  1. Single consent authority (`@/lib/consent`):
 *     - Renders NO independent banner and keeps NO independent opt-in state.
 *     - When `privacy.consent` (`consent.enabled()`) is off, `consent.has(...)` is false and NOTHING loads or captures.
 *     - Separate category gates: PostHog requires `consent.has("analytics")`; Microsoft Clarity requires
 *       `consent.has("session_replay")`.
 *  2. Strictly restricted to exact non-sensitive public legal routes (`/privacy`, `/terms`), clean URLs with
 *     EMPTY query string and EMPTY hash (`location.search === "" && location.hash === ""`), non-preview
 *     path routing (`!RUNTIME.preview`), and unauthenticated visitors (`session.view.status === "anonymous"`).
 *     Public `/accessibility`, authentication, remediation, recovery, customer portal, account security,
 *     and all `/admin` routes are permanently excluded.
 *  3. Vendor consent APIs & withdrawal teardown (`consent.subscribe(...)`):
 *     - PostHog: cookieless (`credentials: "omit"`, `$process_person_profile: false`, ephemeral per-view ID)
 *       with explicit `opt_in_capturing()` on grant and `opt_out_capturing()` + cookie/storage purge on withdrawal.
 *     - Microsoft Clarity: script appended ONLY after `session_replay` consent, told via `clarity("consent")`
 *       and `clarity("consentv2", ...)`, and torn down via `clarity("consent", false)` + `clarity("stop")` +
 *       script removal + cookie/storage purge on withdrawal, expiry, policy-version change, or cross-tab revoke.
 *     - Any withdrawal/expiry while `isRealmTainted()` is true immediately requests a clean JS realm reload.
 *  4. Synchronous JS-Realm Quarantine (INT-01) + Pre-History Guard:
 *     - Calls `markRealmTainted("clarity")` / `markRealmTainted("posthog")` from `@/lib/realmTaint`
 *       SYNCHRONOUSLY on the line immediately BEFORE appending the Clarity `<script>` element or sending
 *       the PostHog `fetch` request.
 *     - Wraps `history.pushState`/`replaceState` and capture-phase `popstate`/`hashchange` so leaving clean
 *       `/privacy` or `/terms` tears down vendor state and triggers `requestCleanRealm(...)`.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import {
  __resetConsentForTests,
  consent,
  removeVendorData,
  useConsent,
  type ConsentState,
} from "@/lib/consent";
import {
  __resetRealmTaintForTests,
  cleanRealmPath,
  isRealmTainted,
  markRealmTainted,
  requestCleanRealm,
} from "@/lib/realmTaint";
import { RUNTIME } from "@/lib/runtime";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";

export type AnalyticsConsentDecision = "undecided" | "granted" | "denied";

/** Exact public legal routes eligible for optional visitor analytics (`/accessibility` is intentionally excluded). */
export const CLIENT_ALLOWED_ANALYTICS_PATHS = ["/privacy", "/terms"] as const;

export const ANALYTICS_CONSENT_COPY = {
  heading: "Optional public-page analytics",
  body: (provider: string) =>
    `Visitor consent from the privacy banner controls ${provider} on /privacy and /terms only. Sign-in, security, accessibility, customer portal and administrative pages never load external analytics.`,
  allow: "Accept in cookie preferences",
  decline: "Reject all",
  grantedStatus: "Public-page analytics active under your cookie preferences.",
  withdraw: "Cookie preferences",
  declinedStatus: "Optional analytics off under your cookie preferences.",
  changePreference: "Cookie preferences",
} as const;

const CLARITY_ID_PATTERN = /^[A-Za-z0-9]{6,32}$/;
const POSTHOG_KEY_PATTERN = /^phc_[A-Za-z0-9_]{12,176}$/;

export function isEligibleAnalyticsPath(pathname: string): boolean {
  return pathname === "/privacy" || pathname === "/terms";
}

/**
 * Verifies that a URL (or the current `window.location`) points to an exact eligible public legal
 * pathname with ZERO query parameters and ZERO fragment/hash so vendor tags can never read sensitive
 * query or fragment tokens from `document.URL` / `location.href`.
 */
export function isCleanEligibleUrl(url: Pick<Location | URL, "pathname" | "search" | "hash">): boolean {
  return isEligibleAnalyticsPath(url.pathname) && url.search === "" && url.hash === "";
}

function isWindowAtCleanEligiblePath(expectedPathname?: string): boolean {
  if (typeof window === "undefined" || RUNTIME.preview) return false;
  if (!isCleanEligibleUrl(window.location)) return false;
  return expectedPathname === undefined || window.location.pathname === expectedPathname;
}

function isSafeHttpsOriginClient(value: string | null | undefined): value is string {
  if (!value || value.length > 253) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === value &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

/* ------------------------------ Vendor consent controllers + preventive pre-history guard */

interface PostHogGlobalLike {
  opt_in_capturing?: () => void;
  opt_out_capturing?: () => void;
  reset?: () => void;
}

let posthogCapturingEnabled = false;
let consentHistoryGuardArmed = false;
let realmLeavingPending = false;
let historyWrappersInstalled = false;
let origPushState: History["pushState"] | null = null;
let origReplaceState: History["replaceState"] | null = null;

export function isAnalyticsRealmTainted(): boolean {
  return isRealmTainted();
}

export function isPostHogCapturingEnabled(): boolean {
  return posthogCapturingEnabled;
}

function optInPostHogCapturing(): void {
  posthogCapturingEnabled = true;
  if (typeof window !== "undefined") {
    const win = window as Window & { posthog?: PostHogGlobalLike };
    try {
      win.posthog?.opt_in_capturing?.();
    } catch {
      // Ignore vendor global errors; portal uses cookieless fetch below.
    }
  }
}

function optOutPostHogCapturing(): void {
  posthogCapturingEnabled = false;
  if (typeof window !== "undefined") {
    const win = window as Window & { posthog?: PostHogGlobalLike };
    try {
      win.posthog?.opt_out_capturing?.();
      win.posthog?.reset?.();
    } catch {
      // Ignore vendor teardown errors.
    }
  }
  removeVendorData("analytics");
}

function teardownClarityGlobalsAndScript(): void {
  if (typeof window !== "undefined") {
    const win = window as Window & { clarity?: (...args: unknown[]) => void };
    try {
      win.clarity?.("consent", false);
      win.clarity?.("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });
      win.clarity?.("stop");
    } catch {
      // Ignore vendor teardown errors prior to full-document navigation/reload.
    }
    delete win.clarity;
  }
  if (typeof document !== "undefined") {
    document.querySelectorAll('script[data-rp-clarity="true"]').forEach((el) => el.remove());
    document.documentElement.removeAttribute("data-clarity-mask");
  }
  removeVendorData("session_replay");
}

function teardownAllVendors(): void {
  optOutPostHogCapturing();
  teardownClarityGlobalsAndScript();
}

function ensurePreventiveHistoryGuardsInstalled(): void {
  if (historyWrappersInstalled || typeof window === "undefined") return;
  historyWrappersInstalled = true;

  origPushState = window.history.pushState.bind(window.history);
  origReplaceState = window.history.replaceState.bind(window.history);

  const guardHistoryMutation = (
    original: History["pushState"],
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void => {
    if (consentHistoryGuardArmed && isRealmTainted()) {
      let resolved: URL | null;
      try {
        resolved = new URL(
          url !== undefined && url !== null ? String(url) : window.location.href,
          window.location.origin,
        );
      } catch {
        resolved = null;
      }

      const staysOnCleanPublicLegal =
        !realmLeavingPending &&
        resolved !== null &&
        resolved.origin === window.location.origin &&
        isCleanEligibleUrl(resolved);

      if (!staysOnCleanPublicLegal) {
        realmLeavingPending = true;
        teardownAllVendors();
        const targetPath = cleanRealmPath(resolved?.pathname ?? window.location.pathname);
        const mode = isEligibleAnalyticsPath(targetPath) ? "replace" : "assign";
        requestCleanRealm(mode, targetPath);
        return;
      }
    }
    original(data, unused, url);
  };

  window.history.pushState = (data: unknown, unused: string, url?: string | URL | null): void => {
    guardHistoryMutation(origPushState!, data, unused, url);
  };
  window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null): void => {
    guardHistoryMutation(origReplaceState!, data, unused, url);
  };

  const onCaptureUrlMutation = (event: Event): void => {
    if (!consentHistoryGuardArmed || !isRealmTainted()) return;
    if (realmLeavingPending || !isWindowAtCleanEligiblePath()) {
      event.stopImmediatePropagation();
      realmLeavingPending = true;
      teardownAllVendors();
      const targetPath = cleanRealmPath(window.location.pathname);
      requestCleanRealm(isEligibleAnalyticsPath(targetPath) ? "replace" : "assign", targetPath);
    }
  };
  window.addEventListener("popstate", onCaptureUrlMutation, { capture: true });
  window.addEventListener("hashchange", onCaptureUrlMutation, { capture: true });
}

/** Resets shared consent, vendor controllers & realm-taint state (used by tests). */
export function resetAnalyticsConsentForTests(): void {
  posthogCapturingEnabled = false;
  consentHistoryGuardArmed = false;
  realmLeavingPending = false;
  teardownAllVendors();
  __resetConsentForTests();
  __resetRealmTaintForTests();
}

function subscribeWindowUrl(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", cb);
  window.addEventListener("hashchange", cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener("hashchange", cb);
  };
}

function getCleanUrlSnapshot(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}|${window.location.search}|${window.location.hash}`;
}

export function useAnalyticsConsent() {
  const [pathname] = useLocation();
  const state = useConsent();
  useSyncExternalStore(subscribeWindowUrl, getCleanUrlSnapshot, () => "");
  const isEligibleRoute = isEligibleAnalyticsPath(pathname) && isWindowAtCleanEligiblePath(pathname);

  const analyticsAllowed = state.enabled && state.decided && state.choices.analytics;
  const sessionReplayAllowed = state.enabled && state.decided && state.choices.session_replay;
  const decision: AnalyticsConsentDecision = !state.enabled || !state.decided
    ? "undecided"
    : analyticsAllowed || sessionReplayAllowed
      ? "granted"
      : "denied";

  const openPreferences = useCallback(() => consent.openPreferences(), []);

  return {
    decision,
    analyticsAllowed,
    sessionReplayAllowed,
    openPreferences,
    isEligibleRoute,
  };
}

function mountClarityTag(projectId: string, pathname: string): void {
  if (typeof document === "undefined" || !CLARITY_ID_PATTERN.test(projectId)) return;
  if (!isWindowAtCleanEligiblePath(pathname)) return;
  if (!consent.enabled() || !consent.has("session_replay")) return;

  const existing = document.querySelector('script[data-rp-clarity="true"]');
  if (existing) return;

  ensurePreventiveHistoryGuardsInstalled();
  consentHistoryGuardArmed = true;

  // Enforce strict client-side Clarity masking on the document root before loading the vendor tag.
  document.documentElement.setAttribute("data-clarity-mask", "true");

  const win = window as Window & {
    clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  };
  if (typeof win.clarity !== "function") {
    const fn = ((...args: unknown[]) => {
      (fn.q ??= []).push(args);
    }) as ((...args: unknown[]) => void) & { q?: unknown[][] };
    win.clarity = fn;
  }

  // Inform Clarity via its consent API only after explicit `session_replay` consent.
  win.clarity("consent");
  win.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
  script.setAttribute("data-rp-clarity", "true");
  script.referrerPolicy = "no-referrer";

  // INT-01: Synchronously mark the JS realm tainted on the exact line immediately BEFORE appending `<script>`.
  markRealmTainted("clarity");
  document.head.appendChild(script);
}

function sendMinimalPostHogPageview(host: string, key: string, pathname: string): void {
  if (!POSTHOG_KEY_PATTERN.test(key) || !isSafeHttpsOriginClient(host)) return;
  if (!isWindowAtCleanEligiblePath(pathname)) return;
  if (!consent.enabled() || !consent.has("analytics") || !posthogCapturingEnabled) return;
  if (typeof fetch !== "function") return;

  ensurePreventiveHistoryGuardsInstalled();
  consentHistoryGuardArmed = true;

  const distinctId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `ephemeral_${Math.random().toString(36).slice(2, 12)}`;

  // INT-01: Synchronously mark the JS realm tainted on the exact line immediately BEFORE sending `fetch()`.
  markRealmTainted("posthog");
  void fetch(`${host}/capture/`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    keepalive: true,
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event: "$pageview",
      distinct_id: distinctId,
      properties: {
        $pathname: pathname,
        $process_person_profile: false,
      },
    }),
  }).catch(() => {
    // Analytics delivery failures are non-blocking and silent.
  });
}

export interface AnalyticsConsentSlotProps {
  /** Optional override for deterministic component tests; defaults to `trpc.integrations.publicAnalyticsConfig`. */
  configOverride?: {
    clarity: { enabled: boolean; projectId: string | null };
    posthog: { enabled: boolean; key: string | null; host: string | null };
  };
}

export function AnalyticsConsentSlot({ configOverride }: AnalyticsConsentSlotProps = {}) {
  const [pathname] = useLocation();
  const session = useSession();
  const trpc = useTRPC();
  const consentState = useConsent();

  const cleanEligibleRoute = isEligibleAnalyticsPath(pathname) && isWindowAtCleanEligiblePath(pathname);
  const isAnonymousVisitor = session.view.status === "anonymous";

  const analyticsConsented =
    consentState.enabled && consentState.decided && consentState.choices.analytics;
  const sessionReplayConsented =
    consentState.enabled && consentState.decided && consentState.choices.session_replay;
  const anyCategoryConsented = analyticsConsented || sessionReplayConsented;

  const configQuery = useQuery({
    ...trpc.integrations.publicAnalyticsConfig.queryOptions(),
    enabled: configOverride === undefined && cleanEligibleRoute && isAnonymousVisitor && consentState.enabled,
    staleTime: 60_000,
  });

  const cfg = configOverride ?? configQuery.data;

  const clarityReady = Boolean(
    cfg?.clarity.enabled && cfg.clarity.projectId && CLARITY_ID_PATTERN.test(cfg.clarity.projectId),
  );
  const posthogReady = Boolean(
    cfg?.posthog.enabled &&
      cfg.posthog.key &&
      POSTHOG_KEY_PATTERN.test(cfg.posthog.key) &&
      isSafeHttpsOriginClient(cfg.posthog.host),
  );

  const lastCapturedPathRef = useRef<string | null>(null);
  const prevGrantedRef = useRef<{ analytics: boolean; session_replay: boolean }>({
    analytics: false,
    session_replay: false,
  });

  // Subscribe directly to `@/lib/consent` so cross-tab storage revocations, renewal expiry, policy-version
  // bumps, or disabling `privacy.consent` tear down vendor state synchronously and replace any tainted realm.
  useEffect(() => {
    const handleTransition = (next: ConsentState): void => {
      const nextAnalytics = next.enabled && next.decided && next.choices.analytics;
      const nextReplay = next.enabled && next.decided && next.choices.session_replay;
      const prev = prevGrantedRef.current;

      const analyticsRevoked = prev.analytics && !nextAnalytics;
      const replayRevoked = prev.session_replay && !nextReplay;
      prevGrantedRef.current = { analytics: nextAnalytics, session_replay: nextReplay };

      if (!nextAnalytics) {
        lastCapturedPathRef.current = null;
        optOutPostHogCapturing();
      }
      if (!nextReplay) {
        teardownClarityGlobalsAndScript();
      }
      if ((analyticsRevoked || replayRevoked) && isRealmTainted() && !realmLeavingPending) {
        realmLeavingPending = true;
        teardownAllVendors();
        const targetPath = typeof window !== "undefined" ? cleanRealmPath(window.location.pathname) : "/privacy";
        requestCleanRealm(isEligibleAnalyticsPath(targetPath) ? "replace" : "assign", targetPath);
      }
    };

    prevGrantedRef.current = {
      analytics: consent.enabled() && consent.has("analytics"),
      session_replay: consent.enabled() && consent.has("session_replay"),
    };
    return consent.subscribe(handleTransition);
  }, []);

  useEffect(() => {
    if (!cleanEligibleRoute || !isAnonymousVisitor || !anyCategoryConsented) {
      lastCapturedPathRef.current = null;
      if (!analyticsConsented) optOutPostHogCapturing();
      if (!sessionReplayConsented) teardownClarityGlobalsAndScript();
      return;
    }

    if (sessionReplayConsented && clarityReady && cfg?.clarity.projectId) {
      mountClarityTag(cfg.clarity.projectId, pathname);
    } else if (!sessionReplayConsented) {
      teardownClarityGlobalsAndScript();
    }

    if (analyticsConsented && posthogReady && cfg?.posthog.host && cfg?.posthog.key) {
      optInPostHogCapturing();
      if (lastCapturedPathRef.current !== pathname) {
        lastCapturedPathRef.current = pathname;
        sendMinimalPostHogPageview(cfg.posthog.host, cfg.posthog.key, pathname);
      }
    } else if (!analyticsConsented) {
      lastCapturedPathRef.current = null;
      optOutPostHogCapturing();
    }
  }, [
    analyticsConsented,
    anyCategoryConsented,
    cfg?.clarity.projectId,
    cfg?.posthog.host,
    cfg?.posthog.key,
    clarityReady,
    cleanEligibleRoute,
    isAnonymousVisitor,
    pathname,
    posthogReady,
    sessionReplayConsented,
  ]);

  // Headless loader: all visitor consent UI is owned by `CookieConsent` (`@/features/platform/consent`).
  return null;
}

export default AnalyticsConsentSlot;
