import type { Request, Router } from "express";
import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { getRequestContext } from "../../core/requestContext.js";
import { isFlagEnabled } from "../platform/index.js";
import { normalizeReferralCode } from "./codes.js";
import { REFERRALS_ENABLED_FLAG } from "./settings.js";

export const REFERRAL_HOLD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function referralCookieName(cookieSecure: boolean): string {
  return cookieSecure ? "__Host-rp_ref" : "rp_ref";
}

function readSingleCookie(req: Request, name: string): string | undefined {
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

const holdBodySchema = z.strictObject({
  code: z.string().min(1).max(32),
});

/**
 * Browser-facing routes mounted at `/api/referrals` (under `createModuleHttpRouter` after
 * origin, CSRF, and edge rate-limiting).
 *
 * Stores ONLY the visitor-supplied 10-character referral code in a first-party `HttpOnly; SameSite=Lax`
 * functional cookie for 30 days (`Decision 8`) when the visitor explicitly follows `/register?ref=CODE`.
 * Never queries `referral_codes` (zero enumeration oracle) and stores zero tracking identifiers.
 */
export function registerReferralsHttpRoutes(router: Router, services: Services): void {
  const cookieName = referralCookieName(services.config.cookieSecure);
  const baseCookieOptions = {
    path: "/",
    httpOnly: true,
    secure: services.config.cookieSecure,
    sameSite: "lax" as const,
  };

  router.get("/hold", async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const enabled = await isFlagEnabled(services.settings, REFERRALS_ENABLED_FLAG);
      if (!enabled) {
        res.status(200).json({ code: null });
        return;
      }
      const raw = readSingleCookie(req, cookieName);
      const normalized = raw ? normalizeReferralCode(raw) : null;
      res.status(200).json({ code: normalized });
    } catch (err) {
      next(err);
    }
  });

  router.post("/hold", async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const reqCtx = getRequestContext();
      const ipSubject = reqCtx?.ipAddress
        ? services.crypto.blindIndex(reqCtx.ipAddress, "referrals.hold_ip")
        : "unknown";
      const verdict = await services.rateLimiter.consume(
        "form_submission",
        `referrals.hold:${ipSubject}`,
      );
      if (!verdict.allowed) {
        throw new DomainError(
          "RATE_LIMITED",
          "RATE_LIMITED",
          "Too many requests. Please wait a moment and try again.",
          { retryAfterSeconds: verdict.retryAfterSeconds },
        );
      }

      const parsed = holdBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validation("INVALID_REFERRAL_CODE", "Referral code format is invalid.");
      }

      const enabled = await isFlagEnabled(services.settings, REFERRALS_ENABLED_FLAG);
      const normalized = normalizeReferralCode(parsed.data.code);
      if (!enabled || !normalized) {
        res.status(200).json({ held: false, expiresAt: null });
        return;
      }

      const expiresAt = new Date(services.clock.now().getTime() + REFERRAL_HOLD_MAX_AGE_MS);
      res.cookie(cookieName, normalized, {
        ...baseCookieOptions,
        maxAge: REFERRAL_HOLD_MAX_AGE_MS,
        expires: expiresAt,
      });
      res.status(200).json({ held: true, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/hold", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.clearCookie(cookieName, baseCookieOptions);
    res.status(200).json({ cleared: true });
  });
}
