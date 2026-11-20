/**
 * Integrations module — raw HTTP routes and signed provider webhooks. Owner: integrations module engineer.
 *
 * `registerSignedIntegrationWebhooks(router, services)` mounts under `/api/integrations/webhooks`
 * BEFORE JSON body parsing, cookie session resolution or browser CSRF:
 *  - Receives up to 256 KiB of raw `Buffer` (`application/json`).
 *  - Verifies cryptographic signature and timestamp replay window before parsing JSON or touching DB.
 *  - Remains inert (`503`) unless the provider is explicitly enabled and configured by an administrator.
 */
import type { Request, Response, Router } from "express";
import type { Services } from "../../container.js";

export function registerIntegrationsHttpRoutes(_router: Router, _services: Services): void {
  // All administrative operations use tRPC (`trpc.integrations.*`) with session + CSRF + step-up.
}

export function registerSignedIntegrationWebhooks(router: Router, services: Services): void {
  router.post("/stripe", async (req: Request, res: Response) => {
    try {
      const verdict = await services.rateLimiter.consume(
        "api",
        `webhook:stripe:${req.ip ?? "unknown"}`,
      );
      if (!verdict.allowed) {
        res
          .status(429)
          .setHeader("Retry-After", String(verdict.retryAfterSeconds))
          .json({ ok: false, reasonCode: "RATE_LIMITED" });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === "string"
          ? Buffer.from(req.body, "utf8")
          : Buffer.alloc(0);

      const sigHeaderRaw = req.headers["stripe-signature"];
      const signatureHeader = typeof sigHeaderRaw === "string" ? sigHeaderRaw : undefined;

      const result = await services.integrations.stripe.handleSignedWebhook({
        rawBody,
        signatureHeader,
      });

      res.status(result.httpStatus).json({
        ok: result.accepted,
        duplicate: result.duplicate,
        reasonCode: result.reasonCode,
      });
    } catch (error) {
      services.logger.error("stripe webhook handler error", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      res.status(500).json({ ok: false, reasonCode: "INTERNAL_ERROR" });
    }
  });
}
