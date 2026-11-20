/** /admin/backups/retention — schedule + retention policy, dry-run plan, apply pruning. Owner: audit engineer. */
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Breadcrumbs, Button, Callout, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, Field, Input, KeyValueList,
  PageHeader, Section, Skeleton, StepUpCancelledError, Switch, useStepUp, useToast,
} from "@/ui";
import { useCan } from "./BackupParts";
import { BASE, KEEP_REASON_LABELS, RETENTION_LIMITS, type RetentionPlan, type RetentionPolicy } from "./model";

type PlanItem = RetentionPlan["items"][number];
const L = RETENTION_LIMITS;

export function policyErrors(keep: string, age: string): { keep?: string; age?: string } {
  const out: { keep?: string; age?: string } = {};
  const k = Number(keep);
  const a = Number(age);
  if (!/^\d+$/u.test(keep) || k < L.keepMin || k > L.keepMax) out.keep = `Enter a whole number from ${L.keepMin} to ${L.keepMax}.`;
  if (!/^\d+$/u.test(age) || a < L.ageMin || a > L.ageMax) out.age = `Enter a whole number from ${L.ageMin} to ${L.ageMax}.`;
  return out;
}

export function PlanTable({ items }: { items: readonly PlanItem[] }) {
  return (
    <DataTable
      caption="Retention plan"
      rows={items}
      rowKey={(r) => r.backupPublicId}
      empty={<EmptyState icon={CalendarClock} title="Nothing to evaluate" description="There are no backups yet." headingLevel={3} />}
      columns={[
        { key: "when", header: "Backup started", primary: true, cell: (r) => <Link href={`${BASE}/${encodeURIComponent(r.backupPublicId)}`} className="text-action underline"><DateTime value={r.createdAt} format="datetime" /></Link> },
        { key: "action", header: "Planned action", cell: (r) => (r.action === "prune" ? <Badge tone="danger">Remove</Badge> : <Badge tone="success">Keep</Badge>) },
        { key: "why", header: "Why", cell: (r) => (r.keepReason ? KEEP_REASON_LABELS[r.keepReason] ?? r.keepReason : r.action === "prune" ? "Outside the policy" : "—") },
      ]}
    />
  );
}

function PolicyForm({ policy, canManage }: { policy: RetentionPolicy; canManage: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const update = useMutation(trpc.backup.admin.updateRetentionPolicy.mutationOptions());
  const [keep, setKeep] = useState(String(policy.keepLastCount));
  const [age, setAge] = useState(String(policy.maxAgeDays));
  const [schedule, setSchedule] = useState(policy.scheduleEnabled);
  const [autoPrune, setAutoPrune] = useState(policy.autoPruneEnabled);
  const [touched, setTouched] = useState(false);
  const errs = policyErrors(keep, age);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errs.keep || errs.age) return;
    try {
      await stepUp.run(() => update.mutateAsync({ keepLastCount: Number(keep), maxAgeDays: Number(age), scheduleEnabled: schedule, autoPruneEnabled: autoPrune }),
        { reason: "Changing backup retention requires a fresh confirmation." });
      toast.show({ title: "Retention policy saved", tone: "success" });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Policy not saved", description: errorMessage(error), tone: "danger" });
    } finally {
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    }
  };

  if (!canManage) {
    return (
      <KeyValueList columns={2} items={[
        { label: "Keep at least", value: `${policy.keepLastCount} most recent backups` },
        { label: "Maximum age", value: `${policy.maxAgeDays} days` },
        { label: "Daily backup schedule", value: policy.scheduleEnabled ? "On" : "Off" },
        { label: "Automatic pruning", value: policy.autoPruneEnabled ? "On" : "Off (plan only)" },
      ]} />
    );
  }
  return (
    <form className="max-w-xl space-y-4" onSubmit={submit} noValidate>
      <Field label="Keep at least this many recent backups" required error={touched ? errs.keep : undefined} hint={`${L.keepMin}–${L.keepMax}.`}>
        <Input value={keep} onChange={(e) => setKeep(e.target.value)} inputMode="numeric" maxLength={3} />
      </Field>
      <Field label="Remove backups older than (days)" required error={touched ? errs.age : undefined} hint={`${L.ageMin}–${L.ageMax}. Held backups and the last verified good copy are always kept.`}>
        <Input value={age} onChange={(e) => setAge(e.target.value)} inputMode="numeric" maxLength={4} />
      </Field>
      <Switch label="Daily backup schedule" description="Runs an encrypted backup every 24 hours and re-verifies the newest one." checked={schedule} onCheckedChange={setSchedule} />
      <Switch label="Automatic pruning" description="When off, the daily retention job only plans; nothing is removed until you apply it here." checked={autoPrune} onCheckedChange={setAutoPrune} />
      <Button type="submit" loading={update.isPending}>Save policy</Button>
    </form>
  );
}

export default function RetentionPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const canManage = useCan("backup.retention.manage");
  const policy = useQuery(trpc.backup.admin.retentionPolicy.queryOptions());
  const plan = useQuery(trpc.backup.admin.previewRetention.queryOptions());
  const run = useMutation(trpc.backup.admin.runRetention.mutationOptions());
  const [confirm, setConfirm] = useState(false);
  const pruneCount = plan.data?.items.filter((i) => i.action === "prune").length ?? 0;

  const apply = async () => {
    try {
      const result = await stepUp.run(() => run.mutateAsync({ dryRun: false }), { reason: "Removing backups requires a fresh confirmation." });
      toast.show({ title: "Retention applied", description: `${result.prunedCount} backup(s) removed.`, tone: "success" });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Retention not applied", description: errorMessage(error, "The outcome is unknown. Refresh the plan before retrying."), tone: "danger" });
      throw error;
    } finally {
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    }
  };

  return (
    <>
      <PageHeader title="Backup retention" breadcrumbs={<Breadcrumbs items={[{ label: "Backups", href: BASE }, { label: "Retention" }]} />}
        description="How long encrypted backups are kept, and whether the daily schedule runs." />
      <div className="space-y-8">
        <Section title="Policy">
          {policy.isPending ? <Skeleton lines={4} /> : policy.error || !policy.data ? <ErrorState error={policy.error} onRetry={() => policy.refetch()} /> : (
            <PolicyForm key={JSON.stringify(policy.data)} policy={policy.data} canManage={canManage} />
          )}
        </Section>
        <Section title="Current plan" description="What retention would do now. The last verified good copy and held backups are never removed."
          actions={canManage && pruneCount > 0 ? <Button variant="danger" loading={run.isPending} onClick={() => setConfirm(true)}>Apply retention</Button> : undefined}>
          {plan.isPending ? <Skeleton lines={3} /> : plan.error || !plan.data ? <ErrorState error={plan.error} onRetry={() => plan.refetch()} /> : (
            <div className="space-y-3">
              <Callout tone={pruneCount > 0 ? "warning" : "info"}>{pruneCount > 0 ? `${pruneCount} backup(s) would be removed.` : "No backups would be removed."}</Callout>
              <PlanTable items={plan.data.items} />
            </div>
          )}
        </Section>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${pruneCount} backup(s)?`}
        description="Removed backups cannot be recovered. The removal is recorded in the audit log. You will be asked to confirm your identity."
        confirmLabel="Remove backups"
        destructive
        confirmText="REMOVE"
        onConfirm={apply}
      />
    </>
  );
}
