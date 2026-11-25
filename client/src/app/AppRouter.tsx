/**
 * Routing: path routing normally, hash routing in the preview build. Every registered route goes through
 * RouteGate (guard → shell → lazy page → focus/title/announce). Unknown paths render the 404 page inside the
 * shell that matches the visitor's session.
 */
import { Suspense, useEffect, useRef, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { ALL_ROUTES } from "./registry";
import type { RouteDef } from "@/lib/routes";
import { RUNTIME } from "@/lib/runtime";
import { clearRecoveryBatch } from "@/lib/recoveryBatch";
import { clearCustomerPortalChoice, readCustomerPortalChoice } from "@/lib/portal";
import { useSession } from "@/lib/session";
import type { MeUser } from "@/lib/authApi";
import { Spinner, useToast } from "@/ui";
import { ErrorBoundary } from "./ErrorBoundary";
import { decideRoute, type SessionView } from "./guard";
import { SessionIdleTimeout } from "./IdleTimeout";
import { NotFoundPage, ServiceUnavailablePage } from "./pages";
import { TaintedRouteGate, useRealmTainted } from "./RealmTaint";
import { RouteAnnouncerProvider, RouteFocus } from "./RouteFocus";
import { ConsoleShell } from "./shell/ConsoleShell";
import { CustomerShell } from "./shell/CustomerShell";
import { PublicFrame } from "./shell/PublicFrame";

function PageLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-action">
      <Spinner size="lg" label="Loading page" />
    </div>
  );
}

function Frame({ kind, user, children }: { kind: "public" | "customer" | "console"; user?: MeUser; children: ReactNode }) {
  if (kind === "console" && user) return <ConsoleShell user={user}>{children}</ConsoleShell>;
  if (kind === "customer" && user) return <CustomerShell user={user}>{children}</CustomerShell>;
  return <PublicFrame>{children}</PublicFrame>;
}

function frameFor(route: Pick<RouteDef, "access" | "path">, view: SessionView): "public" | "customer" | "console" {
  if (route.access === "public" || route.access === "transition") return view.status === "full" && route.access === "public" && !/^\/(sign-in|register)/.test(route.path) ? "customer" : "public";
  if (route.access === "staff" || route.access === "admin" || route.path.startsWith("/admin")) return "console";
  return "customer";
}

/** Watches for a full session ending (expiry/revocation elsewhere) and tells the user once. */
function useSessionEndNotice(view: SessionView) {
  const previous = useRef(view.status);
  const toast = useToast();
  useEffect(() => {
    // Definitive signed-out state (not transient errors): drop any staged one-time recovery batch.
    if (view.status === "anonymous") {
      clearRecoveryBatch();
      clearCustomerPortalChoice();
    }
    if ((previous.current === "full" || previous.current === "remediation") && view.status === "anonymous") {
      toast.show({ tone: "warning", title: "Your session has ended", description: "Please sign in again to continue." });
    }
    previous.current = view.status;
  }, [view.status, toast]);
}

function RouteGate({ route }: { route: RouteDef }) {
  const [location] = useLocation();
  const { view, me } = useSession();
  const tainted = useRealmTainted();
  useSessionEndNotice(view);
  const decision = decideRoute(route.access, location, view, { customerPortalChosen: readCustomerPortalChoice() });
  if (decision.kind === "loading") return <PageLoading />;
  if (decision.kind === "redirect") return <Redirect to={decision.to} replace />;
  if (decision.kind === "unavailable") {
    return (
      <PublicFrame>
        <ServiceUnavailablePage />
        <RouteFocus title="Service unavailable" path={location} />
      </PublicFrame>
    );
  }
  // INT-01: a tainted realm only ever shows the anonymous public frame (TaintedRouteGate limits it to /privacy, /terms).
  const kind = tainted ? "public" : frameFor(route, view);
  const user = tainted ? undefined : me?.user;
  if (decision.kind === "not-found") {
    return (
      <Frame kind={user ? (user.role === "customer" ? "customer" : "console") : "public"} user={user}>
        <NotFoundPage />
        <RouteFocus title="Page not found" path={location} />
      </Frame>
    );
  }
  const Page = route.component as ComponentType;
  return (
    <Frame kind={kind} user={user}>
      {view.status === "full" && !tainted ? <SessionIdleTimeout /> : null}
      <ErrorBoundary resetKey={location}>
        <Suspense fallback={<PageLoading />}>
          <Page />
          <RouteFocus title={route.title} path={location} />
        </Suspense>
      </ErrorBoundary>
    </Frame>
  );
}

function FallbackGate() {
  const [location] = useLocation();
  const { view, me } = useSession();
  if (view.status === "loading") return <PageLoading />;
  if (view.status === "remediation") return <RedirectToGate />;
  const user = view.status === "full" ? me?.user : undefined;
  return (
    <Frame kind={user ? (location.startsWith("/admin") && user.role !== "customer" ? "console" : "customer") : "public"} user={user}>
      <NotFoundPage />
      <RouteFocus title="Page not found" path={location} />
    </Frame>
  );
}

/** Remediation sessions on unknown paths are sent to their step via the guard of a transition route. */
function RedirectToGate() {
  const { view } = useSession();
  const decision = decideRoute("customer", "/", view);
  return decision.kind === "redirect" ? <Redirect to={decision.to} replace /> : <PageLoading />;
}

export function routeKey(route: RouteDef): string {
  return `${route.access}:${route.path}`;
}

export function AppRoutes({ routes = ALL_ROUTES }: { routes?: readonly RouteDef[] }) {
  return (
    <RouteAnnouncerProvider>
      <TaintedRouteGate>
      <Switch>
        {routes.map((route) => (
          <Route key={routeKey(route)} path={route.path}>
            <RouteGate route={route} />
          </Route>
        ))}
        <Route>
          <FallbackGate />
        </Route>
      </Switch>
      </TaintedRouteGate>
    </RouteAnnouncerProvider>
  );
}

/**
 * Preview hash routing. wouter's hash hook keeps any `?query` typed inside the hash as part of the path
 * (`#/reset-password?token=…` would not match). Split it: path from the hash, search from the hash query
 * when present, otherwise from the real query string (where wouter's own navigate puts it).
 */
export function splitHash(hash: string, search: string): { path: string; search: string } {
  const raw = hash.replace(/^#?\/?/, "");
  const q = raw.indexOf("?");
  return { path: `/${q >= 0 ? raw.slice(0, q) : raw}`, search: q >= 0 ? raw.slice(q + 1) : search.replace(/^\?/, "") };
}
const subscribeUrl = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  window.addEventListener("popstate", cb);
  return () => {
    window.removeEventListener("hashchange", cb);
    window.removeEventListener("popstate", cb);
  };
};
/** Canonical preview URL: `<doc>#/path?query` with an empty document search (old params never linger). */
export function previewNavigate(to: string, options: { replace?: boolean; state?: unknown } = {}): void {
  const oldURL = window.location.href;
  const url = new URL(oldURL);
  url.search = "";
  url.hash = `/${to.replace(/^#?\/?/, "")}`;
  window.history[options.replace ? "replaceState" : "pushState"](options.state ?? null, "", url.href);
  window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: url.href }));
}
function usePreviewLocation(): [string, typeof previewNavigate] {
  const navigate = previewNavigate;
  const path = useSyncExternalStore(subscribeUrl, () => splitHash(window.location.hash, window.location.search).path);
  return [path, navigate];
}
usePreviewLocation.hrefs = (href: string) => `#${href}`;
usePreviewLocation.searchHook = function usePreviewSearch(): string {
  return useSyncExternalStore(subscribeUrl, () => splitHash(window.location.hash, window.location.search).search);
};

export function AppRouter() {
  return (
    <Router hook={RUNTIME.preview ? usePreviewLocation : undefined}>
      <AppRoutes />
    </Router>
  );
}
