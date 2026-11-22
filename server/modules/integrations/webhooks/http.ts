/**
 * Raw HTTP router factory for signed inbound webhook endpoints (Package I).
 *
 * Mounted by `http_security_engineer` in `server/http` at `/api/webhooks/inbound`:
 *  - `POST /:endpointPublicId`
 *  - Expects `req.body` as a raw `Buffer` (up to 256 KiB, no content decompression, no session/CSRF/CORS)
 *  - Adds NO body parser or CORS middleware (owned by `server/http`)
 *  - Verifies constant-time HMAC-SHA256 & ±5m timestamp BEFORE parsing JSON
 */
import { Router, type Request, type Response } from "express";
import type { Services } from "../../../container.js";
import { ulid } from "../../../core/ids.js";
import { getRequestContext } from "../../../core/requestContext.js";
import { rateLimitAddress } from "../../../security/rateLimitAddress.js";
import { MAX_INBOUND_RAW_BODY_BYTES } from "./crypto.js";

export function createInboundWebhooksHttpRouter(services: Services): Router {
  const router = Router({ caseSensitive: true, strict: true });

  router.post("/:endpointPublicId", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const reqCtx = getRequestContext();
    const correlationId = reqCtx?.correlationId ?? reqCtx?.requestId ?? ulid();
    res.setHeader("X-Correlation-Id", correlationId);

    try {
      const endpointPublicId = String(req.params.endpointPublicId ?? "");
      const verdict = await services.rateLimiter.consume(
        "api",
        `webhook:inbound:${endpointPublicId.slice(0, 32)}:${rateLimitAddress(req.ip)}`,
      );
      if (!verdict.allowed) {
        res
          .status(429)
          .setHeader("Retry-After", String(verdict.retryAfterSeconds))
          .json({ ok: false, code: "RATE_LIMITED", message: "Too many webhook requests." });
        return;
      }

      if (!Buffer.isBuffer(req.body)) {
        res.status(415).json({
          ok: false,
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Expected application/json raw payload.",
        });
        return;
      }
      if (req.body.byteLength > MAX_INBOUND_RAW_BODY_BYTES) {
        res.status(413).json({
          ok: false,
          code: "PAYLOAD_TOO_LARGE",
          message: "Webhook payload exceeds 256 KiB.",
        });
        return;
      }

      const flatHeaders: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") {
          flatHeaders[k.toLowerCase()] = v;
        } else if (Array.isArray(v) && v.length > 0) {
          flatHeaders[k.toLowerCase()] = v[0];
        }
      }

      const outcome = await services.integrations.webhooks.receiveInboundHttp({
        endpointPublicId,
        rawBody: req.body,
        headers: flatHeaders,
        correlationId,
        ipAddress: req.ip ?? null,
      });

      res.status(outcome.httpStatus).json(outcome.body);
    } catch (error) {
      services.logger.error("inbound webhook handler error", {
        errorName: error instanceof Error ? error.name : "unknown",
        correlationId,
      });
      res.status(500).json({
        ok: false,
        code: "INTERNAL_ERROR",
        message: "The webhook request could not be processed.",
      });
    }
  });

  router.all("/{*splat}", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." });
  });

  return router;
}
