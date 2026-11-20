/**
 * Render quarantine for a JS realm tainted by third-party analytics (INT-01). See lib/realmTaint.ts.
 *
 * - RealmTaintBoundary (app root, above the router and shells): if the realm is tainted and the session is anything
 *   other than anonymous (remediation or full), ONLY a neutral status renders, and the document is replaced at the
 *   same pathname (no search or hash) so the app restarts in a clean realm.
 * - TaintedRouteGate (inside the router, above every route): if the realm is tainted, only /privacy and /terms may
 *   render. Every other location, including sign-in and register, is left by a full document navigation and never
 *   rendered in the tainted realm.
 * - While tainted, RouteGate renders /privacy and /terms in the anonymous PublicFrame whatever the session.
 *
 * Analytics never loads in the preview build (hash routing), so preview hash paths never reach this code.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useLocation } from "wouter";
import { isRealmTainted, requestCleanRealm, subscribeRealmTaint } from "@/lib/realmTaint";
import { useSession } from "@/lib/session";

/** The only routes allowed to render in a tainted realm. Mirrors the consent loader's allowlist. */
export const TAINT_SAFE_PATHS: ReadonlySet<string> = new Set(["/privacy", "/terms"]);

export function useRealmTainted(): boolean {
  return useSyncExternalStore(subscribeRealmTaint, isRealmTainted, isRealmTainted);
}

export function ReloadingSecurely() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-soft p-6">
      <p role="status" className="text-base text-body" data-testid="realm-reloading">
        Reloading securely…
      </p>
    </div>
  );
}

export function RealmTaintBoundary({ children }: { children: ReactNode }) {
  const tainted = useRealmTainted();
  const { view } = useSession();
  const quarantine = tainted && (view.status === "full" || view.status === "remediation");
  useEffect(() => {
    if (quarantine) requestCleanRealm("replace", window.location.pathname);
  }, [quarantine]);
  return quarantine ? <ReloadingSecurely /> : <>{children}</>;
}

export function TaintedRouteGate({ children }: { children: ReactNode }) {
  const tainted = useRealmTainted();
  const [location] = useLocation();
  const leave = tainted && !TAINT_SAFE_PATHS.has(location);
  useEffect(() => {
    if (leave) requestCleanRealm("assign", location);
  }, [leave, location]);
  return leave ? <ReloadingSecurely /> : <>{children}</>;
}
