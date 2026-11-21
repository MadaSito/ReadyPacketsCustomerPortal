import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, ConfirmDialog, ErrorState, Field, Input, Skeleton, StepUpCancelledError, useStepUp } from "@/ui";
import { customerMaintenanceTime } from "../CustomerMaintenanceBanner";
import { EndCustomerSessions } from "./EndCustomerSessions";

type Draft = { enabled: boolean; message: string; startsAt: string; endsAt: string; expectedVersion: number };

function asUtc(input: string): string | null {
  if (!input) return null;
  const value = new Date(`${input}Z`);
  if (!Number.isFinite(value.getTime())) throw new Error("Enter valid dates and times in UTC.");
  return value.toISOString();
}

export function CustomerMaintenanceControls() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const query = useQuery(trpc.jobs.admin.customerMaintenance.queryOptions(undefined, { refetchInterval: 15_000 }));
  const save = useMutation(trpc.jobs.admin.setCustomerMaintenance.mutationOptions());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const settings = query.data;
  const form: Draft | null = draft ?? (settings ? {
    enabled: settings.enabled, message: settings.message, startsAt: settings.startsAt?.slice(0, -1) ?? "",
    endsAt: settings.endsAt?.slice(0, -1) ?? "", expectedVersion: settings.version,
  } : null);
  const stale = Boolean(draft && settings && draft.expectedVersion !== settings.version);
  const state = { off: "Off", active: "Active", ended: "Ended", scheduled: "Scheduled" }[settings?.phase ?? "off"];
  const update = (fields: Partial<Draft>) => { if (form) setDraft({ ...form, ...fields }); setFeedback(null); };

  async function confirm() {
    if (!form) return;
    setFeedback(null);
    try {
      const input = { ...form, startsAt: asUtc(form.startsAt), endsAt: asUtc(form.endsAt) };
      const result = await stepUp.run(() => save.mutateAsync(input),
        { reason: "Changing customer access requires fresh verification." });
      qc.setQueryData(trpc.jobs.admin.customerMaintenance.queryKey(), result);
      void qc.invalidateQueries(trpc.jobs.maintenance.customerAccess.pathFilter());
      setDraft(null);
      setFeedback({ error: false, message: "Customer maintenance settings saved." });
    } catch (failure) {
      if (!(failure instanceof StepUpCancelledError)) {
        setFeedback({ error: true, message: errorMessage(failure) });
        void query.refetch();
      }
    }
  }

  return <Card title="Customer access" actions={settings ? <Badge tone={state === "Active" ? "warning" : "neutral"}>{state}</Badge> : null}>
    <div className="grid min-w-0 gap-4">
      <p className="text-sm text-muted">Block new customer sign-ins and registrations without affecting staff, administrators, or background jobs.</p>
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isPending ? <Skeleton lines={3} /> : null}
      {settings?.enabled && settings.startsAt ? <p className="text-sm">Start: <time dateTime={settings.startsAt}>{customerMaintenanceTime(settings.startsAt)}</time></p> : null}
      {settings?.enabled && settings.endsAt ? <p className="text-sm">Expected end: <time dateTime={settings.endsAt}>{customerMaintenanceTime(settings.endsAt)}</time></p> : null}
      {form ? <form className="grid min-w-0 gap-4" onSubmit={(event) => { event.preventDefault(); setConfirmation(true); }}>
        <Checkbox label="Enable customer maintenance" checked={form.enabled} onCheckedChange={(enabled) => update({ enabled })} />
        <Field label="Public message" hint="Optional. Up to 500 plain-text characters. Do not include private information.">
          <Input value={form.message} maxLength={500} onChange={(event) => update({ message: event.target.value })} />
        </Field>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field label="Start (UTC)" hint="Leave blank to start immediately when enabled.">
            <Input type="datetime-local" step="0.001" value={form.startsAt} onChange={(event) => update({ startsAt: event.target.value })} />
          </Field>
          <Field label="Expected end (UTC)" hint="Leave blank to keep maintenance active until you turn it off.">
            <Input type="datetime-local" step="0.001" value={form.endsAt} onChange={(event) => update({ endsAt: event.target.value })} />
          </Field>
        </div>
        {stale ? <Callout tone="warning" live="polite">Another administrator saved changes. Discard your draft to use the latest settings.</Callout> : null}
        {feedback ? <Callout tone={feedback.error ? "danger" : "success"} live={feedback.error ? "assertive" : "polite"}>{feedback.message}</Callout> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={stale || query.isError}>Review customer access change</Button>
          {draft ? <Button type="button" variant="secondary" onClick={() => { setDraft(null); setFeedback(null); }}>Discard draft</Button> : null}
        </div>
      </form> : null}
      {confirmation && form ? <ConfirmDialog open onOpenChange={setConfirmation}
        title="Save customer maintenance settings?" confirmLabel="Save settings" destructive={form.enabled}
        description={form.enabled ? "The configured window blocks new customer access. Existing sessions stay signed in."
          : "Turn off customer maintenance and allow new customer sign-ins and registrations."} onConfirm={confirm} /> : null}
      {settings?.active ? <EndCustomerSessions /> : null}
    </div>
  </Card>;
}
