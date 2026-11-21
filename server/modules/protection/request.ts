import type { Request } from "express";
import { clientAddress, routeTemplate } from "../../http/edge.js";
import { addressOf, inspectedHeaderNames, type RequestSignals } from "./policy.js";

function normalize(text: string, max: number) {
  let value = text.slice(0, max);
  for (let pass = 0; pass < 2; pass++) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value.toLowerCase();
}

export function requestSignals(req: Request, country: string | null): RequestSignals {
  const boundary = req.originalUrl.indexOf("?");
  const rawLength = req.get("content-length");
  const headers: RequestSignals["headers"] = {};
  for (const name of inspectedHeaderNames()) {
    const header = req.get(name);
    if (header) headers[name] = normalize(header, 512);
  }
  return {
    path: normalize(req.path, 8192),
    query: boundary === -1 ? "" : normalize(req.originalUrl.slice(boundary + 1).replaceAll("+", " "), 8192),
    method: req.method,
    headers,
    address: addressOf(clientAddress(req)),
    country,
    oversize: req.originalUrl.length > 4096 || (req.is("application/json") === "application/json" && Number(rawLength) > 262_144),
  };
}

const methods = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"]);
export function requestEventLabels(req: Request, userAgent: string | undefined) {
  const agent = userAgent ?? "";
  const family = agent.includes("firefox/") ? "Firefox" : agent.includes("edg/") ? "Edge" :
    agent.includes("chrome/") || agent.includes("crios/") ? "Chromium" : agent.includes("safari/") ? "Safari" :
    agent.includes("curl/") ? "curl" : agent ? "Other" : "None";
  return { method: methods.has(req.method) ? req.method : "OTHER", route: routeTemplate(req), agent: family };
}

export function isProtectionExempt(req: Request): boolean {
  return (req.method === "GET" || req.method === "HEAD") &&
    (req.path === "/healthz" || req.path === "/readyz" || /^\/\.well-known\/acme-challenge\/[A-Za-z0-9_-]{1,128}$/.test(req.path));
}

// Check exact administration actions and navigation paths (including sessions without an Origin header).
const recoveryPaths: [string, string][] = [
  ["GET", "/admin"], ["GET", "/sign-in"], ["GET", "/admin/protection"], ["GET", "/admin/protection/rules"],
  ["GET", "/admin/protection/ip-lists"], ["GET", "/admin/protection/countries"], ["GET", "/admin/protection/rate-limits"],
  ["GET", "/admin/protection/events"], ["GET", "/api/csrf"],
  ["POST", "/api/trpc/identity.signin"], ["POST", "/api/trpc/assurance.stepup"],
  ["GET", "/api/trpc/protection.getpolicy"], ["POST", "/api/trpc/protection.setpolicy"],
  ["POST", "/api/trpc/protection.releaseblock"],
];

export function recoverySignals(source: RequestSignals): RequestSignals[] {
  return [source, ...recoveryPaths.map(([method, path]) => ({ ...source, path, query: "", method, oversize: false }))];
}
