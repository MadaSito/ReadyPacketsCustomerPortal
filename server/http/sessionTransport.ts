import type { Request, Response } from "express";
import type { AppConfig } from "../config/env.js";
import type { SessionCredentials, SessionTransport } from "../core/types.js";

/** Read one known cookie; ambiguous or malformed instances fail closed. */
export function readCookie(req: Request, name: string): string | undefined {
  let found: string | undefined;
  for (const entry of req.get("Cookie")?.split(";") ?? []) {
    const pos = entry.indexOf("=");
    if (pos < 0 || entry.slice(0, pos).trim() !== name) continue;
    if (found !== undefined) return undefined;
    try {
      found = decodeURIComponent(entry.slice(pos + 1).trim());
    } catch {
      return undefined;
    }
  }
  return found;
}

function cookieOptions(config: AppConfig) {
  return { path: "/", secure: config.cookieSecure, sameSite: "strict" as const };
}

export function cookieCredentials(req: Request, config: AppConfig): SessionCredentials {
  return { token: readCookie(req, config.sessionCookieName), transport: "cookie" };
}

export function setCsrfCookie(res: Response, config: AppConfig, token: string, expires?: Date): void {
  res.cookie(config.csrfCookieName, token, { ...cookieOptions(config), httpOnly: false, expires });
}

export function cookieTransport(res: Response, config: AppConfig): SessionTransport {
  const options = cookieOptions(config);
  return {
    issue({ token, csrfToken, absoluteExpiresAt }) {
      res.setHeader("Cache-Control", "no-store");
      res.cookie(config.sessionCookieName, token, { ...options, httpOnly: true, expires: absoluteExpiresAt });
      setCsrfCookie(res, config, csrfToken, absoluteExpiresAt);
    },
    clear() {
      res.setHeader("Cache-Control", "no-store");
      res.clearCookie(config.sessionCookieName, { ...options, httpOnly: true });
      res.clearCookie(config.csrfCookieName, { ...options, httpOnly: false });
    },
  };
}
