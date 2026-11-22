/**
 * Payments isolated raw HTTP routers (Increment 04, Package K).
 * Owner: compliance_engineer.
 * Mounted by `http_security_engineer` in `server/http`:
 *  - `createPaymentWebhooksHttpRouter` at `/api/payments/webhooks` (POST raw JSON, <= 256 KiB, no cookie auth/CSRF).
 *  - `createPaymentReturnHttpRouter` at `/api/payments/return` (GET only, no body, no cookie auth/CSRF, zero DB writes/reads).
 */
import { Router, type Request, type Response } from "express";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { PaymentsModule } from "./index.js";
import type { ActivePaymentProvider } from "./schema.js";

const MAX_WEBHOOK_RAW_BYTES = 256 * 1024;

function getPaymentsFromServices(services: Services): PaymentsModule | undefined {
  return (services as Services & { payments?: PaymentsModule }).payments;
}

function parseActiveProvider(raw: unknown): ActivePaymentProvider | null {
  if (raw === "stripe" || raw === "square") return raw;
  return null;
}

function headerSingleString(req: Request, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length === 1 && typeof val[0] === "string") return val[0];
  return undefined;
}

export function createPaymentWebhooksHttpRouter(services: Services): Router {
  const router = Router({ caseSensitive: true, strict: true });

  router.post("/:provider", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const provider = parseActiveProvider(req.params.provider);
    if (!provider) {
      res.status(404).json({ ok: false, reasonCode: "UNKNOWN_PAYMENT_PROVIDER" });
      return;
    }

    const payments = getPaymentsFromServices(services);
    if (!payments) {
      res.status(503).json({ ok: false, reasonCode: "PAYMENTS_UNAVAILABLE" });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
      res.status(400).json({ ok: false, reasonCode: "WEBHOOK_EMPTY_BODY" });
      return;
    }
    if (req.body.byteLength > MAX_WEBHOOK_RAW_BYTES) {
      res.status(413).json({ ok: false, reasonCode: "WEBHOOK_PAYLOAD_TOO_LARGE" });
      return;
    }

    const notificationUrl = new URL(
      `/api/payments/webhooks/${provider}`,
      services.config.canonicalOrigin,
    ).href;

    const headers: Record<string, string | undefined> = {
      "content-type": headerSingleString(req, "content-type"),
      "stripe-signature": headerSingleString(req, "stripe-signature"),
      "x-square-hmacsha256-signature": headerSingleString(req, "x-square-hmacsha256-signature"),
      "square-environment": headerSingleString(req, "square-environment"),
    };

    try {
      const out = await payments.handleSignedWebhook({
        provider,
        rawBody: req.body,
        headers,
        notificationUrl,
      });

      res.status(out.httpStatus).json({
        ok: out.accepted,
        duplicate: out.duplicate,
        booked: out.booked,
        reasonCode: out.reasonCode,
      });
    } catch (err) {
      const ctx = getRequestContext();
      const correlationId = ctx?.correlationId ?? ctx?.requestId;
      services.logger.error("Unhandled error in payment webhook receiver", {
        provider,
        reasonCode: err instanceof DomainError ? err.reasonCode : "UNHANDLED_EXCEPTION",
        errorName: err instanceof Error ? err.name : "UnknownError",
        ...(correlationId ? { correlationId } : {}),
        ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      });
      res.status(500).json({ ok: false, reasonCode: "INTERNAL_WEBHOOK_ERROR" });
    }
  });

  router.use((_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ ok: false, reasonCode: "NOT_FOUND" });
  });

  return router;
}

/**
 * Untrusted browser navigation after hosted checkout.
 * Performs ZERO database reads and ZERO database writes (no payment mutation, no attempt-existence oracle)
 * and redirects strictly to one of three hardcoded reviewed same-origin portal paths.
 */
export function createPaymentReturnHttpRouter(_services: Services): Router {
  const router = Router({ caseSensitive: true, strict: true });

  router.get("/:provider/:attemptPublicId", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const provider = parseActiveProvider(req.params.provider);
    const attemptPublicId = typeof req.params.attemptPublicId === "string" ? req.params.attemptPublicId : "";
    if (!provider || attemptPublicId.length !== 26 || !ULID_PATTERN.test(attemptPublicId)) {
      res.status(404).type("text/plain").send("Not Found");
      return;
    }

    const flow = req.query.flow === "checkout" ? "checkout" : "invoices";
    const isCancelled = req.query.outcome === "cancelled";

    let location: string;
    if (flow === "checkout") {
      location = isCancelled
        ? `/checkout/cancel?attempt=${attemptPublicId}`
        : `/checkout/return?attempt=${attemptPublicId}`;
    } else {
      const resultToken = isCancelled ? "cancelled" : "return";
      location = `/invoices?attempt=${attemptPublicId}&result=${resultToken}`;
    }

    res.redirect(303, location);
  });

  router.use((_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).type("text/plain").send("Not Found");
  });

  return router;
}
