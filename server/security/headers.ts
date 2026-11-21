import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { PreviewProfile } from "../http/previewProfile.js";

export interface AnalyticsCspPolicy {
  scriptSrc?: readonly string[];
  connectSrc?: readonly string[];
}

export function newCspNonce(): string {
  return randomBytes(18).toString("base64url");
}

function exactHttpsOrigins(values: readonly string[] | undefined): string[] {
  if (!values || !Array.isArray(values) || values.length > 32) return [];
  return [...new Set(values.filter((source) => {
    if (typeof source !== "string" || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(source) || source.length > 254) return false;
    try {
      return new URL(source).origin === source;
    } catch {
      return false;
    }
  }))];
}

function contentSecurityPolicy(nonce: string, preview: PreviewProfile, analytics?: AnalyticsCspPolicy | null): string {
  return [
    "default-src 'none'",
    ["script-src 'self'", `'nonce-${nonce}'`, ...exactHttpsOrigins(analytics?.scriptSrc)].join(" "),
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    ["connect-src 'self'", ...exactHttpsOrigins(analytics?.connectSrc)].join(" "),
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "worker-src 'self'",
    ...(preview ? [] : ["frame-ancestors 'none'"]),
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function applySecurityHeaders(
  res: Response,
  nonce: string,
  options: { https: boolean; preview: PreviewProfile; noStore: boolean },
): void {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce, options.preview));
  if (options.https) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", [
    "camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()",
    "publickey-credentials-create=(self)", "publickey-credentials-get=(self)",
  ].join(", "));
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", options.preview?.resourcePolicy ?? "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (!options.preview) res.setHeader("X-Frame-Options", "DENY");
  if (options.noStore) res.setHeader("Cache-Control", "no-store");
}

/** Rebuild only the original strict CSP with the two validated analytics additions. */
export function setAnalyticsCsp(res: Response, nonce: string, preview: PreviewProfile, policy: AnalyticsCspPolicy): void {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce, preview, policy));
}
