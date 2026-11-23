/** D7: shared "Ban IP address" dialog (incident page and audit event drawer). The address never reaches the browser. */
import { useState, type FormEvent } from "react";
import { Button, Dialog, Field, Select, Textarea } from "@/ui";
import { BAN_DURATION_OPTIONS, banDurationOf, banReasonError, type BanMinutes } from "./model";

const DEFAULT_DESCRIPTION = "The address is taken from the recorded events on the server; it is never shown here. Sign-ins from it are refused until the ban ends.";

export function BanDialog({ open, onCancel, onSubmit, busy, description = DEFAULT_DESCRIPTION }: { open: boolean; onCancel: () => void; onSubmit: (durationMinutes: BanMinutes, reason: string) => Promise<void>; busy: boolean; description?: string }) {
  const [duration, setDuration] = useState("60");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ duration?: string; reason?: string }>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const minutes = banDurationOf(duration);
    const next = { duration: minutes === undefined ? "Choose how long the ban lasts." : undefined, reason: banReasonError(reason) ?? undefined };
    setErrors(next);
    if (next.duration || next.reason || minutes === undefined) return;
    await onSubmit(minutes, reason.trim()).catch(() => undefined);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()} title="Ban IP address" description={description} dismissible={!busy}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Duration" error={errors.duration} required>
          <Select value={duration} onChange={(e) => setDuration(e.target.value)} options={BAN_DURATION_OPTIONS} />
        </Field>
        <Field label="Reason" hint="3 to 240 characters. Recorded in the audit log; avoid personal data." error={errors.reason} required>
          <Textarea value={reason} maxLength={240} rows={3} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy}>Ban address</Button>
        </div>
      </form>
    </Dialog>
  );
}
