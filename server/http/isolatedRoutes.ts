import express, { type RequestHandler, type Router } from "express";
import type { Services } from "../container.js";
import { notFound, validation } from "../core/errors.js";

export type IsolatedRouterFactory = (services: Services) => Router;
export type IsolatedRouterSlot = "publicApi" | "inboundWebhooks" | "paymentWebhooks" | "paymentReturn";
export type IsolatedRouterFactories = Partial<Record<IsolatedRouterSlot, IsolatedRouterFactory>>;

const slots = [
  { key: "publicApi", prefix: "/api/v1", methods: new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]), body: "optional" },
  { key: "inboundWebhooks", prefix: "/api/webhooks/inbound", methods: new Set(["POST"]), body: "required" },
  { key: "paymentWebhooks", prefix: "/api/payments/webhooks", methods: new Set(["POST"]), body: "required" },
  { key: "paymentReturn", prefix: "/api/payments/return", methods: new Set(["GET"]), body: "none" },
] as const;

export function isolatedRoutePrefix(path: string): string | undefined {
  const lower = path.toLowerCase();
  return slots.find(({ prefix }) => lower === prefix || lower.startsWith(`${prefix}/`))?.prefix;
}

const MAX_RAW_BYTES = 256 * 1024;
const raw = express.raw({ type: "application/json", inflate: false, limit: MAX_RAW_BYTES });

export function createIsolatedHttpRouter(
  services: Services,
  factories: IsolatedRouterFactories,
  budget: RequestHandler,
): Router {
  const root = express.Router({ caseSensitive: true, strict: true });
  for (const { key, prefix, methods, body } of slots) {
    root.use(
      prefix,
      (req, _res, next) => {
        if (!methods.has(req.method)) throw notFound();
        next();
      },
      budget,
      (req, _res, next) => {
        const length = req.headers["content-length"];
        const framed = req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
        if (body === "none" && framed) {
          throw validation("UNEXPECTED_REQUEST_BODY", "This endpoint does not accept a request body.");
        }
        if ((body === "required" || framed) && !req.is("application/json")) {
          throw validation("UNSUPPORTED_CONTENT_TYPE", "This endpoint accepts a JSON request body.");
        }
        next();
      },
      ...(body === "none" ? [] : [raw]),
      (req, _res, next) => {
        if (body === "required" && (!Buffer.isBuffer(req.body) || req.body.length === 0)) {
          throw validation("EMPTY_WEBHOOK_BODY", "A webhook request body is required.");
        }
        next();
      },
      factories[key]?.(services) ?? express.Router(),
      () => { throw notFound(); },
    );
  }
  // The slots are reserved case-insensitively, but matching and dispatch remain strict.
  root.use((req, _res, next) => {
    if (isolatedRoutePrefix(req.path)) throw notFound();
    next();
  });
  return root;
}
