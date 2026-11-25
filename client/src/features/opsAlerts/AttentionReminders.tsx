import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, Checkbox, ErrorState, Field, Input, Skeleton } from "@/ui";

export default function AttentionReminders() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const query = useQuery(trpc.opsAlerts.reminderConfig.queryOptions());
  const [draft, setDraft] = useState<{ enabled: boolean; hours: string }>();
  const [saved, setSaved] = useState(false);
  const update = useMutation(trpc.opsAlerts.updateReminderConfig.mutationOptions({
    onSuccess: (response) => {
      client.setQueryData(trpc.opsAlerts.reminderConfig.queryKey(), response);
      setDraft(undefined);
      setSaved(true);
    },
  }));
  const data = query.data;
  const values = draft ?? { enabled: data?.enabled ?? false, hours: String(data?.hours ?? 48) };
  return <Card className="space-y-3 p-4">
    <h2 className="text-base font-semibold">Waiting order reminders</h2>
    <p className="text-sm text-muted">Create staff alerts for overdue orders on a daily schedule. No customer email is sent.</p>
    {query.isPending ? <Skeleton className="w-full" /> : query.isError || !data
      ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      : <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (!draft || update.isPending) return;
        update.mutate({ enabled: draft.enabled, hours: Number(draft.hours) });
      }}>
        <Checkbox label="Enable waiting order reminders" checked={values.enabled} disabled={update.isPending}
          onCheckedChange={(enabled) => { setDraft({ ...values, enabled }); setSaved(false); }} />
        <Field label="Waiting threshold (hours)">
          <Input type="number" min={1} max={8760} step={1} required className="max-w-32" value={values.hours}
            disabled={update.isPending} onChange={(event) => { setDraft({ ...values, hours: event.target.value }); setSaved(false); }} />
        </Field>
        <Button type="submit" disabled={!draft || update.isPending}>{update.isPending ? "Saving…" : "Save reminder settings"}</Button>
        {update.isError ? <ErrorState error={update.error} onRetry={() => {
          if (draft) update.mutate({ enabled: draft.enabled, hours: Number(draft.hours) });
        }} /> : null}
        {saved ? <Callout tone="success" live="polite">Reminder settings saved.</Callout> : null}
      </form>}
  </Card>;
}
