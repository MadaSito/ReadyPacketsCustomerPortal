/**
 * The only opt-out from strict edge controls. The opaque sandbox has no cookie
 * credentials and its dynamically allocated origin cannot be configured in advance.
 * Never deploy this profile on the production portal.
 */
import type { Request, Response } from "express";
import type { AppConfig } from "../config/env.js";
import type { SessionCredentials, SessionTransport } from "../core/types.js";
import {
  HEADER_CSRF,
  HEADER_PREVIEW_CSRF_SET,
  HEADER_PREVIEW_SESSION,
  HEADER_PREVIEW_SESSION_SET,
} from "../../shared/sessionTransportHeaders.js";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const HEADERS = ["accept", "content-type", "trpc-accept", HEADER_CSRF, HEADER_PREVIEW_SESSION];

export function previewProfile(config: AppConfig) {
  if (config.deploymentProfile !== "preview") return null;

  return {
    frameAncestors: null,
    resourcePolicy: "cross-origin",
    avoidsCanonicalHost: true,
    usesExplicitCredentials: true,
    applyHeaders(res: Response) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", [
        HEADER_PREVIEW_SESSION_SET, HEADER_PREVIEW_CSRF_SET, "X-Request-Id", "Retry-After",
        "Content-Disposition",
      ].join(", "));
    },
    handlePreflight(req: Request, res: Response): boolean {
      if (req.method !== "OPTIONS" || !req.get("Access-Control-Request-Method")) return false;
      const method = req.get("Access-Control-Request-Method");
      const headers = req.get("Access-Control-Request-Headers")?.split(",").map((v) => v.trim().toLowerCase()) ?? [];
      if (!method || !METHODS.includes(method) || headers.some((header) => !HEADERS.includes(header))) {
        res.status(403).end();
        return true;
      }
      res.setHeader("Access-Control-Allow-Methods", METHODS.join(", "));
      res.setHeader("Access-Control-Allow-Headers", HEADERS.join(", "));
      res.status(204).end();
      return true;
    },
    credentials(req: Request): SessionCredentials {
      return { token: req.get(HEADER_PREVIEW_SESSION), transport: "preview-header" };
    },
    setCsrf(res: Response, token: string) {
      res.setHeader(HEADER_PREVIEW_CSRF_SET, token);
    },
    transport(res: Response): SessionTransport {
      return {
        issue({ token, csrfToken }) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader(HEADER_PREVIEW_SESSION_SET, token);
          res.setHeader(HEADER_PREVIEW_CSRF_SET, csrfToken);
        },
        clear() {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader(HEADER_PREVIEW_SESSION_SET, "");
          res.setHeader(HEADER_PREVIEW_CSRF_SET, "");
        },
      };
    },
  } as const;
}

export type PreviewProfile = ReturnType<typeof previewProfile>;
