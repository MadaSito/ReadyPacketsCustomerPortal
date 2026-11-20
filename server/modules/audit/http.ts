/**
 * Audit module — raw HTTP routes, mounted at /api/audit after session resolution and CSRF/origin checks.
 * Owner: audit engineer. Only the private export download lives here.
 */
import type { Router } from "express";
import type { Services } from "../../container.js";
import { notFound } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { requireHttpCapability } from "../../http/requestState.js";

export function registerAuditHttpRoutes(router: Router, services: Services): void {
  router.get("/exports/:exportId/download", async (req, res) => {
    const principal = requireHttpCapability(req, "audit.export", services.clock.now());
    const exportId = String(req.params.exportId ?? "");
    if (!ULID_PATTERN.test(exportId)) throw notFound("AUDIT_EXPORT_NOT_FOUND");
    // openExportDownload re-checks capability + requester scope and writes the durable "downloaded" audit row first.
    const file = await services.auditCenter.openExportDownload(principal, exportId);
    try {
      await sendPrivateDownload(res, file);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) throw error;
      res.destroy();
    } finally {
      file.stream.destroy();
    }
  });
}
