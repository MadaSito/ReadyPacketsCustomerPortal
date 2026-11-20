import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useRoute } from "wouter";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Breadcrumbs, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, Field, Input,
  KeyValueList, PageHeader, Section, Skeleton, StatusBadge, StepUpCancelledError, useStepUp,
} from "@/ui";
import { describeReason, PHASE_NAMES } from "../format";

const APPLY_WORK = ["approved", "objects-prepared", "records-committed", "finalized"];
const PRE_APPROVAL = ["received", "quarantined", "verified", "planned"];
const DISPOSITIONS: Record<string, string> = { create: "Create", link: "Existing provenance link", conflict: "Conflict", hold: "Hold as evidence" };

export default function ImportDetails() {
  const [, route] = useRoute("/admin/portable/import/:importId");
  const importId = route?.importId ?? "";
  const validId = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(importId);
  const trpc = useTRPC();
  const client = useTRPCClient();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmAction, setConfirmAction] = useState<"approve" | "cancel" | "accept">();
  const [checked, setChecked] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const detail = useQuery(trpc.portable.admin.getImport.queryOptions({ importId }, {
    enabled: validId,
    refetchInterval: (query) => query.state.data && APPLY_WORK.includes(query.state.data.phase) ? 3_000 : false,
  }));
  const row = detail.data;

  async function verify(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (busy) return;
    const passphrase = password.current?.value ?? "";
    if (!passphrase || passphrase.length > 512) { setError("Enter the package's transfer passphrase."); return; }
    if (password.current) password.current.value = "";
    setBusy(true);
    try {
      // Do not retain the passphrase in query client mutation variables or defaults.
      await stepUp.run(() => client.portable.admin.verifyAndPlan.mutate({ importId, passphrase }), {
        reason: "Verify your identity before reading the quarantined transfer package.",
      });
    } catch (failure) {
      if (!(failure instanceof StepUpCancelledError)) {
        setError(errorMessage(failure, "The verification receipt is unavailable. Refresh the import status before retrying."));
      }
    } finally {
      await detail.refetch();
      setBusy(false);
    }
  }

  async function action() {
    if (!row || !confirmAction) return;
    setError(undefined);
    try {
      await stepUp.run(async () => {
        if (confirmAction === "cancel") return client.portable.admin.cancel.mutate({ importId });
        if (!row.planDigest) throw new Error("Plan no longer available");
        return confirmAction === "approve"
          ? client.portable.admin.approve.mutate({ importId, planDigest: row.planDigest })
          : client.portable.admin.accept.mutate({ importId, planDigest: row.planDigest, independentChecks: true });
      }, { reason: "Verify your identity for this import decision." });
      setConfirmAction(undefined);
      await detail.refetch();
    } catch (failure) {
      if (!(failure instanceof StepUpCancelledError)) {
        setError(errorMessage(failure, "The decision receipt is unavailable. Refresh the import status before retrying."));
      }
      setConfirmAction(undefined);
      await detail.refetch();
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Portable import" description="Verify the package, review the exact plan, then reconcile applied records."
        breadcrumbs={<Breadcrumbs items={[{ label: "Portable transfer", href: "/admin/portable" }, { label: "Import details" }]} />}
        meta={row ? <StatusBadge state={row.state} label={PHASE_NAMES[row.phase]} /> : undefined}
        actions={row && PRE_APPROVAL.includes(row.phase)
          ? <Button variant="secondary" disabled={busy} onClick={() => setConfirmAction("cancel")}>Cancel import</Button> : undefined} />
      {!validId ? <ErrorState message="The import reference is not valid." /> : detail.isPending
        ? <div role="status" aria-label="Loading import"><Skeleton lines={4} /></div>
        : detail.error && !row ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} /> : null}
      {error ? <Callout tone="danger" live="assertive" title="Import action did not complete">{error}</Callout> : null}
      {row ? <>
        {row.reasonCode ? <Callout tone={row.state === "unknown" ? "warning" : "info"} title={PHASE_NAMES[row.phase]}>
          {describeReason(row.reasonCode)}
        </Callout> : null}
        {APPLY_WORK.includes(row.phase) ? <Callout tone="info" title="Approved work is in progress" live="polite">
          Latest durable checkpoint: {PHASE_NAMES[row.phase]}. Do not upload another copy while this operation is running.
        </Callout> : null}
        {(row.phase === "quarantined" || row.phase === "verified") ? <Card title="Verify and plan"
          description="This dry run checks the package and target rules without writing business records.">
          <form onSubmit={verify} className="max-w-xl space-y-4">
            <Field label="Package passphrase" required hint="Use the passphrase supplied by the exporting administrator.">
              <Input ref={password} type="password" autoComplete="off" maxLength={512} disabled={busy} />
            </Field>
            <Button type="submit" loading={busy} disabled={busy}>
              {row.phase === "verified" ? "Resume plan preparation" : "Verify and create dry-run plan"}
            </Button>
            {busy ? <p role="status" className="text-sm text-body">Verification and target checks are in progress. No business records are being written.</p> : null}
          </form>
        </Card> : null}
        {row.plan ? <Section title="Dry-run plan" description="No email-based linking, overwrites, or active credentials. Imported orders are read-only.">
          <Card>
            <KeyValueList columns={2} items={[
              { label: "New records", value: row.plan.counts.creates },
              { label: "Existing provenance links", value: row.plan.counts.links },
              { label: "Conflicts", value: row.plan.counts.conflicts },
              { label: "Held content", value: row.plan.counts.heldUnknown },
              { label: "Plan digest", value: <code className="break-all text-xs">{row.planDigest}</code>, wide: true },
              { label: "Plan approval expires", value: <DateTime value={row.planExpiresAt} /> },
            ]} />
            {row.plan.counts.conflicts ? <Callout tone="warning" title="Resolve conflicts outside this import">
              Approval is blocked. This tool does not link or overwrite a conflicting account. Cancel and obtain a corrected package or resolve the conflict separately before verifying again.
            </Callout> : row.phase === "planned" ? <Button onClick={() => setConfirmAction("approve")}>Approve this plan</Button> : null}
          </Card>
          <DataTable caption="Dry-run record samples" rows={row.plan.samples} rowKey={(record) => `${record.portableId}:${record.disposition}`}
            empty={<EmptyState title="No proposed record changes" description="The verified plan has no business record entries." />}
            columns={[
              { key: "reference", header: "Portable ID", primary: true, cell: (sample) => <code className="break-all text-xs">{sample.portableId}</code> },
              { key: "disposition", header: "Disposition", cell: (sample) => DISPOSITIONS[sample.disposition] },
              { key: "reason", header: "Reason", cell: (sample) => describeReason(sample.reason) ?? "Reviewed entry" },
            ]} />
        </Section> : null}
        {row.reconciliation ? <Section title="Reconciliation" description="Compare package inventory, target receipts, and verified object bytes.">
          <Card>
            <KeyValueList columns={2} items={[
              { label: "Package records", value: row.reconciliation.inventory },
              { label: "Newly imported", value: row.reconciliation.imported },
              { label: "Linked by provenance", value: row.reconciliation.linked },
              { label: "Held content", value: row.reconciliation.heldUnknown },
              { label: "Verified objects", value: `${row.reconciliation.verifiedObjects} of ${row.reconciliation.objects}` },
              { label: "Discrepancies", value: row.reconciliation.discrepancies },
            ]} />
            {row.phase === "reconciled" ? <>
              <Callout tone="info" title="Final acceptance is a separate review">
                A different administrator must independently check target access, read-only orders and authorized downloads. Automated byte reconciliation is not a substitute for that check.
              </Callout>
              <Checkbox label="I independently confirmed access, locks, and applicable authorized downloads"
                checked={checked} onCheckedChange={setChecked} />
              <Button disabled={!checked} onClick={() => setConfirmAction("accept")}>Accept reconciled import</Button>
            </> : null}
          </Card>
        </Section> : null}
        {row.held.length ? <Section title="Held content" description="The installation retained this evidence without activating it. Showing up to 100 entries.">
          <DataTable caption="Held records" rows={row.held} rowKey={(sample) => `${sample.type}:${sample.portableId}`}
            columns={[
              { key: "reference", header: "Portable ID", primary: true, cell: (sample) => <code className="break-all text-xs">{sample.portableId}</code> },
              { key: "type", header: "Record type", cell: (sample) => sample.type },
              { key: "reason", header: "Reason", cell: (sample) => describeReason(sample.reasonCode) ?? "Retained for review" },
            ]} />
        </Section> : null}
        <Section title="Durable checkpoints" description="Operation IDs correlate each checkpoint with the audit trail.">
          <ol className="space-y-2" aria-label="Import progress">
            {row.steps.map((step) => <li key={step.operationId} aria-current={step.phase === row.phase ? "step" : undefined}
              className="grid gap-1 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 sm:grid-cols-3">
              <span className="text-sm font-semibold text-ink">{PHASE_NAMES[step.phase]}</span>
              <DateTime value={step.occurredAt} />
              <code className="break-all text-xs text-muted">{step.operationId}</code>
            </li>)}
          </ol>
        </Section>
      </> : null}
      <ConfirmDialog open={Boolean(confirmAction)} onOpenChange={(open) => { if (!open) setConfirmAction(undefined); }}
        title={confirmAction === "cancel" ? "Cancel this import?" : confirmAction === "accept" ? "Accept this reconciled import?" : "Approve this exact plan?"}
        description={confirmAction === "cancel" ? "The unapproved plan cannot be applied after cancellation."
          : confirmAction === "accept" ? "This records your independent acceptance. Keep the source package until a separate retention decision."
            : "This starts a job that writes the reviewed records. It does not overwrite accounts or enable imported credentials."}
        confirmLabel={confirmAction === "cancel" ? "Cancel import" : confirmAction === "accept" ? "Record acceptance" : "Approve and apply"}
        destructive={confirmAction === "cancel"} onConfirm={action} />
    </div>
  );
}
