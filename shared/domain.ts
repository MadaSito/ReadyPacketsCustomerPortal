/**
 * Shared domain vocabulary used by both server and client.
 * Module owners may APPEND to their own unions here via minimal edits; never remove another module's values.
 */

export const USER_ROLES = ["admin", "staff", "customer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AUTH_METHODS = ["local", "saml", "entra"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * Account-transition prerequisites, in evaluation order. A session with any pending step is a
 * `remediation` session: it may call ONLY the endpoints that fulfil the next step and can never
 * read customer or administrative data. Derived exclusively by the identity transition service.
 */
export const TRANSITION_STEPS = [
  "verify_email",
  "mfa_challenge",
  "enroll_mfa",
  "acknowledge_recovery_codes",
  "change_password",
  /** Increment 06 D13: a policy with enforcement `required_to_continue` must be accepted (read/accept/sign out only). */
  "accept_policy",
] as const;
export type TransitionStep = (typeof TRANSITION_STEPS)[number];

export const SESSION_STATES = ["full", "remediation"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Money is always integer minor units plus an ISO 4217 currency code. Never floats. */
export interface Money {
  amountMinor: number;
  currency: string;
}

export function formatMoney(money: Money, locale = "en-US"): string {
  const digits = new Intl.NumberFormat(locale, { style: "currency", currency: money.currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency }).format(
    money.amountMinor / 10 ** digits,
  );
}

/** Truthful operation states shown in every list/detail/job UI. `unknown` is never collapsed into failed. */
export const OPERATION_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
  "refused",
  "unknown",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** Password policy constants shared with the client for inline guidance. The server is authoritative. */
export const PASSWORD_POLICY = {
  minLength: 15,
  maxLength: 128,
  /** Length is counted in Unicode code points after NFC normalization; nothing is truncated. */
  counting: "unicode-code-points-nfc",
} as const;

export function countCodePoints(value: string): number {
  let n = 0;
  for (const _ of value.normalize("NFC")) n += 1;
  return n;
}
