/** Orders feature — shared presentation helpers. Owner: orders_engineer. */
import { Archive, CheckCircle2, CircleDot, Clock, Lock, ShieldAlert, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type Tone } from "@/ui";

export type WorkflowTone = "neutral" | "info" | "success" | "warning" | "danger";
export type LockState = "none" | "review" | "finalized" | "legal_hold" | "imported_read_only";

const TONE_ICON: Record<WorkflowTone, ReactNode> = {
  neutral: <CircleDot aria-hidden />,
  info: <Clock aria-hidden />,
  success: <CheckCircle2 aria-hidden />,
  warning: <ShieldAlert aria-hidden />,
  danger: <XCircle aria-hidden />,
};

/** Workflow status pill: icon + text, never colour alone. Unknown tones fall back to neutral. */
export function OrderStatusBadge({ label, tone }: { label: string; tone: string }) {
  const safeTone: WorkflowTone = tone in TONE_ICON ? (tone as WorkflowTone) : "neutral";
  return (
    <Badge tone={safeTone as Tone} icon={TONE_ICON[safeTone]}>
      {label}
    </Badge>
  );
}

export const LOCK_LABELS: Record<LockState, string> = {
  none: "Open",
  review: "Locked for review",
  finalized: "Finalized",
  legal_hold: "Legal hold",
  imported_read_only: "Imported (read-only)",
};

export const LOCK_DESCRIPTIONS: Record<LockState, string> = {
  none: "Changes are allowed.",
  review: "ReadyPackets is reviewing this order. You can still view and download everything.",
  finalized: "This order is finalized. You can still view and download everything.",
  legal_hold: "This order is on hold. Nothing can be changed until the hold is released.",
  imported_read_only: "This order was imported from another installation and is read-only.",
};

export function LockBadge({ state }: { state: LockState }) {
  if (state === "none") return null;
  return (
    <Badge tone={state === "legal_hold" ? "danger" : "neutral"} icon={state === "imported_read_only" ? <Archive aria-hidden /> : <Lock aria-hidden />}>
      {LOCK_LABELS[state]}
    </Badge>
  );
}

export const ACCESS_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  contributor: "Contributor",
  viewer: "Viewer",
  staff: "Staff",
  admin: "Administrator",
};

/** Opaque client-generated idempotency key (URL-safe, 22+ chars). Crypto-random; never derived from user data. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return `k${out}`;
}

export const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });
