/**
 * POST /api/files/archives/download — redeems a single-use archive ticket and streams the ZIP. Mounted inside
 * the existing /api/files router (same CSRF, Origin and rate rules as /api/files/download).
 */
import type { Router } from "express";
import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { getHttpState, requireFullSession } from "../../http/requestState.js";
import type { FileArchivesModule } from "./archives.js";

const body = z.strictObject({ ticket: z.string().length(43).regex(/^[a-zA-Z0-9_-]{43}$/) });

export function registerFileArchiveHttpRoutes(router: Router, services: Services): void {
  const archives = (): FileArchivesModule => {
    const module = (services as Services & { fileArchives?: FileArchivesModule }).fileArchives;
    if (!module) throw new DomainError("UNAVAILABLE", "ARCHIVES_UNAVAILABLE", "File archives are not available right now.");
    return module;
  };
  router.post("/archives/download", async (req, res) => {
    let principal;
    try {
      principal = requireFullSession(req);
    } catch (error) {
      if (error instanceof DomainError) await archives().recordDenied(getHttpState(req).session ?? null, error.reasonCode);
      throw error;
    }
    const form = typeof req.is("application/x-www-form-urlencoded") === "string";
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      await archives().recordDenied(principal, "DOWNLOAD_TICKET_INVALID");
      if (form) { res.status(204).end(); return; }
      throw validation("DOWNLOAD_TICKET_INVALID", "The download request is invalid.");
    }
    // Native form POST (the browser streams to disk): a refusal must not replace the app page, so answer 204
    // (the browser stays put) and let the client read the archive state. The refusal is still audited.
    let download;
    try {
      download = await archives().redeemDownloadTicket(principal, parsed.data.ticket);
    } catch (error) {
      if (form && error instanceof DomainError && !res.headersSent) {
        res.status(204).end();
        return;
      }
      throw error;
    }
    let outcome: "completed" | "failed" | "unknown" = "unknown";
    try {
      await sendPrivateDownload(res, { stream: download.stream, filename: download.filename, contentType: "application/zip", size: download.size });
      if (res.writableFinished) outcome = "completed";
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        outcome = "failed";
        throw error;
      }
      res.destroy();
    } finally {
      download.stream.destroy();
      await archives().recordDownloadResult(principal, download.archiveId, outcome).catch(() => services.logger.error("Archive download outcome could not be recorded"));
    }
  });
}
