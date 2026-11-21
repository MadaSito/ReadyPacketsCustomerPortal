import { Link } from "wouter";
import { Badge, Button, StatusBadge } from "@/ui";

export const jobStates = ["queued", "running", "completed", "failed", "canceled", "unknown"] as const;
export const mailStates = ["queued", "sending", "accepted", "held", "captured", "failed", "expired", "unknown", "canceled"] as const;
export const mailLabels: Record<(typeof mailStates)[number], string> = {
  queued: "Queued", sending: "Sending", accepted: "Provider accepted", held: "Held: mail not configured",
  captured: "Captured only", failed: "Failed", expired: "Expired", unknown: "Unknown outcome", canceled: "Canceled",
};

export function MailStatus({ state }: { state: (typeof mailStates)[number] }) {
  if (state === "held") return <StatusBadge state="refused" label={mailLabels.held} />;
  if (state === "accepted" || state === "captured") return <Badge tone="info">{mailLabels[state]}</Badge>;
  if (state === "sending") return <StatusBadge state="running" label={mailLabels.sending} />;
  if (state === "expired") return <StatusBadge state="canceled" label={mailLabels.expired} />;
  return <StatusBadge state={state} />;
}

export function Id({ value }: { value: string | null | undefined }) {
  return <span className="break-all font-mono text-sm tabular-nums">{value || "None"}</span>;
}

export function AuditLink({ correlationId }: { correlationId: string }) {
  return <Button asChild variant="secondary"><Link href={`/admin/audit?correlationId=${encodeURIComponent(correlationId)}`}>View audit trail</Link></Button>;
}
