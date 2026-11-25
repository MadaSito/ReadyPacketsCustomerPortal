import { isIP } from "node:net";
import type { Request } from "express";
import { isolatedRoutePrefix } from "./isolatedRoutes.js";
import { isSamlRouteFamily, SAML_ACS_PATH, SAML_METADATA_PATH, SAML_START_PATH } from "./providerPaths.js";

const PROBE_PATHS = new Set(["/healthz", "/readyz"]);
export const API_PATH = /^\/api(?:\/|$)/;
export const TRPC_PATH = "/api/trpc";
export const SIGNED_WEBHOOK_PATH = "/api/integrations/webhooks";

export function requestHost(req: Request, canonical: URL): { host: string; hostname: string } | null {
  // Only the actual Host is authority. X-Forwarded-Host is ignored, even from a trusted peer.
  const authority = req.get("Host")?.toLowerCase();
  if (!authority || !/^(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/.test(authority)) return null;
  try {
    const parsed = new URL(`${canonical.protocol}//${authority}`);
    return { host: parsed.host, hostname: parsed.hostname };
  } catch {
    return null;
  }
}

export function acceptsLocalProbe(req: Request, hostname: string | undefined): boolean {
  if ((req.method !== "GET" && req.method !== "HEAD") || !PROBE_PATHS.has(req.path)) return false;
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
  return (peer === "127.0.0.1" || peer === "::1") &&
    (hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost") &&
    !req.get("X-Forwarded-For") && !req.get("Forwarded");
}

export function clientAddress(req: Request): string | undefined {
  const raw = req.ip ?? req.socket.remoteAddress;
  if (!raw) return undefined;
  const family = isIP(raw);
  if (family === 4) return raw;
  if (family !== 6) return undefined;
  // Canonicalize once for audit pseudonyms, credential bans and other request-context consumers.
  const source = raw.split("%", 1)[0];
  const canonical = new URL(`http://[${source}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isNavigation(req: Request): boolean {
  if (req.method !== "GET" || (req.get("Sec-Fetch-Mode") && req.get("Sec-Fetch-Mode") !== "navigate")) return false;
  const explicitHtml = req.get("Accept")?.split(",").some((range) => /^\s*text\/html(?:\s*;|$)/i.test(range));
  return explicitHtml === true && req.accepts("html") !== false;
}

const MODULES = new Set([
  "identity", "assurance", "orders", "files", "engagement", "compliance", "audit", "siem",
  "platform", "jobs", "portable", "backup", "integrations", "storage",
  "knowledge", "referrals",
]);

/** Only fixed labels are emitted; callback paths may carry credentials in their query. */
export function providerCallbackRoute(path: string): string | undefined {
  if (path === SAML_ACS_PATH || path === SAML_METADATA_PATH || path === SAML_START_PATH) return path;
  if (isSamlRouteFamily(path)) return "/api/identity/saml/:route";
  if (/^\/api\/storage\/oauth\/callback(?:\/|$)/i.test(path)) return "/api/storage/oauth/callback/:provider";
  if (/^\/api\/identity\/sso\/callback\/?$/i.test(path)) return "/api/identity/sso/callback";
  return undefined;
}

export function routeTemplate(req: Request): string {
  const path = req.path;
  const oauth = providerCallbackRoute(path);
  if (oauth) return oauth;
  const isolated = isolatedRoutePrefix(path);
  if (isolated) return `${isolated}/:route`;
  if (PROBE_PATHS.has(path) || path === "/robots.txt" || path === "/api/csrf") return path;
  if (path === SIGNED_WEBHOOK_PATH || path.startsWith(`${SIGNED_WEBHOOK_PATH}/`)) return `${SIGNED_WEBHOOK_PATH}/:provider`;
  if (/^\/api\/files\/playback(?:\/|$)/.test(path)) return "/api/files/playback/:grant";
  if (path === TRPC_PATH || path.startsWith(`${TRPC_PATH}/`)) return `${TRPC_PATH}/:procedures`;
  if (API_PATH.test(path)) {
    const module = path.split("/", 3)[2] ?? "";
    return MODULES.has(module) ? `/api/${module}/:route` : "/api/:route";
  }
  return isNavigation(req) ? "/:page" : "/:asset";
}
