/**
 * Browser side of the session transport. Owner: http_security engineer (integrator-seeded baseline; must stay
 * in lock-step with server/http/sessionTransport.ts).
 *
 * production/development: the session lives in a `__Host-` HttpOnly cookie the script can never read. Unsafe
 *   requests carry the CSRF token from the readable `__Host-rp_csrf` double-submit cookie in `X-RP-CSRF`.
 * preview ONLY: sandboxed iframes have no cookies, so the server returns the session + CSRF tokens in response
 *   headers and they are held in this module's memory (lost on reload by design). The server accepts this
 *   transport only when its deployment profile is `preview`.
 */
import {
  HEADER_CSRF, HEADER_PREVIEW_CSRF_SET, HEADER_PREVIEW_SESSION, HEADER_PREVIEW_SESSION_SET,
} from "@shared/sessionTransportHeaders";
import { apiUrl, RUNTIME } from "./runtime";

export { HEADER_CSRF, HEADER_PREVIEW_CSRF_SET, HEADER_PREVIEW_SESSION, HEADER_PREVIEW_SESSION_SET };

let previewSession: string | null = null;
let previewCsrf: string | null = null;
let bootstrap: Promise<void> | null = null;
let lastBootstrap = 0;
let revision = 0;
const listeners = new Set<() => void>();
const BOOTSTRAP_FRESHNESS_MS = 10 * 60_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Notified when the server cleared or replaced the session (so the app can refetch `identity.me`). */
export function onSessionChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readCookie(name: string): string | null {
  let cookie: string;
  try {
    cookie = document.cookie;
  } catch {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function csrfToken(): string | null {
  if (RUNTIME.preview) return previewCsrf;
  return readCookie("__Host-rp_csrf") ?? readCookie("rp_csrf_dev");
}

/** Headers every state-changing or authenticated raw request (uploads, downloads) must include. */
export function sessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const csrf = csrfToken();
  if (csrf) headers[HEADER_CSRF] = csrf;
  if (RUNTIME.preview && previewSession) headers[HEADER_PREVIEW_SESSION] = previewSession;
  return headers;
}

/** Clears only memory-backed preview credentials and invalidates all earlier transport responses. */
export function clearPreviewCredentials(): void {
  if (!RUNTIME.preview) return;
  const changed = previewSession !== null;
  previewSession = null;
  previewCsrf = null;
  bootstrap = null;
  lastBootstrap = 0;
  revision++;
  if (changed) listeners.forEach((listener) => listener());
}

function applyPreviewResponse(response: Response, sentRevision: number): void {
  if (!RUNTIME.preview || sentRevision !== revision) return;
  const nextSession = response.headers.get(HEADER_PREVIEW_SESSION_SET);
  const nextCsrf = response.headers.get(HEADER_PREVIEW_CSRF_SET);
  if (nextSession !== null) {
    const changed = (nextSession || null) !== previewSession;
    previewSession = nextSession || null;
    previewCsrf = nextCsrf || null;
    lastBootstrap = previewCsrf ? Date.now() : 0;
    revision++;
    if (changed) listeners.forEach((listener) => listener());
  } else if (nextCsrf !== null) {
    previewCsrf = nextCsrf || null;
  }
}

async function ensureCsrf(): Promise<void> {
  if (csrfToken() && Date.now() - lastBootstrap < BOOTSTRAP_FRESHNESS_MS) return;
  if (!bootstrap) {
    const sentRevision = revision;
    const headers = new Headers();
    if (RUNTIME.preview && previewSession) headers.set(HEADER_PREVIEW_SESSION, previewSession);
    const pending = fetch(apiUrl("/api/csrf"), {
      headers, credentials: RUNTIME.preview ? "omit" : "same-origin", redirect: "error", cache: "no-store",
    }).then((response) => {
      if (!response.ok || (RUNTIME.preview && sentRevision !== revision)) {
        throw new Error("Your security token could not be initialized. Please try again.");
      }
      applyPreviewResponse(response, sentRevision);
      if (!csrfToken()) throw new Error("Your security token could not be initialized. Please check your browser settings.");
      lastBootstrap = Date.now();
    }).finally(() => { if (bootstrap === pending) bootstrap = null; });
    bootstrap = pending;
  }
  await bootstrap;
}

function assertApiDestination(input: RequestInfo | URL): URL {
  const actual = new URL(input instanceof Request ? input.url : input.toString(), document.baseURI);
  const api = new URL(apiUrl("/api"), document.baseURI);
  if (actual.origin !== api.origin || !(actual.pathname === api.pathname || actual.pathname.startsWith(`${api.pathname}/`))) {
    throw new Error("Authenticated requests must target the portal API.");
  }
  return actual;
}

function isIdentitySignOut(target: URL): boolean {
  const prefix = new URL(apiUrl("/api/trpc/"), document.baseURI).pathname;
  return target.pathname.startsWith(prefix) &&
    target.pathname.slice(prefix.length).split(/,|%2C/i).includes("identity.signOut");
}

/** fetch wrapper used by tRPC and by feature code for raw endpoints (multipart upload, blob download). */
export const sessionFetch: typeof fetch = async (input, init) => {
  const target = assertApiDestination(input);
  const original = input instanceof Request ? input : undefined;
  const method = (init?.method ?? original?.method ?? "GET").toUpperCase();
  const unsafe = !SAFE_METHODS.has(method);
  const previewSignOut = RUNTIME.preview && method === "POST" && isIdentitySignOut(target);
  // The session already carries its bound CSRF token. Do not wait for a bootstrap
  // when signing out: even a stalled or unavailable API must not retain local auth.
  if (unsafe && !previewSignOut) await ensureCsrf();
  const headers = new Headers(init?.headers ?? original?.headers);
  headers.delete(HEADER_CSRF);
  headers.delete(HEADER_PREVIEW_SESSION);
  for (const [key, value] of Object.entries(sessionHeaders())) headers.set(key, value);
  if (!unsafe) headers.delete(HEADER_CSRF);
  const sentRevision = revision;
  if (previewSignOut) clearPreviewCredentials();
  const response = await fetch(input, {
    ...init, headers, credentials: RUNTIME.preview ? "omit" : "same-origin", redirect: "error",
  });
  applyPreviewResponse(response, sentRevision);
  // No automatic mutation retry: a network/authorization error is not proof of no effects.
  if (unsafe && sentRevision === revision && (response.status === 403 || response.status === 401)) lastBootstrap = 0;
  return response;
};
