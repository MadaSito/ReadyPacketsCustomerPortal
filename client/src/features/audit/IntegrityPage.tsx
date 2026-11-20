import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, CopyButton, DataTable, DateTime, EmptyState, ErrorState, KeyValueList, PageHeader, Section,
  Skeleton, StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { AuditNav } from "./AuditNav";
import type { IntegrityStatus, Verification } from "./model";

const BREAK_LABELS: Record<string, string> = {
  SEQ_GAP: "A sealed record is missing from the sequence without a retention record.",
  PREV_MISMATCH: "A record does not link to the one before it.",
  LINK_MISMATCH: "A record's link hash does not match its contents.",
  DIGEST_MISMATCH: "An event's contents no longer match its sealed digest.",
  EVENT_MISSING: "A sealed event is missing without a valid retention record.",
  EVENT_ID_MISMATCH: "A sealed record points at a different event.",
  HEAD_MISMATCH: "The chain head does not match the last sealed record.",
  CHECKPOINT_MISMATCH: "A signed checkpoint does not match the chain.",
  CHECKPOINT_SIGNATURE_INVALID: "A checkpoint signature is not valid for the installation key.",
};

export function IntegritySummary({ status, verification }: { status: IntegrityStatus; verification: Verification | null }) {
  const lastOk = verification ? verification.ok : status.lastVerifyOk;
  const stale = status.oldestUnsealedAgeSeconds !== null && status.oldestUnsealedAgeSeconds > status.horizonSeconds;
  return (
    <div className="space-y-4">
      {lastOk === false ? (
        <Callout tone="danger" title="Integrity check failed" live="assertive">
          {verification?.firstBreak
            ? `${BREAK_LABELS[verification.firstBreak.reason] ?? "The chain could not be verified."} First problem at record #${verification.firstBreak.seq}. Preserve this installation and open an investigation case.`
            : `The last verification found a problem${status.lastVerifyBreakSeq ? ` at record #${status.lastVerifyBreakSeq}` : ""}. Run a new check and open an investigation case.`}
        </Callout>
      ) : lastOk === true ? (
        <Callout tone="success" title="Chain verified" live="polite">
          {verification ? `${verification.checked.toLocaleString()} records and ${verification.checkpointsVerified} checkpoints checked${verification.complete ? "" : " (partial range)"}.` : "The last verification found no problems."}
        </Callout>
      ) : (
        <Callout tone="info" title="Not verified yet">Run a verification to check every sealed record against the hash chain and signed checkpoints.</Callout>
      )}
      {stale ? <Callout tone="warning" title="Sealing is behind">Some events have waited longer than {Math.round(status.horizonSeconds / 60)} minutes to be sealed. Check that the worker is running.</Callout> : null}
      <KeyValueList columns={3} items={[
        { label: "Sealed records", value: status.headSeq.toLocaleString() },
        { label: "Waiting to seal", value: status.unsealed.toLocaleString() },
        { label: "Retention records", value: status.counts.tombstones.toLocaleString() },
        { label: "Last sealed", value: status.lastSealedAt ? <DateTime value={status.lastSealedAt} format="relative" /> : null },
        { label: "Last verified", value: status.lastVerifiedAt ? <DateTime value={status.lastVerifiedAt} format="relative" /> : null },
        { label: "Sealing horizon", value: `${Math.round(status.horizonSeconds / 60)} minutes` },
        { label: "Recording failures", value: status.emitter ? status.emitter.recordFailures.toLocaleString() : "Not reported by this process" },
        { label: "Queued notes", value: status.emitter ? status.emitter.notesQueued.toLocaleString() : null },
        { label: "Dropped notes", value: status.emitter ? status.emitter.notesDropped.toLocaleString() : null },
        { label: "Head hash", value: <code className="text-xs break-all">{status.headHash}</code>, wide: true },
        {
          label: "Checkpoint public key",
          wide: true,
          value: (
            <span className="flex items-start gap-1">
              <code className="min-w-0 text-xs break-all">{status.checkpointPublicKey}</code>
              <CopyButton value={status.checkpointPublicKey} label="Copy checkpoint public key" iconOnly />
            </span>
          ),
        },
        { label: "Key reference", value: <code className="text-xs">{status.checkpointKeyRef}</code> },
      ]} />
    </div>
  );
}

export default function IntegrityPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const client = useQueryClient();
  const status = useQuery(trpc.audit.integrity.status.queryOptions());
  const checkpoints = useQuery(trpc.audit.integrity.checkpoints.queryOptions());
  const verify = useMutation(trpc.audit.integrity.verify.mutationOptions());
  const checkpoint = useMutation(trpc.audit.integrity.createCheckpoint.mutationOptions());
  const [verification, setVerification] = useState<Verification | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: trpc.audit.integrity.pathKey() });

  return (
    <>
      <PageHeader title="Audit integrity" description="Every audit event is sealed into a keyed hash chain. Signed checkpoints let you prove the record was not altered."
        actions={
          <>
            <Button variant="secondary" loading={checkpoint.isPending} onClick={async () => {
              try {
                await stepUp.run(() => checkpoint.mutateAsync(), { reason: "Signing a checkpoint requires a fresh confirmation." });
                await refresh();
                toast.show({ title: "Checkpoint signed", tone: "success" });
              } catch (error) {
                if (!(error instanceof StepUpCancelledError)) toast.show({ title: "Checkpoint not signed", description: errorMessage(error), tone: "danger" });
              }
            }}>Sign checkpoint</Button>
            <Button leadingIcon={<ShieldCheck aria-hidden className="size-4" />} loading={verify.isPending} onClick={async () => {
              try {
                setVerification(await verify.mutateAsync({}));
                await refresh();
              } catch (error) {
                toast.show({ title: "Verification did not run", description: errorMessage(error), tone: "danger" });
              }
            }}>Verify now</Button>
          </>
        } />
      <AuditNav />
      <Card title="Chain status" className="mb-6">
        {status.isPending ? <div role="status" aria-label="Loading integrity status" className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-32" /></div>
          : status.error ? <ErrorState error={status.error} onRetry={() => status.refetch()} />
          : <IntegritySummary status={status.data} verification={verification} />}
      </Card>
      <Section title="Signed checkpoints" description="Each checkpoint signs the chain head with the installation's Ed25519 key. Keep copies outside this system.">
        <DataTable
          caption="Signed checkpoints"
          rows={checkpoints.data}
          loading={checkpoints.isPending}
          error={checkpoints.error}
          onRetry={() => checkpoints.refetch()}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No checkpoints yet" description="Checkpoints are signed hourly by the worker, or on demand." headingLevel={3} />}
          columns={[
            { key: "signed", header: "Signed", primary: true, cell: (c) => <DateTime value={c.signedAt} format="datetime" /> },
            { key: "seq", header: "Through record", align: "end", cell: (c) => `#${c.seq.toLocaleString()}` },
            { key: "reason", header: "Reason", cell: (c) => <Badge>{c.reason}</Badge> },
            { key: "hash", header: "Head hash", hideOnMobile: true, cell: (c) => <code className="text-xs break-all">{c.headHash.slice(0, 16)}…</code> },
          ]}
          rowActions={(c) => <CopyButton value={JSON.stringify(c)} label={`Copy checkpoint ${c.seq} as JSON`} />}
        />
      </Section>
    </>
  );
}
