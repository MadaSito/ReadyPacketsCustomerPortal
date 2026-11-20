import type { Router } from "express";
import type { Services } from "../../container.js";
import { DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { requireFullSession } from "../../http/requestState.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { TRANSFER_MAX_BYTES } from "./transferPolicy.js";

export function registerPortableHttpRoutes(router: Router, services: Services): void {
  router.post("/imports", async (req, res) => {
    const principal = requireFullSession(req);
    const budget = await services.rateLimiter.consume("expensive", `s:${principal.sessionId}`);
    if (!budget.allowed) throw new DomainError("RATE_LIMITED", "RATE_LIMITED", "Wait before uploading another package.");
    if (req.get("content-type") !== "application/octet-stream" || req.get("content-encoding") ||
      (req.get("content-length") !== undefined && !/^[1-9]\d{0,9}$/.test(req.get("content-length") ?? "")) ||
      Number(req.get("content-length") ?? 0) > TRANSFER_MAX_BYTES) {
      throw validation("PORTABLE_UPLOAD_FORMAT", "Upload an unencoded transfer package in raw binary format within the size limit.");
    }
    const timeout = setTimeout(() => req.destroy(), 20 * 60 * 1000);
    timeout.unref();
    const idle = () => req.destroy();
    req.setTimeout(120_000, idle);
    try {
      const saved = await services.portable.upload(principal, req);
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ importId: saved.importId, phase: saved.phase });
    } finally {
      clearTimeout(timeout);
      req.removeListener("timeout", idle);
      req.setTimeout(0);
    }
  });

  router.get("/exports/:exportId/download", async (req, res) => {
    const principal = requireFullSession(req);
    const { exportId } = req.params;
    if (typeof exportId !== "string" || !ULID_PATTERN.test(exportId)) throw notFound("PORTABLE_EXPORT_NOT_FOUND");
    const budget = await services.rateLimiter.consume("expensive", `s:${principal.sessionId}`);
    if (!budget.allowed) throw new DomainError("RATE_LIMITED", "RATE_LIMITED", "Wait before downloading another package.");
    const download = await services.portable.openExport(principal, exportId);
    try {
      await sendPrivateDownload(res, {
        stream: download.stream, filename: `readypackets-transfer-${exportId}.rpkg`, size: download.size,
        contentType: "application/octet-stream",
      });
    } catch (error) {
      await download.finish("unknown");
      throw error;
    }
    await download.finish("completed");
  });
}
