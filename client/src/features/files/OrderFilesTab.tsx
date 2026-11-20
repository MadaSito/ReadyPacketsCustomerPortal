import { useState } from "react";
import { Download, FileText, MoreHorizontal } from "lucide-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FileRecord } from "@server/modules/files/index";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, Dialog, DropdownMenu,
  EmptyState, IconButton, LoadMore, Section, useToast,
} from "@/ui";
import { categoryLabels, FileUploadPanel, visibilityLabels } from "./FileUploadPanel";
import { formatBytes } from "./format";

type Props = { orderId: string; area: "customer" | "console" };
type FileAction = { file: FileRecord; kind: "remove" | "restore" | "visibility" };

const descriptions = {
  remove: "This version will stop being available to order readers. Staff may restore it until the retention window closes.",
  restore: "This version will become available again according to its existing visibility.",
  visibility: "Access will change immediately and previously issued download tickets will be invalidated.",
};

export default function OrderFilesTab({ orderId, area }: Props) {
  const consoleArea = area === "console";
  const trpc = useTRPC();
  const api = useTRPCClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [versions, setVersions] = useState(false);
  const [trash, setTrash] = useState(false);
  const [replacement, setReplacement] = useState<FileRecord | null>(null);
  const [action, setAction] = useState<FileAction | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const list = useInfiniteQuery(trpc.files.list.infiniteQueryOptions(
    { orderId, limit: 25, includeVersions: versions, includeDeleted: consoleArea && trash },
    { getNextPageParam: (page) => page.nextCursor },
  ));
  const visibility = useMutation(trpc.files.setVisibility.mutationOptions());
  const remove = useMutation(trpc.files.remove.mutationOptions());
  const restore = useMutation(trpc.files.restore.mutationOptions());
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const first = list.data?.pages[0];
  const policy = first?.uploadPolicy;
  const canChange = first?.canUpload === true;
  const reload = async () => { await queryClient.invalidateQueries({ queryKey: trpc.files.list.pathKey() }); };

  async function download(file: FileRecord) {
    if (downloading) return;
    setDownloading(file.publicId);
    try {
      // Keep the one-time bearer ticket out of the client query/mutation caches.
      const { ticket } = await api.files.issueDownloadTicket.mutate({ fileId: file.publicId });
      const response = await sessionFetch(apiUrl("/api/files/download"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
        cache: "no-store",
      });
      if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) {
        toast.show({ title: "Download not available", description: "The request could not be authorized or completed. Refresh this order and try again.", tone: "danger" });
        return;
      }
      const blob = await response.blob();
      if (blob.size !== file.size) {
        toast.show({ title: "Incomplete download", description: "The server did not return the expected file size.", tone: "danger" });
        return;
      }
      const href = URL.createObjectURL(blob);
      try {
        const trigger = document.createElement("a");
        trigger.href = href;
        trigger.download = file.displayName;
        document.body.append(trigger);
        try { trigger.click(); } finally { trigger.remove(); }
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
      }
    } catch (error) {
      toast.show({ title: "Download not available", description: errorMessage(error, "The download could not be completed."), tone: "danger" });
    } finally {
      setDownloading(null);
    }
  }

  async function perform() {
    if (!action) return;
    const { file, kind } = action;
    try {
      if (kind === "visibility") {
        await visibility.mutateAsync({ fileId: file.publicId, visibility: file.visibility === "staff_only" ? "customer_visible" : "staff_only" });
      } else if (kind === "remove") await remove.mutateAsync({ fileId: file.publicId });
      else await restore.mutateAsync({ fileId: file.publicId });
      await reload();
      toast.show({ tone: "success", title: kind === "visibility" ? "Visibility updated" : kind === "remove" ? "Moved to trash" : "File restored" });
    } catch (error) {
      toast.show({ tone: "danger", title: "File change not confirmed", description: errorMessage(error, "Reload the order before trying again.") });
      throw error;
    }
  }

  return (
    <Section title="Order files" description="View order documents, supporting evidence, and deliverables. Downloads are limited to your current access.">
      <div className="grid min-w-0 gap-5">
        {canChange && policy ? <Card title={consoleArea ? "Add an order file" : "Upload supporting files"} headingLevel={3}
          description={consoleArea ? "Staff may add deliverables and choose who can see them." : "Add documents requested by your ReadyPackets team."}>
          <FileUploadPanel orderId={orderId} staff={consoleArea} policy={policy} onChanged={reload} />
        </Card> : first ? <Callout tone="info" title="File changes unavailable">
          Your access or the order’s current state does not allow file changes.
        </Callout> : null}
        <Card title="File library" headingLevel={3} description="Current versions appear by default. Include previous versions to see file history.">
          <div className="grid min-w-0 gap-3">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Checkbox label="Include previous versions" checked={versions} onCheckedChange={setVersions} />
              {consoleArea ? <Checkbox label="Include trash" checked={trash} onCheckedChange={setTrash} /> : null}
            </div>
            <DataTable<FileRecord>
              caption="Files for this order"
              rowKey={(file) => file.publicId}
              rows={rows} loading={list.isPending} error={list.error} onRetry={() => { void list.refetch(); }}
              empty={<EmptyState icon={FileText} title="No files to show" description="Uploaded documents and deliverables will appear here when you have access to them." headingLevel={3} />}
              columns={[
                { key: "name", header: "File name", primary: true, cell: (file) => <div className="min-w-0">
                  <span className="block break-all font-medium text-ink">{file.displayName}</span>
                  <span className="text-sm text-muted">{file.extension.toUpperCase()} · {formatBytes(file.size)}</span>
                </div> },
                { key: "category", header: "Category", cell: (file) => <div className="min-w-0">
                  <span>{categoryLabels[file.category]}</span>
                  {file.statusKey ? <span className="block break-all text-sm text-muted">Phase: {file.statusKey.replace(/[_-]/gu, " ")}</span> : null}
                </div> },
                { key: "visibility", header: "Visibility", cell: (file) => <Badge tone={file.visibility === "staff_only" ? "warning" : "neutral"}>{visibilityLabels[file.visibility]}</Badge> },
                { key: "version", header: "Version", cell: (file) => <span className="tabular-nums">v{file.version}{file.deletedAt ? " · Trash" : file.supersededAt ? " · Previous" : ""}</span> },
                { key: "created", header: "Uploaded", hideOnMobile: true, cell: (file) => <DateTime value={file.createdAt} format="date" /> },
              ]}
              rowActions={(file) => {
                const canReplace = canChange && !!policy?.extensions.length && !file.deletedAt && !file.supersededAt && (consoleArea || file.category !== "deliverable");
                const staffActions = consoleArea && canChange;
                return <div className="flex flex-wrap items-center gap-1">
                  {!file.deletedAt ? <Button size="sm" variant="secondary" leadingIcon={<Download aria-hidden />} disabled={!!downloading}
                    loading={downloading === file.publicId} onClick={() => { void download(file); }} aria-label={`Download ${file.displayName}`}>Download</Button> : null}
                  {canReplace || staffActions ? <DropdownMenu
                    trigger={<IconButton variant="ghost" label={`Actions for ${file.displayName}`} icon={<MoreHorizontal aria-hidden />} />}
                    items={[
                      ...(canReplace ? [{ label: "Upload new version", onSelect: () => setReplacement(file) }] : []),
                      ...(staffActions && !file.deletedAt ? [
                        { label: file.visibility === "staff_only" ? "Make customer-visible" : "Make staff only", onSelect: () => setAction({ file, kind: "visibility" }) },
                        { label: "Move to trash", destructive: true, onSelect: () => setAction({ file, kind: "remove" }) },
                      ] : []),
                      ...(staffActions && file.deletedAt ? [{ label: "Restore file", onSelect: () => setAction({ file, kind: "restore" }) }] : []),
                    ]}
                  /> : null}
                </div>;
              }}
            />
            <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => { void list.fetchNextPage(); }}
              summary={rows.length ? `Showing ${rows.length} ${rows.length === 1 ? "file" : "files"}` : undefined} />
          </div>
        </Card>
      </div>
      <Dialog title="Upload a new version" description={replacement ? `Choose a replacement for ${replacement.displayName}. Earlier versions remain in file history.` : undefined}
        open={!!replacement} onOpenChange={(open) => { if (!open) setReplacement(null); }}>
        {replacement && policy ? <FileUploadPanel key={replacement.publicId} orderId={orderId} staff={consoleArea} policy={policy} onChanged={reload}
          replace={{ id: replacement.publicId, category: replacement.category, visibility: replacement.visibility }} /> : null}
      </Dialog>
      <ConfirmDialog open={!!action} onOpenChange={(open) => { if (!open) setAction(null); }}
        title={action?.kind === "remove" ? "Move file to trash?" : action?.kind === "restore" ? "Restore this file?" : "Change file visibility?"}
        description={action ? `${descriptions[action.kind]} File: ${action.file.displayName}` : undefined}
        confirmLabel={action?.kind === "remove" ? "Move to trash" : action?.kind === "restore" ? "Restore file" : "Change visibility"}
        destructive={action?.kind === "remove"} onConfirm={perform} />
    </Section>
  );
}
