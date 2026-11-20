/**
 * Backup module — raw HTTP routes (`/api/backup/*`). Owner: recovery_ops_engineer.
 *
 * Provides streaming download of encrypted `.rpbk` backup archives for independent off-host / offline
 * storage custody. Requires `admin` + `backup.restore` + fresh step-up, re-validated inside a DB transaction
 * and durably audited before streaming.
 */
import type { Router } from "express";
import type { Services } from "../../container.js";
import { validation } from "../../core/errors.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { requireHttpCapability } from "../../http/requestState.js";

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

export function registerBackupHttpRoutes(router: Router, services: Services): void {
  router.get("/archives/:publicId/download", async (req, res, next) => {
    try {
      const principal = requireHttpCapability(req, "backup.restore", services.clock.now());
      const publicId = String(req.params.publicId ?? "");
      if (!PUBLIC_ID_PATTERN.test(publicId)) {
        throw validation("INVALID_BACKUP_ID", "Backup identifier is invalid.");
      }
      const download = await services.backup.openEncryptedArchiveDownload(principal, publicId);
      await sendPrivateDownload(res, {
        stream: download.stream,
        filename: download.filename,
        contentType: "application/octet-stream",
        size: download.size,
      });
    } catch (error) {
      if (!res.headersSent) {
        next(error);
      } else {
        res.destroy();
      }
    }
  });
}
