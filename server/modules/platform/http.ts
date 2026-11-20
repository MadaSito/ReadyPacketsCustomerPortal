/**
 * Platform module — raw HTTP routes (mounted under /api/platform AFTER session resolution, CSRF/origin
 * enforcement and rate limits). Owner: platform module engineer.
 *
 *   POST /presentation/images        admin + fresh step-up; raw body image/png|image/jpeg|image/webp ≤ 2 MiB
 *   GET  /presentation/images/:id    public (sign-in page); served with nosniff + `default-src 'none'`
 */
import type { Request, Response, Router } from "express";
import { pipeline } from "node:stream/promises";
import type { Services } from "../../container.js";
import { DomainError, notFound, validation } from "../../core/errors.js";
import { requireHttpCapability } from "../../http/requestState.js";
import { MAX_IMAGE_BYTES } from "./imageValidation.js";
import type { PlatformModuleImpl } from "./module.js";

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function impl(services: Services): PlatformModuleImpl {
  const platform = services.platform as Partial<PlatformModuleImpl>;
  if (!platform.presentationService) throw new DomainError("NOT_CONFIGURED", "PLATFORM_UNAVAILABLE", "This feature is not available.");
  return platform as PlatformModuleImpl;
}

/** Reads the raw body with a hard byte limit (aborts early; never buffers more than limit + one chunk). */
export async function readBoundedBody(req: Request, limit: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d{1,10}$/.test(declared) || Number(declared) > limit)) {
    throw validation("IMAGE_TOO_LARGE", "Images must be 2 MB or smaller.");
  }
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
    throw validation("UNSUPPORTED_ENCODING", "Compressed uploads are not accepted.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += piece.length;
    if (total > limit) throw validation("IMAGE_TOO_LARGE", "Images must be 2 MB or smaller.");
    chunks.push(piece);
  }
  return Buffer.concat(chunks, total);
}

export function registerPlatformHttpRoutes(router: Router, services: Services): void {
  router.post("/presentation/images", async (req: Request, res: Response) => {
    const session = requireHttpCapability(req, "platform.settings.manage", services.clock.now());
    if (session.role !== "admin") throw new DomainError("FORBIDDEN", "ROLE_NOT_PERMITTED", "You do not have permission to perform this action.");
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ACCEPTED_TYPES.has(type)) throw validation("IMAGE_UNSUPPORTED_TYPE", "Please upload a PNG, JPEG or WebP image.");
    const body = await readBoundedBody(req, MAX_IMAGE_BYTES);
    const platform = impl(services);
    const image = await platform.presentationService.uploadImage(body, platform.actorGuard(session));
    res.status(201).setHeader("Cache-Control", "no-store").json(image);
  });

  router.get("/presentation/images/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw notFound();
    const image = await impl(services).presentationService.openImage(id);
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Content-Length", String(image.size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("ETag", `"${image.sha256}"`);
    await pipeline(image.stream, res);
  });
}
