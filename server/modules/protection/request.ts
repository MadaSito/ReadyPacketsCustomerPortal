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
  const path = normalize(req.path, 8192);
  return {
    path,
    query: boundary === -1 ? "" : normalize(req.originalUrl.slice(boundary + 1).replaceAll("+", " "), 8192),
    method: req.method,
    headers,
    address: addressOf(clientAddress(req)),
    country,
    oversize: req.originalUrl.length > 4096 || (req.is("application/json") === "application/json" && Number(rawLength) > 262_144),
    recovery: isRecoveryPath(path, req.method),
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

const recoveryNavigation = [
  "/admin", "/sign-in", "/mfa", "/mfa/enrol", "/mfa/recovery-codes", "/change-password", "/verify-email", "/api/csrf",
  "/admin/protection", "/admin/protection/rules", "/admin/protection/ip-lists", "/admin/protection/countries",
  "/admin/protection/rate-limits", "/admin/protection/events",
] as const;
const recoveryQueries = [
  "identity.me", "identity.passwordpolicy", "assurance.getstate", "jobs.maintenance.customeraccess",
  "protection.overview", "protection.getpolicy", "protection.getratelimits", "protection.listblocks", "protection.listevents",
] as const;
const recoveryMutations = [
  "identity.signin", "identity.changepassword", "identity.verifyemail", "identity.resendverification",
  "assurance.challenge", "assurance.beginpasskeyauthentication", "assurance.stepup", "assurance.begintotpenrollment",
  "assurance.confirmtotpenrollment", "assurance.acknowledgerecoverycodes", "assurance.recoverunacknowledgedcodes",
  "protection.setpolicy", "protection.releaseblock", "protection.setratelimit", "protection.resetratelimit",
] as const;
const recoverNav = new Set<string>(recoveryNavigation);
const recoverGet = new Set<string>(recoveryQueries);
const recoverPost = new Set<string>(recoveryMutations);

export function isRecoveryPath(path: string, method: string): boolean {
  if (method === "GET" || method === "HEAD") {
    const bare = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (recoverNav.has(bare) || /^\/(?:assets|fonts)\/[a-z0-9_.-]+\.(?:m?js|css|woff2)$/.test(bare)) return true;
  }
  if (!path.startsWith("/api/trpc/")) return false;
  const relevant = method === "GET" || method === "HEAD" ? recoverGet : method === "POST" ? recoverPost : undefined;
  // Do not let a mixed batch inherit the recovery exception from just one RPC.
  return relevant !== undefined && path.slice("/api/trpc/".length).split(",").every((name) => relevant.has(name));
}

const recoveryPaths: [string, string][] = [
  ...recoveryNavigation.map((path): [string, string] => ["GET", path]),
  ...recoveryQueries.map((path): [string, string] => ["GET", `/api/trpc/${path}`]),
  ...recoveryMutations.map((path): [string, string] => ["POST", `/api/trpc/${path}`]),
  ["GET", `/api/trpc/${recoveryQueries.join(",")}`],
];

export function recoverySignals(source: RequestSignals): RequestSignals[] {
  return [
    { ...source, recovery: false },
    ...recoveryPaths.flatMap(([method, path]) => ["", "batch=1"].map((query) => (
      { ...source, path, query, method, oversize: false, recovery: false }
    ))),
  ];
}
