import { useState } from "react";
import { Link } from "wouter";
import { FileDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { useTRPC } from "@/lib/trpc";
import {
  Badge, Button, DataTable, DateTime, Dialog, EmptyState, KeyValueList, PageHeader, StatusBadge, StepUpCancelledError,
  useStepUp, useToast, CodeBlock,
} from "@/ui";
import { AuditNav } from "./AuditNav";
import type { ExportView } from "./model";

const FORMAT_LABELS = { jsonl: "JSON Lines", csv: "CSV", cef: "CEF" } as const;
const EXTENSIONS = { jsonl: "jsonl", csv: "csv", cef: "cef" } as const;

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export const downloadable = (row: ExportView): boolean => row.status === "completed" && !row.expired && row.byteSize !== null;

export function ExportsTable({ rows, loading, error, onRetry, onDownload, onDetails, downloading }: {
  rows: readonly ExportView[] | undefined; loading: boolean; error: unknown; onRetry: () => void;
  onDownload: (row: ExportView) => void; onDetails: (row: ExportView) => void; downloading: string | null;
}) {
  return (
    <DataTable
      caption="Audit exports"
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(r) => r.id}
      empty={<EmptyState icon={FileDown} title="No exports yet" description="Start an export from the Events page. Files are kept for 7 days." action={<Button asChild variant="secondary"><Link href="/admin/audit">Go to events</Link></Button>} />}
      columns={[
        { key: "created", header: "Requested", primary: true, cell: (r) => <DateTime value={r.createdAt} format="datetime" /> },
        { key: "status", header: "Status", cell: (r) => (r.expired ? <Badge>Expired</Badge> : <StatusBadge state={r.status} />) },
        { key: "format", header: "Format", cell: (r) => `${FORMAT_LABELS[r.format]} · ${r.profile === "external" ? "for sharing" : "internal only"}` },
        { key: "rows", header: "Rows", align: "end", cell: (r) => (r.rowCount === null ? "—" : `${r.rowCount.toLocaleString()}${r.truncated ? " (limit reached)" : ""}`) },
        { key: "size", header: "Size", align: "end", hideOnMobile: true, cell: (r) => formatBytes(r.byteSize) ?? "—" },
        { key: "reason", header: "Reason", hideOnMobile: true, cell: (r) => (r.reasonCode ? <code className="text-xs break-all">{r.reasonCode}</code> : null) },
      ]}
      rowActions={(r) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => onDetails(r)} aria-label={`Details for export requested ${r.createdAt}`}>Details</Button>
          {downloadable(r) ? <Button size="sm" variant="secondary" loading={downloading === r.id} onClick={() => onDownload(r)} aria-label={`Download export requested ${r.createdAt}`}>Download</Button> : null}
        </div>
      )}
    />
  );
}

async function isStepUpResponse(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 401) return false;
  const body = (await response.clone().json().catch(() => null)) as { safe?: { domainCode?: unknown } } | null;
  return body?.safe?.domainCode === "STEP_UP_REQUIRED";
}

export default function ExportsPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const list = useQuery({
    ...trpc.audit.exports.list.queryOptions(),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "queued" || r.status === "running") ? 5000 : false),
  });
  const [downloading, setDownloading] = useState<string | null>(null);
  const [details, setDetails] = useState<ExportView | null>(null);

  const download = async (row: ExportView) => {
    setDownloading(row.id);
    try {
      const url = apiUrl(`/api/audit/exports/${encodeURIComponent(row.id)}/download`);
      let response = await sessionFetch(url, { cache: "no-store" });
      if (await isStepUpResponse(response)) {
        const ok = await stepUp.request({ reason: "Downloading audit evidence requires a fresh confirmation." });
        if (!ok) throw new StepUpCancelledError();
        response = await sessionFetch(url, { cache: "no-store" });
      }
      if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) {
        toast.show({ title: "Download not available", description: "The export could not be authorized or has expired. Refresh and try again.", tone: "danger" });
        return;
      }
      const blob = await response.blob();
      if (blob.size !== row.byteSize) {
        toast.show({ title: "Incomplete download", description: "The file size does not match the export manifest. Do not rely on this copy.", tone: "danger" });
        return;
      }
      const href = URL.createObjectURL(blob);
      try {
        const trigger = document.createElement("a");
        trigger.href = href;
        trigger.download = `audit-export-${row.id}.${EXTENSIONS[row.format]}`;
        document.body.append(trigger);
        try { trigger.click(); } finally { trigger.remove(); }
      } finally {
        setTimeout(() => URL.revokeObjectURL(href), 0);
      }
      toast.show({ title: "Download started", description: "Compare the file's SHA-256 with the value in Details.", tone: "success" });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) toast.show({ title: "Download failed", description: "The connection was interrupted. Try again.", tone: "danger" });
    } finally {
      setDownloading(null);
    }
  };

  return (
    <>
      <PageHeader title="Audit exports" description="Evidence files generated from sealed audit events. Each file has a manifest and SHA-256 digest." />
      <AuditNav />
      <ExportsTable rows={list.data} loading={list.isPending} error={list.error} onRetry={() => list.refetch()} onDownload={download} onDetails={setDetails} downloading={downloading} />
      <Dialog open={details !== null} onOpenChange={(o) => !o && setDetails(null)} title="Export details" size="lg">
        {details ? <ExportDetails row={details} /> : null}
      </Dialog>
    </>
  );
}

export function ExportDetails({ row }: { row: ExportView }) {
  const m = row.manifest;
  return (
    <div className="space-y-4">
      <KeyValueList columns={2} items={[
        { label: "Status", value: row.expired ? "Expired" : <StatusBadge state={row.status} /> },
        { label: "Completeness", value: m ? (m.completeness === "complete" ? "Complete" : "Truncated at the row limit") : null },
        { label: "Rows", value: row.rowCount?.toLocaleString() ?? null },
        { label: "Size", value: formatBytes(row.byteSize) },
        { label: "Snapshot", value: m ? <span>Sealed through #{m.chain_head_seq.toLocaleString()}, cut off <DateTime value={m.snapshot_cutoff} format="datetime" /></span> : null, wide: true },
        { label: "SHA-256", value: row.sha256 ? <code className="text-xs break-all">{row.sha256}</code> : null, wide: true },
        { label: "Expires", value: row.expiresAt ? <DateTime value={row.expiresAt} format="datetime" /> : null },
        { label: "Downloads", value: row.downloadCount.toLocaleString() },
      ]} />
      {m ? <CodeBlock label="Export manifest as JSON" copyable wrap>{JSON.stringify(m, null, 2)}</CodeBlock> : null}
    </div>
  );
}
