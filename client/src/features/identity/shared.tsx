/** Identity UI helpers shared by the account and console pages. */
import { Link } from "wouter";
import { Badge, Callout, type Tone } from "@/ui";

export type UserStatus = "active" | "pending_activation" | "suspended" | "deactivated";

const STATUS_META: Record<UserStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  pending_activation: { label: "Invitation pending", tone: "info" },
  suspended: { label: "Suspended", tone: "warning" },
  deactivated: { label: "Deactivated", tone: "neutral" },
};

export function UserStatusBadge({ status }: { status: UserStatus | string }) {
  const meta = Object.hasOwn(STATUS_META, status) ? STATUS_META[status as UserStatus] : { tone: "neutral" as const, label: "Unknown" };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export const STATUS_FILTER_OPTIONS = (Object.keys(STATUS_META) as UserStatus[]).map((value) => ({ value, label: STATUS_META[value].label }));

export const ROLE_LABELS: Record<"customer" | "staff" | "admin", string> = { customer: "Customer", staff: "Staff", admin: "Administrator" };

/** Reason codes offered for status transitions (server validates the shape; these are the catalogued values). */
export const STATUS_REASONS: Record<"suspended" | "deactivated" | "active", { value: string; label: string }[]> = {
  suspended: [
    { value: "SECURITY_REVIEW", label: "Security review" },
    { value: "POLICY_VIOLATION", label: "Policy violation" },
    { value: "CUSTOMER_REQUEST", label: "Customer request" },
    { value: "BILLING_HOLD", label: "Billing hold" },
  ],
  deactivated: [
    { value: "ACCOUNT_CLOSED", label: "Account closed" },
    { value: "CUSTOMER_REQUEST", label: "Customer request" },
    { value: "DUPLICATE_ACCOUNT", label: "Duplicate account" },
  ],
  active: [
    { value: "REVIEW_CLEARED", label: "Review cleared" },
    { value: "CUSTOMER_REQUEST", label: "Customer request" },
  ],
};

export const REFERENCE_REASONS = [
  { value: "CORRECTION", label: "Correction" },
  { value: "CUSTOMER_REQUEST", label: "Customer request" },
  { value: "ACCOUNT_MERGE", label: "Account merge" },
];

/** Preview deployments only: the server returns a relative app path so a demo can continue without e-mail. */
export function PreviewLinkNotice({ path, what }: { path: string | undefined; what: string }) {
  if (!path) return null;
  return (
    <Callout tone="info" title="Preview environment" live="polite">
      E-mail is not delivered in preview. <Link href={path} className="font-semibold text-action underline underline-offset-2">Open the {what} link</Link>.
    </Callout>
  );
}

/** Sign-in methods shown on the staff and customer lists. */
export function SignInMethodBadges({ methods }: { methods: { password: boolean; sso: "linked" | "pending" | null } | undefined }) {
  if (!methods) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {methods.password ? <Badge tone="neutral">Password</Badge> : null}
      {methods.sso === "linked" ? <Badge tone="info">Microsoft SSO</Badge> : null}
      {methods.sso === "pending" ? <Badge tone="warning">SSO pending</Badge> : null}
      {!methods.password && !methods.sso ? <Badge tone="neutral">Not set</Badge> : null}
    </span>
  );
}
