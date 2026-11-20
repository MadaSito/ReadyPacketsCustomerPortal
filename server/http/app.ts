/**
 * Express application composition. Owner: http_security engineer. Integrator stub: keep the signature.
 *
 * REQUIRED ORDER (architecture §4.1 / §9.3):
 *   1. trust-proxy from config.trustedProxies; server-generated request context (AsyncLocalStorage)
 *   2. host validation (canonical host only; alias hosts 308 → canonical; unknown hosts refused)
 *   3. security headers + per-response nonce CSP; raw signed webhooks (before body parsing)
 *   4. bounded body parsers
 *   5. session resolution (services.sessionResolver) → request actor
 *   6. CSRF/origin enforcement for unsafe methods (identity is resolved BEFORE this check)
 *   7. rate limits  8. /api/trpc (createContext)  9. module raw routes (createModuleHttpRouter)
 *  10. health endpoints  11. static assets + SPA fallback (prebuilt dist/public; no dev server in production)
 *  12. safe JSON error handler (never stacks/SQL/paths)
 */
import type { Express } from "express";
import type { Services } from "../container.js";

export interface AppOptions {
  /** Directory with the built client (dist/public). Omit to serve API only (tests). */
  staticDir?: string;
}

export function createApp(_services: Services, _options: AppOptions = {}): Express {
  throw new Error("NOT_IMPLEMENTED: createApp (http_security engineer)");
}
