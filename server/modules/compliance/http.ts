/**
 * Compliance raw HTTP routes — mounted at `/api/compliance`.
 *
 * Exposes `GET /invoices/:invoiceId/pdf`:
 *   - Requires a full authenticated session (`requireFullSession`).
 *   - Enforces order read scope + draft visibility + live actor check and records durable
 *     `invoice.downloaded` audit BEFORE streaming bytes.
 *   - Streams via `sendPrivateDownload` (`Content-Disposition: attachment`, `nosniff`, `Cache-Control: no-store`,
 *     sandbox CSP).
 */
import { Readable } from "node:stream";
import type { Router } from "express";
import type { Services } from "../../container.js";
import { notFound } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { requireFullSession } from "../../http/requestState.js";

export function registerComplianceHttpRoutes(router: Router, services: Services): void {
  router.get("/invoices/:invoiceId/pdf", async (req, res) => {
    const principal = requireFullSession(req);
    const invoiceId = req.params.invoiceId;
    if (!invoiceId || invoiceId.length !== 26 || !ULID_PATTERN.test(invoiceId)) {
      throw notFound("INVOICE_NOT_FOUND");
    }

    const pdf = await services.compliance.invoices.downloadPdf(principal, invoiceId);
    await sendPrivateDownload(res, {
      stream: Readable.from(pdf.buffer),
      filename: pdf.filename,
      contentType: pdf.contentType,
      size: pdf.buffer.byteLength,
    });
  });
}
