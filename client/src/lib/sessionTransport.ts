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
import { RUNTIME } from "./runtime";

export const HEADER_CSRF = "x-rp-csrf";
export const HEADER_PREVIEW_SESSION = "x-rp-preview-session";
export const HEADER_PREVIEW_SESSION_SET = "x-rp-preview-session-set";
export const HEADER_PREVIEW_CSRF_SET = "x-rp-preview-csrf-set";

let previewSession: string | null = null;
let previewCsrf: string | null = null;
const listeners = new Set<() => void>();

/** Notified when the server cleared or replaced the session (so the app can refetch `identity.me`). */
export function onSessionChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
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

/** fetch wrapper used by tRPC and by feature code for raw endpoints (multipart upload, blob download). */
export const sessionFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(sessionHeaders())) headers.set(key, value);
  const response = await fetch(input, { ...init, headers, credentials: RUNTIME.preview ? "omit" : "same-origin" });
  if (RUNTIME.preview) {
    const nextSession = response.headers.get(HEADER_PREVIEW_SESSION_SET);
    const nextCsrf = response.headers.get(HEADER_PREVIEW_CSRF_SET);
    if (nextSession !== null) {
      const changed = (nextSession || null) !== previewSession;
      previewSession = nextSession || null;
      previewCsrf = nextCsrf || null;
      if (changed) listeners.forEach((listener) => listener());
    } else if (nextCsrf !== null) {
      previewCsrf = nextCsrf || null;
    }
  }
  return response;
};
