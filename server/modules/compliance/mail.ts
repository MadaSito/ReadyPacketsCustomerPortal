/** Compliance mail templates (plain text; mail subsystem derives escaped HTML). */
import type { Mailer, MailTemplate } from "../../core/types.js";
import { PAYMENT_RECEIPT_TEMPLATE } from "../jobs/receiptMail.js";

function registerTemplateIfMissing(mailer: Mailer, template: MailTemplate): void {
  const existingMap = (mailer as { templates?: unknown }).templates;
  if (existingMap instanceof Map && existingMap.has(template.key)) {
    return;
  }
  try {
    mailer.registerTemplate(template);
  } catch (err) {
    if (err instanceof Error && /DUPLICATE_MAIL_TEMPLATE|duplicate mail template/iu.test(err.message)) {
      return;
    }
    throw err;
  }
}

export function registerComplianceMailTemplates(mailer: Mailer): void {
  registerTemplateIfMissing(mailer, {
    key: PAYMENT_RECEIPT_TEMPLATE,
    vars: ["receiptNumber", "orderReference", "projectName"],
    sensitiveVars: ["receiptNumber"],
    subject: () => "Your ReadyPackets payment receipt",
    text: ({ receiptNumber, orderReference, projectName }) => {
      const orderRef = typeof orderReference === "string" ? orderReference.trim() : "";
      const project = typeof projectName === "string" ? projectName.trim() : "";
      return [
        ...(orderRef ? [`Order: ${orderRef}`] : []),
        ...(project ? [`Project: ${project}`] : []),
        ...(orderRef || project ? [""] : []),
        `Thank you for your payment. Your ReadyPackets payment receipt number is ${String(receiptNumber)}.`,
      ].join("\n");
    },
  });
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
    vars: ["invoiceNumber", "orderReference", "projectName", "portalPath"],
    subject: (vars) => `Invoice ${String(vars.invoiceNumber)} issued for order ${String(vars.orderReference)}`,
    text: (vars) => {
      const project = typeof vars.projectName === "string" ? vars.projectName.trim() : "";
      return [
        `Order: ${String(vars.orderReference)}`,
        ...(project ? [`Project: ${project}`] : []),
        "",
        `Invoice ${String(vars.invoiceNumber)} has been issued for your ReadyPackets order ${String(vars.orderReference)}.`,
        "",
        `Sign in to view or download your invoice PDF: ${String(vars.portalPath)}`,
        "",
        "You are receiving this message because you own this order.",
      ].join("\n");
    },
  });

  mailer.registerTemplate({
    key: "compliance.invoice_paid",
    vars: ["invoiceNumber", "orderReference", "projectName", "portalPath"],
    subject: (vars) => `Payment recorded for invoice ${String(vars.invoiceNumber)}`,
    text: (vars) => {
      const project = typeof vars.projectName === "string" ? vars.projectName.trim() : "";
      return [
        `Order: ${String(vars.orderReference)}`,
        ...(project ? [`Project: ${project}`] : []),
        "",
        `Payment has been recorded in full for invoice ${String(vars.invoiceNumber)} (order ${String(vars.orderReference)}).`,
        "",
        `Sign in to download your updated receipt/invoice PDF: ${String(vars.portalPath)}`,
      ].join("\n");
    },
  });
}
