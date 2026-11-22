/** Plain-language labels for sessions and the sign-in log (identity, increment 04). */
import type { Tone } from "@/ui";

export const AUTH_METHOD_LABELS: Record<string, string> = { local: "Password", saml: "SAML single sign-on", entra: "Microsoft single sign-on" };
export const authMethodLabel = (method: string | null | undefined) => (method ? AUTH_METHOD_LABELS[method] ?? "Other" : "—");

export const SIGN_IN_KINDS = ["success", "failure", "lock", "sign_out", "forced_end", "expiry", "refused"] as const;
export type SignInKind = (typeof SIGN_IN_KINDS)[number];

export const SIGN_IN_KIND_META: Record<SignInKind, { label: string; tone: Tone }> = {
  success: { label: "Signed in", tone: "success" },
  failure: { label: "Failed sign-in", tone: "warning" },
  lock: { label: "Account locked", tone: "danger" },
  sign_out: { label: "Signed out", tone: "neutral" },
  forced_end: { label: "Session ended", tone: "info" },
  expiry: { label: "Session expired", tone: "neutral" },
  refused: { label: "Sign-in refused", tone: "danger" },
};
export const signInKindMeta = (kind: string) =>
  Object.hasOwn(SIGN_IN_KIND_META, kind) ? SIGN_IN_KIND_META[kind as SignInKind] : { label: "Other", tone: "neutral" as const };
export const SIGN_IN_KIND_OPTIONS = SIGN_IN_KINDS.map((value) => ({ value, label: SIGN_IN_KIND_META[value].label }));

/** Reason codes administrators choose when ending sessions (server validates the shape). */
export const END_REASONS = [
  { value: "SECURITY_REVIEW", label: "Security review" },
  { value: "SUSPECTED_COMPROMISE", label: "Suspected compromise" },
  { value: "USER_REQUEST", label: "User request" },
  { value: "POLICY_CHANGE", label: "Policy change" },
] as const;

export const ROLE_OPTIONS = [
  { value: "customer", label: "Customer" },
  { value: "staff", label: "Staff" },
  { value: "admin", label: "Administrator" },
];
export const AUTH_METHOD_OPTIONS = Object.entries(AUTH_METHOD_LABELS).map(([value, label]) => ({ value, label }));

/** Location summary: country code only (we never geolocate further). */
export const placeLabel = (country: string | null | undefined, ip: string | null | undefined) =>
  [country ?? null, ip ?? null].filter(Boolean).join(" · ") || "Unknown location";
