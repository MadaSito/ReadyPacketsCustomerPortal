/**
 * Express adapter for /api/v1 (mounted by the integrator with a raw JSON body parser ≤ 256 KiB, no session,
 * no CSRF, no CORS). All decisions live in the engine; this file only translates request and response.
 */
import { Router } from "express";
import type { Services } from "../../container.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { PublicApiModule } from "./index.js";

export function createPublicApiHttpRouter(services: Services): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.all(/.*/u, async (req, res, next) => {
    try {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      const api = (services as Services & { publicApi: PublicApiModule }).publicApi;
      const response = await api.handle({
        method: req.method.toUpperCase(),
        target: req.url,
        headers,
        body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        ipAddress: getRequestContext()?.ipAddress,
      });
      res.status(response.status);
      for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
      res.send(req.method === "HEAD" ? undefined : response.body);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
