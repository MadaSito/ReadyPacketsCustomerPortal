/** Identity mail templates (plain text; the mail module derives escaped HTML). Links are sensitive vars. */
import type { MailTemplate } from "../../core/types.js";

const footer = "\n\nIf you did not expect this message, you can ignore it. ReadyPackets will never ask for your password by e-mail.";
const str = (value: string | number | boolean | undefined) => String(value ?? "");

export const IDENTITY_MAIL_TEMPLATES: readonly MailTemplate[] = [
  {
    key: "auth.verify_email",
    vars: ["name", "link"],
    sensitiveVars: ["link"],
    subject: () => "Confirm your ReadyPackets e-mail address",
    text: (v) => `Hello ${str(v.name)},\n\nConfirm your e-mail address to finish setting up your ReadyPackets account:\n\n${str(v.link)}\n\nThis link works once and expires in 24 hours.${footer}`,
  },
  {
    key: "auth.account_exists",
    vars: ["signInLink", "resetLink"],
    subject: () => "Someone tried to create a ReadyPackets account with your e-mail",
    text: (v) => `An account already exists for this e-mail address. Sign in here:\n\n${str(v.signInLink)}\n\nForgot your password? Reset it here:\n\n${str(v.resetLink)}${footer}`,
  },
  {
    key: "auth.password_reset",
    vars: ["link"],
    sensitiveVars: ["link"],
    subject: () => "Reset your ReadyPackets password",
    text: (v) => `Use this link to choose a new password:\n\n${str(v.link)}\n\nThis link works once and expires in 30 minutes. All signed-in sessions will be signed out.${footer}`,
  },
  {
    key: "auth.invitation",
    vars: ["name", "link"],
    sensitiveVars: ["link"],
    subject: () => "You have been invited to ReadyPackets",
    text: (v) => `Hello ${str(v.name)},\n\nAn account has been created for you on the ReadyPackets portal. Activate it and choose your password here:\n\n${str(v.link)}\n\nThis link works once and expires in 72 hours. You will set up two-step verification after activation.${footer}`,
  },
  {
    key: "auth.admin_set_password",
    vars: ["link"],
    sensitiveVars: ["link"],
    subject: () => "Set a new ReadyPackets password",
    text: (v) => `An administrator has reset your password. Choose a new password here:\n\n${str(v.link)}\n\nThis link works once and expires in 24 hours. Your previous password no longer works.${footer}`,
  },
  {
    key: "auth.password_changed",
    vars: [],
    subject: () => "Your ReadyPackets password was changed",
    text: () => `The password for your ReadyPackets account was just changed and other sessions were signed out. If this was not you, reset your password immediately and contact support.${footer}`,
  },
];
