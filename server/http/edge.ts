import { isIP } from "node:net";
import type { Request } from "express";
import { isolatedRoutePrefix } from "./isolatedRoutes.js";

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
  const address = req.ip ?? req.socket.remoteAddress;
  if (!address || !isIP(address)) return undefined;
  const unmapped = address.replace(/^::ffff:/i, "");
  return isIP(unmapped) === 4 ? unmapped : address;
}

export function isNavigation(req: Request): boolean {
  if (req.method !== "GET" || (req.get("Sec-Fetch-Mode") && req.get("Sec-Fetch-Mode") !== "navigate")) return false;
  const explicitHtml = req.get("Accept")?.split(",").some((range) => /^\s*text\/html(?:\s*;|$)/i.test(range));
  return explicitHtml === true && req.accepts("html") !== false;
}

const MODULES = new Set([
  "identity", "assurance", "orders", "files", "engagement", "compliance", "audit", "siem",
  "platform", "jobs", "portable", "backup", "integrations", "storage",
]);

/** Only fixed labels are emitted; callback paths may carry credentials in their query. */
export function providerCallbackRoute(path: string): string | undefined {
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
  if (path === TRPC_PATH || path.startsWith(`${TRPC_PATH}/`)) return `${TRPC_PATH}/:procedures`;
  if (API_PATH.test(path)) {
    const module = path.split("/", 3)[2] ?? "";
    return MODULES.has(module) ? `/api/${module}/:route` : "/api/:route";
  }
  return isNavigation(req) ? "/:page" : "/:asset";
}
