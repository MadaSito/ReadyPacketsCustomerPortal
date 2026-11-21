import type { Mailer, MailTemplate } from "../../core/types.js";

export const REFERRALS_INVITE_TEMPLATE_KEY = "referrals.invite_friend" as const;

export const REFERRALS_INVITE_MAIL_TEMPLATE: MailTemplate = {
  key: REFERRALS_INVITE_TEMPLATE_KEY,
  vars: ["senderName", "referralCode", "referralLink"],
  subject: (vars) => `${String(vars.senderName)} invited you to ReadyPackets`,
  text: (vars) =>
    [
      `Hello,`,
      ``,
      `${String(vars.senderName)} shared their ReadyPackets referral link with you.`,
      ``,
      `Create your account using this link:`,
      `${String(vars.referralLink)}`,
      ``,
      `Referral code: ${String(vars.referralCode)}`,
      ``,
      `If you were not expecting this invitation, you can safely ignore this message. ReadyPackets will never ask for your password by e-mail.`,
    ].join("\n"),
};

export function registerReferralsMailTemplates(mailer: Mailer): void {
  mailer.registerTemplate(REFERRALS_INVITE_MAIL_TEMPLATE);
}
