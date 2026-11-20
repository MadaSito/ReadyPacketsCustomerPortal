/**
 * Consent-Gated Public-Route Analytics Banner & Loader (`AnalyticsConsentSlot`, `useAnalyticsConsent`).
 *
 * Security & privacy guarantees:
 *  1. Renders and loads NOTHING unless at least one analytics provider is admin-enabled.
 *  2. Strictly restricted to exact non-sensitive public routes (`/privacy`, `/terms`) AND unauthenticated
 *     visitors (`session.view.status === "anonymous"`). Authentication, remediation, recovery, customer
 *     orders/files/messages/invoices, account security, and all `/admin` routes are permanently excluded.
 *  3. Consent state lives exclusively in volatile JS memory for the current tab session — NEVER in
 *     `localStorage`, `sessionStorage`, `indexedDB` or cookies.
 *  4. Re-validates provider identifiers client-side before building fixed vendor URLs (never arbitrary
 *     HTML or script snippets).
 *  5. PostHog uses direct, credential-less `fetch` (`$process_person_profile: false`, ephemeral per-view ID)
 *     so zero PostHog SDK code executes in the portal JS realm.
 *  6. If the Clarity tag ever loaded in the current document and the visitor navigates off `/privacy`|`/terms`
 *     or revokes consent, the script is removed and a full document reload purges the JS realm before any
 *     sign-in or authenticated route can run in that realm.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Button } from "@/ui";

export type AnalyticsConsentDecision = "undecided" | "granted" | "denied";

export const CLIENT_ALLOWED_ANALYTICS_PATHS = ["/privacy", "/terms"] as const;

const CLARITY_ID_PATTERN = /^[A-Za-z0-9]{6,32}$/;
const POSTHOG_KEY_PATTERN = /^phc_[A-Za-z0-9_]{12,176}$/;

export function isEligibleAnalyticsPath(pathname: string): boolean {
  return pathname === "/privacy" || pathname === "/terms";
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

/* ----------------------------------------------------- In-memory consent store (zero storage) */

let currentDecision: AnalyticsConsentDecision = "undecided";
let clarityTaintedCurrentRealm = false;
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

type RealmPurgeHandler = () => void;
let customRealmPurgeHandler: RealmPurgeHandler | null = null;

/** Test hook allowing jsdom specs to observe JS-realm purge reloads deterministically. */
export function __setAnalyticsTestHooks(hooks: { onRealmPurge?: RealmPurgeHandler | null }): void {
  customRealmPurgeHandler = hooks.onRealmPurge ?? null;
}

/** Resets volatile consent & realm-taint state (used by tests and explicit session reset). */
export function resetAnalyticsConsentForTests(): void {
  currentDecision = "undecided";
  clarityTaintedCurrentRealm = false;
  customRealmPurgeHandler = null;
  if (typeof document !== "undefined") {
    document.querySelectorAll('script[data-rp-clarity="true"]').forEach((el) => el.remove());
  }
  emitChange();
}

function stopAndPurgeClarityIfTainted(): void {
  if (!clarityTaintedCurrentRealm) return;
  clarityTaintedCurrentRealm = false;

  if (typeof window !== "undefined") {
    const win = window as Window & { clarity?: (...args: unknown[]) => void };
    try {
      win.clarity?.("consent", false);
      win.clarity?.("stop");
    } catch {
      // Ignore vendor teardown errors before hard realm reload.
    }
    delete win.clarity;
  }
  if (typeof document !== "undefined") {
    document.querySelectorAll('script[data-rp-clarity="true"]').forEach((el) => el.remove());
  }

  if (customRealmPurgeHandler) {
    customRealmPurgeHandler();
    return;
  }
  if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
    try {
      window.location.reload();
    } catch {
      // jsdom does not implement navigation reload; customRealmPurgeHandler covers tests.
    }
  }
}

export function setAnalyticsConsent(next: AnalyticsConsentDecision): void {
  const prev = currentDecision;
  currentDecision = next;
  if (prev === "granted" && next !== "granted") {
    stopAndPurgeClarityIfTainted();
  }
  emitChange();
}

export function useAnalyticsConsent() {
  const [pathname] = useLocation();
  const decision = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  const isEligibleRoute = isEligibleAnalyticsPath(pathname);

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

function mountClarityTag(projectId: string): void {
  if (typeof document === "undefined" || !CLARITY_ID_PATTERN.test(projectId)) return;
  const existing = document.querySelector('script[data-rp-clarity="true"]');
  if (existing) return;

  // Initialize vendor queue function without inline `<script>` or eval.
  const win = window as Window & {
    clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  };
  if (typeof win.clarity !== "function") {
    const fn = ((...args: unknown[]) => {
      (fn.q ??= []).push(args);
    }) as ((...args: unknown[]) => void) & { q?: unknown[][] };
    win.clarity = fn;
  }

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
  script.setAttribute("data-rp-clarity", "true");
  script.referrerPolicy = "strict-origin-when-cross-origin";
  clarityTaintedCurrentRealm = true;
  document.head.appendChild(script);
}

function sendMinimalPostHogPageview(host: string, key: string, pathname: string): void {
  if (!POSTHOG_KEY_PATTERN.test(key) || !isSafeHttpsOriginClient(host)) return;
  if (!isEligibleAnalyticsPath(pathname)) return;
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
  const session = useSession();
  const trpc = useTRPC();
  const { decision, grant, deny, reset } = useAnalyticsConsent();

  const eligibleRoute = isEligibleAnalyticsPath(pathname);
  const isAnonymousVisitor = session.view.status === "anonymous";

  const configQuery = useQuery({
    ...trpc.integrations.publicAnalyticsConfig.queryOptions(),
    enabled: configOverride === undefined && eligibleRoute && isAnonymousVisitor,
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

  // Enforce JS-realm isolation: if Clarity ever ran and the user leaves eligible public routes or signs in, purge realm!
  useEffect(() => {
    if (!eligibleRoute || !isAnonymousVisitor || !anyProviderActive || decision !== "granted") {
      lastCapturedPathRef.current = null;
      if (clarityTaintedCurrentRealm && (!eligibleRoute || !isAnonymousVisitor || !clarityReady)) {
        stopAndPurgeClarityIfTainted();
      }
      return;
    }

    if (clarityReady && cfg?.clarity.projectId) {
      mountClarityTag(cfg.clarity.projectId);
    }

    if (posthogReady && cfg?.posthog.host && cfg.posthog.key && lastCapturedPathRef.current !== pathname) {
      lastCapturedPathRef.current = pathname;
      sendMinimalPostHogPageview(cfg.posthog.host, cfg.posthog.key, pathname);
    }
  }, [
    anyProviderActive,
    cfg?.clarity.projectId,
    cfg?.posthog.host,
    cfg?.posthog.key,
    clarityReady,
    decision,
    eligibleRoute,
    isAnonymousVisitor,
    pathname,
    posthogReady,
  ]);

  if (!eligibleRoute || !isAnonymousVisitor || !anyProviderActive) {
    return null;
  }

  if (decision === "granted") {
    return (
      <aside
        aria-label="Analytics privacy preference"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-2.5 text-sm text-body shadow-[var(--shadow-card)]"
      >
        <span className="text-muted">Public-page analytics active for this session.</span>
        <Button size="sm" variant="secondary" onClick={deny}>
          Withdraw consent
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
        <span className="text-muted">Analytics declined for this session.</span>
        <Button size="sm" variant="ghost" onClick={reset}>
          Change preference
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
            Optional public-page analytics
          </h2>
          <p className="text-sm text-muted">
            May we enable {providerLabel} on public legal pages for this session? Sign-in, security, customer
            portal and administrative pages never load external analytics.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={deny}>
            Decline
          </Button>
          <Button size="sm" variant="primary" onClick={grant}>
            Allow for session
          </Button>
        </div>
      </div>
    </section>
  );
}

export default AnalyticsConsentSlot;
