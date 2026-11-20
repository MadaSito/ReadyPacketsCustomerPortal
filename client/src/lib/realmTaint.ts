/**
 * JS-realm taint flag (review finding INT-01). Owner: ui_foundation_engineer (authorised by /root).
 *
 * Once any third-party analytics code has run in, or been contacted from, this document, the realm is "tainted"
 * for the rest of the document's life. The app root then refuses to commit any private or personalised DOM and
 * restarts in a fresh realm with a full document navigation instead (see app/RealmTaint.tsx).
 *
 * Contract for integrations: call `markRealmTainted(vendor)` SYNCHRONOUSLY, immediately BEFORE injecting a vendor
 * script or sending a vendor request.
 *
 * State is module memory only. There is no storage, so a reload is what clears it, and that is intended.
 */
export type AnalyticsVendor = "clarity" | "posthog";

const vendors = new Set<AnalyticsVendor>();
const listeners = new Set<() => void>();

export function markRealmTainted(vendor: AnalyticsVendor): void {
  if (vendors.has(vendor)) return;
  vendors.add(vendor);
  for (const listener of [...listeners]) listener();
}

export function isRealmTainted(): boolean {
  return vendors.size > 0;
}

export function realmTaintVendors(): readonly AnalyticsVendor[] {
  return [...vendors];
}

/** Returns an unsubscribe function. Matches the useSyncExternalStore subscribe signature. */
export function subscribeRealmTaint(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---------------------------------------------------------------- one-shot hard navigation into a clean realm */

type HardNavigate = (mode: "replace" | "assign", url: string) => void;
const defaultHardNavigate: HardNavigate = (mode, url) => {
  if (mode === "replace") window.location.replace(url);
  else window.location.assign(url);
};
let hardNavigateImpl: HardNavigate = defaultHardNavigate;
let navigationRequested = false;

/** Keeps only an app-absolute pathname (no search, no hash, no origin switch). */
export function cleanRealmPath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? "/";
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : "/";
}

/**
 * Requests a full document navigation to `pathname` (search and hash are stripped). Only the first request per
 * document takes effect, so repeated renders cannot cause a navigation loop or a race between two targets.
 */
export function requestCleanRealm(mode: "replace" | "assign", pathname: string): boolean {
  if (navigationRequested) return false;
  navigationRequested = true;
  hardNavigateImpl(mode, cleanRealmPath(pathname));
  return true;
}

/** Test hooks (jsdom cannot spy on window.location). */
export function __setHardNavigateForTests(fn: HardNavigate | null): void {
  hardNavigateImpl = fn ?? defaultHardNavigate;
}
export function __resetRealmTaintForTests(): void {
  vendors.clear();
  navigationRequested = false;
  for (const listener of [...listeners]) listener();
}
