/** Shared status-change + reason dialog for customer and staff accounts (console). */
import { useState } from "react";
import { ConfirmDialog, Field, Select } from "@/ui";
import { STATUS_REASONS } from "../shared";

export type StatusTarget = "active" | "suspended" | "deactivated";

const COPY: Record<StatusTarget, { title: string; description: string; confirm: string; destructive: boolean }> = {
  suspended: {
    title: "Suspend this account?",
    description: "The person is signed out everywhere and cannot sign in until the account is reactivated. Outstanding links stop working.",
    confirm: "Suspend account",
    destructive: true,
  },
  deactivated: {
    title: "Deactivate this account?",
    description: "The person is signed out everywhere and the account is closed. Records are kept for retention and audit.",
    confirm: "Deactivate account",
    destructive: true,
  },
  active: {
    title: "Reactivate this account?",
    description: "The person can sign in again. Multi-factor verification is still required.",
    confirm: "Reactivate account",
    destructive: false,
  },
};

export function StatusDialog({
  target,
  onOpenChange,
  onConfirm,
}: {
  target: StatusTarget | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (status: StatusTarget, reasonCode: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const copy = target ? COPY[target] : COPY.suspended;
  const options = target ? STATUS_REASONS[target] : [];
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => { if (!open) setReason(""); onOpenChange(open); }}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirm}
      destructive={copy.destructive}
      onConfirm={async () => {
        if (!target) return;
        await onConfirm(target, reason || options[0]!.value);
        setReason("");
      }}
    >
      <Field label="Reason" hint="Recorded in the audit log.">
        <Select options={options} value={reason || options[0]?.value || ""} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
