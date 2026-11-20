/** Compliance mail templates (plain text; mail subsystem derives escaped HTML). */
import type { Mailer } from "../../core/types.js";

export function registerComplianceMailTemplates(mailer: Mailer): void {
  mailer.registerTemplate({
    key: "compliance.intake_returned",
    vars: ["orderReference", "questionnaireTitle", "portalPath"],
    subject: (vars) => `Action needed: ${String(vars.questionnaireTitle)} for order ${String(vars.orderReference)}`,
    text: (vars) =>
      [
        `Your intake submission "${String(vars.questionnaireTitle)}" for order ${String(vars.orderReference)} was returned for updates.`,
        "",
        `Sign in to review staff feedback and submit an updated response: ${String(vars.portalPath)}`,
        "",
        "You are receiving this message because you own or manage this order.",
      ].join("\n"),
  });

  mailer.registerTemplate({
    key: "compliance.invoice_issued",
    vars: ["invoiceNumber", "orderReference", "portalPath"],
    subject: (vars) => `Invoice ${String(vars.invoiceNumber)} issued for order ${String(vars.orderReference)}`,
    text: (vars) =>
      [
        `Invoice ${String(vars.invoiceNumber)} has been issued for your ReadyPackets order ${String(vars.orderReference)}.`,
        "",
        `Sign in to view or download your invoice PDF: ${String(vars.portalPath)}`,
        "",
        "You are receiving this message because you own this order.",
      ].join("\n"),
  });

  mailer.registerTemplate({
    key: "compliance.invoice_paid",
    vars: ["invoiceNumber", "orderReference", "portalPath"],
    subject: (vars) => `Payment recorded for invoice ${String(vars.invoiceNumber)}`,
    text: (vars) =>
      [
        `Payment has been recorded in full for invoice ${String(vars.invoiceNumber)} (order ${String(vars.orderReference)}).`,
        "",
        `Sign in to download your updated receipt/invoice PDF: ${String(vars.portalPath)}`,
      ].join("\n"),
  });
}
