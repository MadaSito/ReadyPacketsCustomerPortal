/**
 * Build/runtime wiring. Owner: integrator (/root).
 *
 * production / development: path routing, same-origin API, `__Host-` HttpOnly cookie session + CSRF header.
 * preview (sandboxed iframe demo only): hash routing, proxied API base, in-memory header session.
 * NOTHING here (or anywhere in the client) may use localStorage, sessionStorage, IndexedDB or document.cookie
 * writes for session material.
 */
const meta = (name: string): string => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() ?? "";

const rawBase = meta("rp-api-base");
const unresolved = rawBase === "" || rawBase.startsWith("%") || rawBase.startsWith("__PORT_");

export const RUNTIME = {
  /** True only in the sandboxed preview build. */
  preview: meta("rp-runtime") === "preview",
  /** "" for same-origin; a proxy path prefix in the hosted preview. */
  apiBase: unresolved ? "" : rawBase.replace(/\/$/, ""),
} as const;

export const apiUrl = (path: string): string => `${RUNTIME.apiBase}${path.startsWith("/") ? path : `/${path}`}`;

/**
 * Resolves a public asset (brand/…, fonts/…). Standard builds are served at the origin root with nested path
 * routes, so assets are root-absolute; the preview build lives under an unknown path prefix with hash routing,
 * so assets resolve relative to the document.
 */
export const assetUrl = (relativePath: string): string =>
  new URL(`${RUNTIME.preview ? "" : "/"}${relativePath.replace(/^\//, "")}`, document.baseURI).toString();
