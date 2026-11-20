import { useQuery } from "@tanstack/react-query";
import { Archive, Download, Upload } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Button, Callout, Card, DataTable, DateTime, EmptyState, FileDropzone, PageHeader, Section, StatusBadge,
  StepUpCancelledError, Tabs, useStepUp,
} from "@/ui";
import { describeReason, PHASE_NAMES } from "../format";
import { downloadPackage, uploadPackage } from "../raw";

export default function Transfers() {
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const [, navigate] = useLocation();
  const [exportPages, setExportPages] = useState<string[]>([]);
  const [importPages, setImportPages] = useState<string[]>([]);
  const [view, setView] = useState("exports");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean }>();
  const exports = useQuery(trpc.portable.admin.listExports.queryOptions({ limit: 20, cursor: exportPages.at(-1) }, {
    refetchInterval: (query) => query.state.data?.items.some(({ state }) => state === "queued" || state === "running") ? 5_000 : false,
  }));
  const imports = useQuery(trpc.portable.admin.listImports.queryOptions({ limit: 20, cursor: importPages.at(-1) }, {
    refetchInterval: (query) => query.state.data?.items.some(({ phase }) =>
      ["received", "approved", "objects-prepared", "records-committed", "finalized"].includes(phase)) ? 5_000 : false,
  }));

  async function upload() {
    if (!file || busy) return;
    setBusy("upload");
    setFeedback(undefined);
    try {
      const id = await stepUp.run(() => uploadPackage(file), { reason: "Verify your identity before uploading a business transfer." });
      await imports.refetch();
      navigate(`/admin/portable/import/${id}`);
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        setFeedback({ text: errorMessage(error, "The upload receipt is unavailable. Refresh the imports list before uploading again."), error: true });
      }
    } finally { setBusy(null); }
  }

  async function download(id: string) {
    if (busy) return;
    setBusy(id);
    setFeedback(undefined);
    try {
      await stepUp.run(() => downloadPackage(id), { reason: "Verify your identity before downloading encrypted business data." });
      setFeedback({ text: "The package was sent to your browser. Check your downloads before relying on it.", error: false });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) setFeedback({ text: errorMessage(error, "The download did not complete."), error: true });
    } finally { setBusy(null); }
  }

  const exportsContent = (
    <Section title="Export history" description="Download encrypted packages while their private retention window is open.">
      <DataTable caption="Portable exports" rowKey={(row) => row.exportId} rows={exports.data?.items}
        loading={exports.isPending} error={exports.error} onRetry={() => exports.refetch()}
        empty={<EmptyState icon={Archive} title="No exports yet" description="Create an encrypted package to move selected customer and order records." />}
        columns={[
          { key: "created", header: "Requested", primary: true, cell: (row) => <DateTime value={row.createdAt} /> },
          { key: "scope", header: "Selection", cell: (row) => row.selection === "all" ? "All records" : `Selected ${row.selection}` },
          { key: "status", header: "Outcome", cell: (row) => <div className="space-y-1">
            <StatusBadge state={row.state} />
            {row.expired ? <p className="text-sm text-muted">Download expired</p> : null}
            {row.reasonCode ? <p className="text-sm text-muted">{describeReason(row.reasonCode)}</p> : null}
          </div> },
          { key: "retention", header: "Expires", cell: (row) => <DateTime value={row.expiresAt} /> },
          { key: "checksum", header: "Ciphertext SHA-256", hideOnMobile: true, cell: (row) => row.sha256
            ? <code className="block max-w-44 break-all text-xs">{row.sha256}</code> : "Not available" },
        ]}
        rowActions={(row) => row.state === "completed" && !row.expired
          ? <Button variant="secondary" size="sm" leadingIcon={Download} loading={busy === row.exportId}
            disabled={busy !== null && busy !== row.exportId} onClick={() => { void download(row.exportId); }}>Download</Button>
          : null}
      />
      <Pager pages={exportPages} next={exports.data?.nextCursor} setPages={setExportPages} name="export list" />
    </Section>
  );
  const importsContent = (<>
    <Card title="Upload a package" description="The upload is quarantined. It cannot create or change business records.">
      <div className="max-w-2xl space-y-3">
        <FileDropzone label="Choose a transfer package" accept=".rpkg,.rptransfer" maxSize={192 * 1024 * 1024}
          onFiles={(items) => setFile(items[0])} disabled={busy !== null} hint="One file. Maximum 192 MiB; older formats may have lower limits." />
        {file ? <p className="break-all text-sm text-body">Selected: {file.name}</p> : null}
        <Button leadingIcon={Upload} disabled={!file || busy !== null} loading={busy === "upload"} onClick={() => { void upload(); }}>
          Upload to quarantine
        </Button>
      </div>
    </Card>
    <Section title="Import history" description="Review plans, progress, reconciliation, and held records.">
      <DataTable caption="Portable imports" rowKey={(row) => row.importId} rows={imports.data?.items}
        loading={imports.isPending} error={imports.error} onRetry={() => imports.refetch()}
        empty={<EmptyState icon={Upload} title="No imports yet" description="Upload a package to verify it and review the proposed changes." />}
        columns={[
          { key: "created", header: "Submitted", primary: true, cell: (row) => <DateTime value={row.createdAt} /> },
          { key: "checkpoint", header: "Checkpoint", cell: (row) => PHASE_NAMES[row.phase] },
          { key: "state", header: "Outcome", cell: (row) => <StatusBadge state={row.state} /> },
          { key: "count", header: "Plan conflicts", cell: (row) => row.plan?.counts.conflicts ?? "Not planned" },
        ]}
        rowActions={(row) => <Button asChild variant="secondary" size="sm">
          <Link href={`/admin/portable/import/${row.importId}`}>Open import<span className="sr-only"> {row.importId}</span></Link>
        </Button>}
      />
      <Pager pages={importPages} next={imports.data?.nextCursor} setPages={setImportPages} name="import list" />
    </Section>
  </>);
  return (
    <div className="space-y-6">
      <PageHeader title="Portable transfer" description="Move approved business data between ReadyPackets installations."
        actions={<Button asChild><Link href="/admin/portable/export/new">New export</Link></Button>} />
      <Callout tone="info" title="Business transfer, not a full backup">
        Packages exclude passwords, MFA, sessions, secrets, and runtime configuration. Keep original packages and passphrases in separate secure locations.
      </Callout>
      {feedback ? <Callout tone={feedback.error ? "danger" : "success"} live={feedback.error ? "assertive" : "polite"}>
        {feedback.text}
      </Callout> : null}
      <Tabs label="Transfer type" value={view} onValueChange={setView} items={[
        { value: "exports", label: "Exports", content: exportsContent },
        { value: "imports", label: "Imports", content: <div className="space-y-5">{importsContent}</div> },
      ]} />
    </div>
  );
}

function Pager({ pages, next, setPages, name }: {
  pages: string[]; next?: string | null; setPages: (pages: string[]) => void; name: string;
}) {
  if (!pages.length && !next) return null;
  return <nav aria-label={`Pages for ${name}`} className="flex flex-wrap gap-2">
    <Button variant="ghost" disabled={!pages.length} onClick={() => setPages(pages.slice(0, -1))}>Previous page</Button>
    <Button variant="secondary" disabled={!next} onClick={() => { if (next) setPages([...pages, next]); }}>Next page</Button>
  </nav>;
}
