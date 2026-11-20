/** Orders mail templates (plain text; the mail module derives escaped HTML). No free-form content. */
import type { Mailer } from "../../core/types.js";

export function registerOrderMailTemplates(mailer: Mailer): void {
  mailer.registerTemplate({
    key: "orders.status_changed",
    vars: ["reference", "statusLabel", "link"],
    subject: (vars) => `Order ${String(vars.reference)}: ${String(vars.statusLabel)}`,
    text: (vars) =>
      [
        `The status of your ReadyPackets order ${String(vars.reference)} is now "${String(vars.statusLabel)}".`,
        "",
        `Sign in to view the details: ${String(vars.link)}`,
        "",
        "You are receiving this message because you own or have access to this order.",
      ].join("\n"),
  });
  mailer.registerTemplate({
    key: "orders.share_invited",
    vars: ["reference", "link"],
    subject: (vars) => `You have been invited to order ${String(vars.reference)}`,
    text: (vars) =>
      [
        `A ReadyPackets customer has shared order ${String(vars.reference)} with you.`,
        "",
        `Sign in with this e-mail address to accept or decline: ${String(vars.link)}`,
        "",
        "If you were not expecting this invitation you can ignore this message.",
      ].join("\n"),
  });
}
