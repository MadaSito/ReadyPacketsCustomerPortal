import type { Mailer } from "../../core/types.js";

export const MAIL_ORDER_MESSAGE_RECEIVED = "engagement.order_message_received";
export const MAIL_TICKET_UPDATED = "engagement.ticket_updated";
export const MAIL_GENERIC_NOTIFICATION = "engagement.notification";

/**
 * Registers engagement mail templates.
 * Security invariant: templates NEVER accept or render message bodies, ticket subjects,
 * ticket replies, customer names, or secrets — only safe reference identifiers and portal links.
 */
export function registerEngagementMailTemplates(mailer: Mailer): void {
  mailer.registerTemplate({
    key: MAIL_ORDER_MESSAGE_RECEIVED,
    vars: ["orderReference", "link"],
    subject(vars) {
      return `You have a new message on order ${String(vars.orderReference)}`;
    },
    text(vars) {
      return [
        `You have a new message regarding ReadyPackets order ${String(vars.orderReference)}.`,
        "",
        "For your privacy and security, message content is never included in e-mail notifications.",
        `Sign in to your portal to read and reply: ${String(vars.link)}`,
      ].join("\n");
    },
  });

  mailer.registerTemplate({
    key: MAIL_TICKET_UPDATED,
    vars: ["ticketNumber", "eventLabel", "link"],
    subject(vars) {
      return `Support ticket ${String(vars.ticketNumber)}: ${String(vars.eventLabel)}`;
    },
    text(vars) {
      return [
        `There is a new update (${String(vars.eventLabel)}) on ReadyPackets support ticket ${String(vars.ticketNumber)}.`,
        "",
        "For your privacy and security, ticket content is never included in e-mail notifications.",
        `Sign in to your portal to view the update: ${String(vars.link)}`,
      ].join("\n");
    },
  });

  mailer.registerTemplate({
    key: MAIL_GENERIC_NOTIFICATION,
    vars: ["title", "link"],
    subject(vars) {
      return `ReadyPackets notification: ${String(vars.title)}`;
    },
    text(vars) {
      return [
        String(vars.title),
        "",
        `Sign in to your ReadyPackets portal for details: ${String(vars.link)}`,
      ].join("\n");
    },
  });
}

export function buildCanonicalPortalUrl(canonicalOrigin: string, relativePath: string): string {
  const safePath = relativePath.startsWith("/") && !relativePath.startsWith("//") ? relativePath : "/";
  const base = canonicalOrigin.endsWith("/") ? canonicalOrigin.slice(0, -1) : canonicalOrigin;
  return `${base}${safePath}`;
}
