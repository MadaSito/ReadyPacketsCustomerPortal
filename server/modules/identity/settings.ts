/** Identity settings declarations (platform settings registry). */
import { z } from "zod";
import { defineSetting } from "../platform/settingsRegistry.js";

export const SESSION_IDLE_MINUTES = defineSetting({
  key: "identity.session.idle_minutes",
  owner: "identity",
  group: "identity",
  label: "Session idle timeout (minutes)",
  description: "A session with no activity for this long is signed out. Applies to existing sessions immediately.",
  schema: z.number().int().min(5).max(240),
  default: 30,
  sensitivity: "internal",
});

export const SESSION_ABSOLUTE_HOURS = defineSetting({
  key: "identity.session.absolute_hours",
  owner: "identity",
  group: "identity",
  label: "Session absolute lifetime (hours)",
  description: "Maximum session lifetime regardless of activity. Applies to existing sessions immediately.",
  schema: z.number().int().min(1).max(72),
  default: 12,
  sensitivity: "internal",
});

export const REGISTRATION_ENABLED = defineSetting({
  key: "identity.registration.enabled",
  owner: "identity",
  group: "identity",
  label: "Public registration",
  description: "Allow visitors to create a customer account from the sign-in page.",
  schema: z.boolean(),
  default: true,
  sensitivity: "public",
});

/** Single-use link lifetimes (fixed policy, not settings). */
export const TOKEN_TTL_MS = {
  verify_email: 24 * 60 * 60 * 1000,
  password_reset: 30 * 60 * 1000,
  invitation: 72 * 60 * 60 * 1000,
  admin_set_password: 24 * 60 * 60 * 1000,
} as const;

/** Minimum gap between two verification / reset e-mails for the same account. */
export const RESEND_MIN_INTERVAL_MS = 60 * 1000;
