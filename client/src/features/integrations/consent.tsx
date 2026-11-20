/**
 * Consent-Gated Public-Route Analytics Banner & Loader (`AnalyticsConsentSlot`, `useAnalyticsConsent`).
 *
 * Security & privacy guarantees:
 *  1. Renders and loads NOTHING unless at least one analytics provider is admin-enabled.
 *  2. Strictly restricted to exact non-sensitive public routes (`/privacy`, `/terms`), clean URLs with
 *     EMPTY query string and EMPTY hash (`location.search === "" && location.hash === ""`), non-preview
 *     path routing (`!RUNTIME.preview`), and unauthenticated visitors (`session.view.status === "anonymous"`).
 *     Authentication, remediation, recovery, customer orders/files/messages/invoices, account security,
 *     and all `/admin` routes are permanently excluded.
 *  3. Consent state lives exclusively in volatile JS memory for the current tab session — NEVER in
 *     `localStorage`, `sessionStorage`, `indexedDB` or cookies.
 *  4. Re-validates provider identifiers client-side before building fixed vendor URLs (never arbitrary
 *     HTML or script snippets).
 *  5. PostHog uses direct, credential-less `fetch` (`$process_person_profile: false`, ephemeral per-view ID)
 *     so zero PostHog SDK code executes in the portal JS realm.
 *  6. Synchronous JS-Realm Isolation Boundary: once the Clarity tag mounts in the current document,
 *     `history.pushState` / `history.replaceState`, capture-phase `popstate` / `hashchange`, and the
 *     session query cache are synchronously gated so NO private route or authenticated DOM child can
 *     EVER be committed into a Clarity-tainted JS realm — non-public navigations abort SPA routing
 *     before route state updates and perform a full-document navigation into a fresh untainted realm.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { ME_QUERY_KEY } from "@/lib/authApi";
import { RUNTIME } from "@/lib/runtime";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Button } from "@/ui";

export type AnalyticsConsentDecision = "undecided" | "granted" | "denied";

export const CLIENT_ALLOWED_ANALYTICS_PATHS = ["/privacy", "/terms"] as const;

export const ANALYTICS_CONSENT_COPY = {
  heading: "Optional public-page analytics",
  body: (provider: string) =>
    `May we enable ${provider} on public legal pages for this session? Sign-in, security, customer portal and administrative pages never load external analytics.`,
  allow: "Allow for session",
  decline: "Decline",
  grantedStatus: "Public-page analytics active for this session.",
  withdraw: "Withdraw consent",
  declinedStatus: "Analytics declined for this session.",
  changePreference: "Change preference",
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

/* ------------------------------ In-memory consent + synchronous JS-realm taint guard */

let currentDecision: AnalyticsConsentDecision = "undecided";
let clarityTaintedCurrentRealm = false;
let realmQuarantined = false;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getConsentSnapshot(): AnalyticsConsentDecision {
  return currentDecision;
}

type RealmPurgeHandler = (targetUrl?: string) => void;
let customRealmPurgeHandler: RealmPurgeHandler | null = null;

/** Test hook allowing jsdom specs to observe synchronous JS-realm purge / hard navigations. */
export function __setAnalyticsTestHooks(hooks: { onRealmPurge?: RealmPurgeHandler | null }): void {
  customRealmPurgeHandler = hooks.onRealmPurge ?? null;
}

export function isAnalyticsRealmTainted(): boolean {
  return clarityTaintedCurrentRealm;
}

export function isAnalyticsRealmQuarantined(): boolean {
  return realmQuarantined;
}

function teardownClarityGlobalsAndScript(): void {
  if (typeof window !== "undefined") {
    const win = window as Window & { clarity?: (...args: unknown[]) => void };
    try {
      win.clarity?.("consent", false);
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
}

function quarantineAndHardNavigate(targetHref?: string): void {
  if (!clarityTaintedCurrentRealm && !realmQuarantined) return;
  clarityTaintedCurrentRealm = false;
  realmQuarantined = true;
  teardownClarityGlobalsAndScript();
  emitChange();

  if (customRealmPurgeHandler) {
    customRealmPurgeHandler(targetHref);
    return;
  }
  if (typeof window !== "undefined") {
    try {
      if (targetHref && targetHref !== window.location.href) {
        window.location.assign(targetHref);
      } else {
        window.location.reload();
      }
    } catch {
      // jsdom does not implement document navigation; `customRealmPurgeHandler` records it in tests.
    }
  }
}

let realmGuardsInstalled = false;
let origPushState: History["pushState"] | null = null;
let origReplaceState: History["replaceState"] | null = null;

function installSynchronousRealmGuards(): void {
  if (realmGuardsInstalled || typeof window === "undefined") return;
  realmGuardsInstalled = true;

  origPushState = window.history.pushState.bind(window.history);
  origReplaceState = window.history.replaceState.bind(window.history);

  const guardHistoryMutation = (
    original: History["pushState"],
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void => {
    if (clarityTaintedCurrentRealm || realmQuarantined) {
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
        !realmQuarantined &&
        resolved !== null &&
        resolved.origin === window.location.origin &&
        isCleanEligibleUrl(resolved);

      if (!staysOnCleanPublicLegal) {
        // Synchronously block `history.pushState`/`replaceState` BEFORE wouter updates route state,
        // preventing any non-public component from ever rendering or committing in this tainted realm.
        quarantineAndHardNavigate(resolved?.href ?? window.location.href);
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

  // Capture-phase listeners run BEFORE wouter's bubble/default listeners on Back/Forward or hash edits.
  const onCaptureUrlMutation = (event: Event): void => {
    if (!clarityTaintedCurrentRealm && !realmQuarantined) return;
    if (realmQuarantined || !isWindowAtCleanEligiblePath()) {
      event.stopImmediatePropagation();
      quarantineAndHardNavigate(window.location.href);
    }
  };
  window.addEventListener("popstate", onCaptureUrlMutation, { capture: true });
  window.addEventListener("hashchange", onCaptureUrlMutation, { capture: true });
}

// Install capture-phase listeners immediately on module evaluation so they precede router listeners.
installSynchronousRealmGuards();

/** Resets volatile consent & realm-taint state (used by tests). */
export function resetAnalyticsConsentForTests(): void {
  currentDecision = "undecided";
  clarityTaintedCurrentRealm = false;
  realmQuarantined = false;
  customRealmPurgeHandler = null;
  teardownClarityGlobalsAndScript();
  emitChange();
}

export function setAnalyticsConsent(next: AnalyticsConsentDecision): void {
  const prev = currentDecision;
  currentDecision = next;
  if (prev === "granted" && next !== "granted" && clarityTaintedCurrentRealm) {
    quarantineAndHardNavigate(typeof window !== "undefined" ? window.location.href : undefined);
    return;
  }
  emitChange();
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
  const decision = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  useSyncExternalStore(subscribeWindowUrl, getCleanUrlSnapshot, () => "");
  const isEligibleRoute = isEligibleAnalyticsPath(pathname) && isWindowAtCleanEligiblePath(pathname);

  const grant = useCallback(() => setAnalyticsConsent("granted"), []);
  const deny = useCallback(() => setAnalyticsConsent("denied"), []);
  const reset = useCallback(() => setAnalyticsConsent("undecided"), []);

  return {
    decision,
    grant,
    deny,
    reset,
    isEligibleRoute,
  };
}

function mountClarityTag(projectId: string, pathname: string): void {
  if (typeof document === "undefined" || !CLARITY_ID_PATTERN.test(projectId)) return;
  if (!isWindowAtCleanEligiblePath(pathname)) return;
  installSynchronousRealmGuards();

  const existing = document.querySelector('script[data-rp-clarity="true"]');
  if (existing) return;

  const win = window as Window & {
    clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  };
  if (typeof win.clarity !== "function") {
    const fn = ((...args: unknown[]) => {
      (fn.q ??= []).push(args);
    }) as ((...args: unknown[]) => void) & { q?: unknown[][] };
    win.clarity = fn;
  }

  // Enforce strict client-side Clarity masking on the document root before loading the vendor tag.
  document.documentElement.setAttribute("data-clarity-mask", "true");

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
  script.setAttribute("data-rp-clarity", "true");
  script.referrerPolicy = "no-referrer";
  clarityTaintedCurrentRealm = true;
  document.head.appendChild(script);
}

function sendMinimalPostHogPageview(host: string, key: string, pathname: string): void {
  if (!POSTHOG_KEY_PATTERN.test(key) || !isSafeHttpsOriginClient(host)) return;
  if (!isWindowAtCleanEligiblePath(pathname)) return;
  if (typeof fetch !== "function") return;

  const distinctId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `ephemeral_${Math.random().toString(36).slice(2, 12)}`;

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
  const queryClient = useQueryClient();
  const session = useSession();
  const trpc = useTRPC();
  const { decision, grant, deny, reset } = useAnalyticsConsent();

  const cleanEligibleRoute = isEligibleAnalyticsPath(pathname) && isWindowAtCleanEligiblePath(pathname);
  const isAnonymousVisitor = session.view.status === "anonymous";

  // Synchronously watch `ME_QUERY_KEY` in the query cache so any transition out of anonymous state
  // while Clarity tainted the realm quarantines & reloads BEFORE React commits authenticated UI.
  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (!clarityTaintedCurrentRealm) return;
      if (
        Array.isArray(event.query.queryKey) &&
        event.query.queryKey[0] === ME_QUERY_KEY[0] &&
        event.query.state.data !== undefined
      ) {
        quarantineAndHardNavigate(typeof window !== "undefined" ? window.location.href : undefined);
      }
    });
  }, [queryClient]);

  // Synchronous render-phase fallback if custom router hooks or session state diverge while tainted.
  if (clarityTaintedCurrentRealm && (!cleanEligibleRoute || !isAnonymousVisitor)) {
    quarantineAndHardNavigate(typeof window !== "undefined" ? window.location.href : undefined);
  }

  const configQuery = useQuery({
    ...trpc.integrations.publicAnalyticsConfig.queryOptions(),
    enabled: configOverride === undefined && cleanEligibleRoute && isAnonymousVisitor,
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
  const anyProviderActive = clarityReady || posthogReady;

  const lastCapturedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cleanEligibleRoute || !isAnonymousVisitor || !anyProviderActive || decision !== "granted") {
      lastCapturedPathRef.current = null;
      if (clarityTaintedCurrentRealm && !clarityReady) {
        quarantineAndHardNavigate(typeof window !== "undefined" ? window.location.href : undefined);
      }
      return;
    }

    if (clarityReady && cfg?.clarity.projectId) {
      mountClarityTag(cfg.clarity.projectId, pathname);
    }

    if (posthogReady && cfg?.posthog.host && cfg?.posthog.key && lastCapturedPathRef.current !== pathname) {
      lastCapturedPathRef.current = pathname;
      sendMinimalPostHogPageview(cfg.posthog.host, cfg.posthog.key, pathname);
    }
  }, [
    anyProviderActive,
    cfg?.clarity.projectId,
    cfg?.posthog.host,
    cfg?.posthog.key,
    clarityReady,
    cleanEligibleRoute,
    decision,
    isAnonymousVisitor,
    pathname,
    posthogReady,
  ]);

  if (!cleanEligibleRoute || !isAnonymousVisitor || !anyProviderActive || realmQuarantined) {
    return null;
  }

  if (decision === "granted") {
    return (
      <aside
        aria-label="Analytics privacy preference"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-2.5 text-sm text-body shadow-[var(--shadow-card)]"
      >
        <span className="text-muted">{ANALYTICS_CONSENT_COPY.grantedStatus}</span>
        <Button size="sm" variant="secondary" onClick={deny}>
          {ANALYTICS_CONSENT_COPY.withdraw}
        </Button>
      </aside>
    );
  }

  if (decision === "denied") {
    return (
      <aside
        aria-label="Analytics privacy preference"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-2.5 text-sm text-body shadow-[var(--shadow-card)]"
      >
        <span className="text-muted">{ANALYTICS_CONSENT_COPY.declinedStatus}</span>
        <Button size="sm" variant="ghost" onClick={reset}>
          {ANALYTICS_CONSENT_COPY.changePreference}
        </Button>
      </aside>
    );
  }

  const providerLabel =
    clarityReady && posthogReady
      ? "Microsoft Clarity and PostHog"
      : clarityReady
        ? "Microsoft Clarity"
        : "PostHog";

  return (
    <section
      aria-labelledby="rp-analytics-consent-heading"
      className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-2xl rounded-[var(--radius-card)] border border-line bg-surface p-4 text-body shadow-[var(--shadow-card)] sm:inset-x-6 sm:bottom-6 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id="rp-analytics-consent-heading" className="text-sm font-semibold text-ink">
            {ANALYTICS_CONSENT_COPY.heading}
          </h2>
          <p className="text-sm text-muted">{ANALYTICS_CONSENT_COPY.body(providerLabel)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={deny}>
            {ANALYTICS_CONSENT_COPY.decline}
          </Button>
          <Button size="sm" variant="primary" onClick={grant}>
            {ANALYTICS_CONSENT_COPY.allow}
          </Button>
        </div>
      </div>
    </section>
  );
}

export default AnalyticsConsentSlot;
