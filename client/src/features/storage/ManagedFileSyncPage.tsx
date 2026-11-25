import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterInputs } from "@trpc/server";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DateTime, ErrorState, Field, LoadMore, PageHeader, Select, StepUpCancelledError, useStepUp } from "@/ui";

type SyncScope = inferRouterInputs<AppRouter>["storage"]["fileSync"]["previewResync"];
type Mode = "phase_files" | "receipts" | null;

function ResyncControl({ scope, label, context, onSuccess }: { scope: SyncScope; label: string; context: string; onSuccess?: () => void }) {
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const preview = useMutation(trpc.storage.fileSync.previewResync.mutationOptions());
  const commit = useMutation(trpc.storage.fileSync.resync.mutationOptions());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState<number | null>(null);
  const [result, setResult] = useState<{ count: number; previewToken: string; inspectOnly: number; more: boolean } | null>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const commitButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (queued === null || !returnFocus.current) return;
    returnFocus.current = false;
    if (document.activeElement !== document.body) return;
    const button = previewButton.current;
    const row = scope.scope === "file" ? button?.closest("li") : null;
    (row ?? button)?.focus();
  }, [queued, scope.scope]);
  async function inspect() {
    setBusy(true); setError(""); setResult(null); setQueued(null);
    try { setResult(await stepUp.run(() => preview.mutateAsync(scope))); }
    catch (err) { if (!(err instanceof StepUpCancelledError)) setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!result) return;
    returnFocus.current = document.activeElement === commitButton.current;
    setBusy(true); setError("");
    try {
      const output = await stepUp.run(() => commit.mutateAsync({ scope, previewToken: result.previewToken }));
      setResult(null); setQueued(output.queued); onSuccess?.();
    } catch (err) { if (!(err instanceof StepUpCancelledError)) setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <Button ref={previewButton} size="sm" variant="secondary" disabled={busy} aria-label={`${label}: ${context}`} onClick={() => void inspect()}>{label}</Button>
      {result ? (
        <>
          <p className="text-sm text-muted" role="status">{result.count} eligible {result.count === 1 ? "transfer" : "transfers"}.
            {result.inspectOnly ? ` ${result.inspectOnly} will be inspected without uploading.` : ""}
            {result.more ? " This preview is limited to a batch of 100." : ""}
          </p>
          {result.count > 0 ? <Button ref={commitButton} size="sm" loading={busy} aria-label={`Queue these transfers: ${context}`}
            onClick={() => void apply()}>Queue these transfers</Button> : null}
        </>
      ) : null}
      {queued !== null ? <p className="text-sm text-muted" role="status">{queued} queued.</p> : null}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

function TargetControl({ row, refresh }: {
  row: { publicId: string; label: string; enabled: boolean; mode: Mode; version: number; writeTested: boolean; kind: string;
    lastSuccessAt: Date | null; backlog: number; blocked: number };
  refresh: () => void;
}) {
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const test = useMutation(trpc.storage.fileSync.testTarget.mutationOptions());
  const save = useMutation(trpc.storage.fileSync.setTarget.mutationOptions());
  const id = useId();
  const [draft, setDraft] = useState<{ mode: Mode; version: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const mode = draft && draft.version === row.version ? draft.mode : row.mode;
  useEffect(() => {
    if (!notice || !returnFocus.current) return;
    returnFocus.current = false;
    if (document.activeElement === document.body) heading.current?.focus();
  }, [notice]);
  const run = async (op: "test" | "save") => {
    returnFocus.current = op === "save" && document.activeElement === saveButton.current;
    setBusy(true); setNotice(""); setError("");
    try {
      if (op === "test") {
        const result = await stepUp.run(() => test.mutateAsync({ publicId: row.publicId, expectedVersion: row.version }));
        if (result.ok) setNotice("Write access confirmed. No test file was created.");
        else setError(`Write test did not pass (${result.code}). Check the Microsoft 365 permission and both Graph egress presets.`);
      } else {
        await stepUp.run(() => save.mutateAsync({ publicId: row.publicId, expectedVersion: row.version, mode, confirm: true }));
        setDraft(null);
        setConfirmed(false);
        setNotice("Destination approval updated.");
      }
      refresh();
    } catch (err) { if (!(err instanceof StepUpCancelledError)) setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return (
    <Card className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 ref={heading} tabIndex={-1} className="min-w-0 break-words font-semibold text-ink">{row.label}</h3>
        <Badge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "Enabled" : "Disabled"}</Badge>
        <Badge tone={row.writeTested ? "success" : "warning"}>{row.writeTested ? "Write tested" : "Write test required"}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted">Last successful copy</dt><dd>{row.lastSuccessAt ? <DateTime value={row.lastSuccessAt} /> : "None yet"}</dd></div>
        <div><dt className="text-muted">Backlog</dt><dd>{row.backlog}</dd></div>
        <div><dt className="text-muted">Blocked</dt><dd>{row.blocked}</dd></div>
      </dl>
      {row.kind === "onedrive" ? <p className="text-sm text-muted">OneDrive application access may require tenant-wide file permissions. Prefer a dedicated SharePoint site with a site-specific grant.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy} aria-label={`Test write access: ${row.label}`} onClick={() => void run("test")}>Test write access</Button>
        <Button asChild size="sm" variant="secondary"><Link aria-label={`Edit connection: ${row.label}`} href={`/admin/storage/${row.publicId}/edit`}>Edit connection</Link></Button>
      </div>
      <Field id={`${id}-approval`} label="Approved purpose">
        <Select disabled={busy} value={mode ?? ""} options={[
          { value: "", label: "Do not transfer" },
          { value: "phase_files", label: "Phase files (including staff files)" },
          { value: "receipts", label: "Restricted Receipts only" },
        ]} onChange={(event) => {
          const value = event.currentTarget.value;
          setDraft({ mode: value === "phase_files" || value === "receipts" ? value : null, version: row.version });
          setConfirmed(false);
        }} />
      </Field>
      {mode !== row.mode ? (
        <div className="flex flex-col items-start gap-3">
          {mode ? <Checkbox checked={confirmed} onCheckedChange={setConfirmed}
            label="I verified that only authorized people can access this private Microsoft 365 destination." /> : null}
          <Button ref={saveButton} size="sm" loading={busy} aria-label={`Save approval: ${row.label}`}
            disabled={!!mode && (!confirmed || !row.enabled || !row.writeTested)} onClick={() => void run("save")}>Save approval</Button>
        </div>
      ) : null}
      {notice ? <p className="text-sm text-muted" role="status">{notice}</p> : null}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {row.mode ? <ResyncControl scope={{ scope: "target", publicId: row.publicId }} label="Preview destination resync" context={row.label} onSuccess={refresh} /> : null}
    </Card>
  );
}

export function ManagedFileSyncPage() {
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const [unlock, setUnlock] = useState(false);
  const unlockButton = useRef<HTMLButtonElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef(false);
  const targets = useQuery(trpc.storage.fileSync.health.queryOptions(undefined, { enabled: unlock, retry: false }));
  const refresh = () => { void targets.refetch(); };
  const [error, setError] = useState("");
  useEffect(() => {
    if (!unlock || !returnFocus.current) return;
    returnFocus.current = false;
    if (document.activeElement === document.body) resultsHeading.current?.focus();
  }, [unlock]);
  return (
    <>
      <PageHeader title="Microsoft 365 file sync" description="Approve private destinations, test write access, and recover outbound phase file transfers."
        actions={<Button asChild variant="secondary" size="sm"><Link href="/admin/storage">Back to storage connections</Link></Button>} />
      <div className="flex min-w-0 flex-col gap-4">
        <Callout title="Before approving a destination" tone="info">
          <p>Use a dedicated private SharePoint site and an Entra app with a <code>Sites.Selected</code> write grant. Enable both <Link href="/admin/integrations/egress" className="underline">Microsoft Graph egress presets</Link>. Receipts require a separate restricted drive and are off by default.</p>
        </Callout>
        {!unlock ? <Button ref={unlockButton} className="self-start" onClick={() => {
          returnFocus.current = document.activeElement === unlockButton.current;
          void stepUp.request({ reason: "Manage Microsoft 365 file sync" }).then((verified) => {
            if (verified) setUnlock(true);
          }).catch((err: unknown) => {
            if (!(err instanceof StepUpCancelledError)) setError(errorMessage(err));
          });
        }}>Verify identity and view destinations</Button> : <h2 ref={resultsHeading} tabIndex={-1} className="font-semibold text-ink">Destinations</h2>}
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        {unlock && targets.isPending ? <p role="status">Loading destinations…</p> : null}
        {unlock && targets.isError ? <ErrorState error={targets.error} onRetry={refresh} /> : null}
        {targets.data?.length === 0 ? <p>No Microsoft 365 connections. <Link href="/admin/storage/new" className="underline">Add a storage connection</Link>.</p> : null}
        {targets.data?.map((row) => <TargetControl key={row.publicId} row={row} refresh={refresh} />)}
      </div>
    </>
  );
}

const ROLE = { originals: "Original", conversionStaging: "Conversion staging", intakeDelivery: "Intake delivery", receipt: "Receipt" };
const STATE = { queued: "Queued", copying: "Copying", copied: "Copied", failed: "Failed", blocked: "Blocked", unknown: "Needs reconciliation" };

export function ManagedOrderFileSync({ orderId, canManage }: { orderId: string; canManage: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useInfiniteQuery(trpc.storage.fileSync.forOrder.infiniteQueryOptions({ orderPublicId: orderId }, {
    getNextPageParam: (page) => page.nextCursor ?? undefined, retry: false,
  }));
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: trpc.storage.fileSync.forOrder.pathKey() }); };
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (query.isPending) return <p className="text-sm text-muted" role="status">Checking Microsoft 365 phase transfers…</p>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!rows.length) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Microsoft 365 phase transfers">
      <h3 className="font-semibold text-ink">Microsoft 365 phase transfers</h3>
      {canManage ? <ResyncControl scope={{ scope: "order", orderPublicId: orderId }} label="Preview order resync" context={orderId} onSuccess={refresh} /> : null}
      <ul className="flex min-w-0 flex-col gap-2">
        {rows.map((row) => (
          <li key={row.publicId} tabIndex={-1} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3">
            <div className="min-w-0 space-y-1">
              <p className="font-semibold">{ROLE[row.role]} <Badge tone={row.state === "copied" ? "success" : row.state === "unknown" || row.state === "failed" || row.state === "blocked" ? "warning" : "neutral"}>{STATE[row.state]}</Badge></p>
              <p className="break-words text-sm text-muted">{row.destination ?? "Destination unavailable"}</p>
              <p className="break-all text-xs text-muted">{row.fileName ?? row.sourcePublicId}</p>
              {row.reasonCode === "STORAGE_FILE_SYNC_REMOTE_PRESENT" ? <p className="text-sm text-muted">A file exists at the destination, but its identity could not be verified. No upload was retried.</p> : null}
              {row.reasonCode === "STORAGE_FILE_SYNC_REMOTE_UNCONFIRMED" ? <p className="text-sm text-muted">The write could not be confirmed. No upload was retried.</p> : null}
            </div>
            {canManage && (row.state === "failed" || row.state === "blocked" || row.state === "unknown") ?
              <ResyncControl scope={{ scope: "file", orderPublicId: orderId, filePublicId: row.sourcePublicId }} label="Preview file resync"
                context={`${row.fileName ?? row.sourcePublicId}, ${ROLE[row.role]}${row.destination ? `, ${row.destination}` : ""}`} onSuccess={refresh} /> : null}
          </li>
        ))}
      </ul>
      <LoadMore hasMore={query.hasNextPage} onLoadMore={() => void query.fetchNextPage()} loading={query.isFetchingNextPage} />
    </section>
  );
}
