import { useEffect, useRef, useState } from "react";
import { Download, FileText, MoreHorizontal } from "lucide-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import type { FileRecord, UploadIntent } from "@server/modules/files/index";
import { orderDocumentEditHref } from "@/lib/docconvert";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, Dialog, DropdownMenu,
  EmptyState, Field, IconButton, LoadMore, Section, Select, useToast,
} from "@/ui";
import { FileAudioDialog } from "./FileAudioDialog";
import { categoryLabels, FileUploadPanel, visibilityLabels } from "./FileUploadPanel";
import { OrderArchiveAction, PhaseArchiveAction } from "./archives/ArchiveAction";
import { PhaseUploadPanel } from "./PhaseFiles";
import { formatBytes } from "./format";
import { saveFileBlob } from "./fileDownload";
import { audioFileExtensions } from "./recordingDevice";

type Props = { orderId: string; area: "customer" | "console" };
type FileAction = { file: FileRecord; kind: "remove" | "restore" | "visibility" };
type LibraryGroup = { category: string; visibility: string; items: FileRecord[] };

const descriptions = {
  remove: "This version will stop being available to order readers. Staff may restore it until the retention window closes.",
  restore: "This version will become available again according to its existing visibility.",
  visibility: "Access will change immediately and previously issued download tickets will be invalidated.",
};
const intentChoices = [
  { value: "document", label: "Upload documents" },
  { value: "recording", label: "Record audio" },
  { value: "prerecorded_audio", label: "Upload prerecorded audio" },
] satisfies Array<{ value: UploadIntent; label: string }>;

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
  const search = useSearch();
  const params = new URLSearchParams(search);
  const requestedSlot = params.get("slot") ?? "";
  const [slotSelection, setSlotSelection] = useState<{ search: string; key: string } | null>(null);
  const panelHeading = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState<FileRecord | null>(null);
  const [uploadPhaseKey, setUploadPhaseKey] = useState("");
  const [intent, setIntent] = useState<UploadIntent>("document");
  const list = useInfiniteQuery(trpc.files.list.infiniteQueryOptions(
    { orderId, limit: 25, includeVersions: versions, includeDeleted: consoleArea && trash },
    { getNextPageParam: (page) => page.nextCursor,
      refetchInterval: (query) => query.state.data?.pages.some((page) => page.items.some((file) => file.conversionState === "converting")) ? 5000 : false },
  ));
  const visibility = useMutation(trpc.files.setVisibility.mutationOptions());
  const remove = useMutation(trpc.files.remove.mutationOptions());
  const restore = useMutation(trpc.files.restore.mutationOptions());
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const first = list.data?.pages[0];
  const phases = first?.phases ?? [];
  const uploadPhase = phases.find((phase) => phase.key === (uploadPhaseKey || first?.currentStageKey)) ?? phases.at(-1);
  const groupedRows = new Map<string, Map<string, LibraryGroup>>();
  const knownPhases = new Set(phases.map(({ key }) => key));
  for (const file of rows) {
    const phaseKey = file.groupStageKey ?? file.stageKey ?? "";
    const phase = knownPhases.has(phaseKey) ? phaseKey : "";
    const groupKey = `${file.category}:${file.visibility}`;
    const phaseGroups = groupedRows.get(phase) ?? new Map<string, LibraryGroup>();
    const group = phaseGroups.get(groupKey) ?? {
      category: categoryLabels[file.category], visibility: visibilityLabels[file.visibility], items: [],
    };
    group.items.push(file);
    phaseGroups.set(groupKey, group);
    groupedRows.set(phase, phaseGroups);
  }
  const groups = phases.length ? [...phases, { key: "", label: "Other order files" }].flatMap((phase) => {
    const items = [...(groupedRows.get(phase.key)?.entries() ?? [])].sort(([, a], [, b]) =>
      a.category.localeCompare(b.category) || a.visibility.localeCompare(b.visibility));
    return items.length ? [{ ...phase, items }] : [];
  }) : [];
  const policy = first?.uploadPolicy;
  const slots = first?.uploadSlots;
  const uploadSlots = slots?.slots.filter((slot) => slot.acceptsUpload !== false) ?? [];
  const activeSlot = slotSelection?.search === search ? slotSelection.key : requestedSlot;
  const chosenSlot = uploadSlots.find((slot) => slot.key === activeSlot);
  const routedSlot = !!chosenSlot && requestedSlot === chosenSlot.key && slotSelection?.search !== search;
  const launchRecording = routedSlot && params.get("mode") === "record" && first?.audio?.enabled === true &&
    chosenSlot.kind === "audio" && chosenSlot.capture !== "upload" && audioFileExtensions.some((ext) =>
      policy?.extensions.includes(ext) && (!chosenSlot.allowedTypes.length || chosenSlot.allowedTypes.includes(ext)));
  useEffect(() => {
    if (routedSlot && !launchRecording) panelHeading.current?.focus();
  }, [routedSlot, launchRecording, requestedSlot]);
  const replacementSlot = replacement?.slotKey && slots?.statusKey === replacement.statusKey
    ? slots?.slots.find((slot) => slot.key === replacement.slotKey) : undefined;
  const canChange = first?.canUpload === true;
  const reload = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.files.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) }),
    ]);
  };

  async function readBlob(file: FileRecord, signal?: AbortSignal) {
    // Keep the one-time bearer ticket out of the client query/mutation caches.
    const { ticket } = await api.files.issueDownloadTicket.mutate({ fileId: file.publicId });
    const response = await sessionFetch(apiUrl("/api/files/download"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }), cache: "no-store", signal,
    });
    if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) return null;
    return response.blob();
  }

  async function download(file: FileRecord) {
    if (downloading) return;
    setDownloading(file.publicId);
    try {
      const blob = await readBlob(file);
      if (!blob) {
        toast.show({ title: "Download not available", description: "The request could not be authorized or completed. Refresh this order and try again.", tone: "danger" });
        return;
      }
      if (blob.size !== file.size) {
        toast.show({ title: "Incomplete download", description: "The server did not return the expected file size.", tone: "danger" });
        return;
      }
      saveFileBlob(blob, file.displayName);
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

  function fileTable(items: FileRecord[], caption: string) {
    return <DataTable<FileRecord>
              caption={caption}
              rowKey={(file) => file.publicId}
              rows={list.isPending ? undefined : items} loading={list.isPending} error={list.error} onRetry={() => { void list.refetch(); }}
              empty={<EmptyState icon={FileText} title="No files to show" description="Uploaded documents and deliverables will appear here when you have access to them." headingLevel={3} />}
              columns={[
                { key: "name", header: "File name", primary: true, cell: (file) => <div className="min-w-0">
                  <span className="block break-all font-medium text-ink">{file.displayName}</span>
                  <span className="text-sm text-muted">{file.extension.toUpperCase()} · {formatBytes(file.size)}</span>
                  {file.conversionState ? <span className="block text-sm text-body">
                    {file.conversionState === "converting" ? "Re-encoding to WebM/Opus. Original kept." : file.conversionState === "converted" ? "Original audio. WebM/Opus copy available." :
                      file.conversionReason === "AUDIO_CONVERSION_DISABLED" ? "Re-encoding is off. Original kept." :
                        file.conversionReason === "AUDIO_CONVERSION_UNAVAILABLE" ? "Re-encoding unavailable. Original kept." : "Re-encoding failed. Original kept."}
                  </span> : null}
                  {file.derivedFromPublicId ? <span className="block text-sm text-body">WebM/Opus audio</span> : null}
                </div> },
                { key: "category", header: "Category", cell: (file) => <div className="min-w-0">
                  <span>{categoryLabels[file.category]}</span>
                  {file.statusKey ? <span className="block break-all text-sm text-muted">Status: {file.statusKey.replace(/[_-]/gu, " ")}</span> : null}
                  {file.slotKey ? <span className="block break-all text-sm text-muted">Slot: {slots?.slots.find((slot) => slot.key === file.slotKey)?.label ?? file.slotKey.replace(/[_-]/gu, " ")}</span> : null}
                </div> },
                { key: "visibility", header: "Visibility", cell: (file) => <Badge tone={file.visibility === "staff_only" ? "warning" : "neutral"}>{visibilityLabels[file.visibility]}</Badge> },
                { key: "version", header: "Version", cell: (file) => <span className="tabular-nums">v{file.version}{file.deletedAt ? " · Trash" : file.supersededAt ? " · Previous" : ""}</span> },
                { key: "created", header: "Uploaded", hideOnMobile: true, cell: (file) => <DateTime value={file.createdAt} format="date" /> },
              ]}
              rowActions={(file) => {
                const canReplace = canChange && !!policy?.extensions.length && !file.deletedAt && !file.supersededAt && !file.derivedFromPublicId &&
                  (!first?.stageUploadsRequired || !!file.stageKey) &&
                  (consoleArea || file.category !== "deliverable") && (!file.slotKey || (!!slots?.slots.some((slot) => slot.key === file.slotKey) && file.statusKey === slots?.statusKey));
                const staffActions = consoleArea && canChange && !file.derivedFromPublicId;
                return <div className="flex flex-wrap items-center gap-1">
                  {!file.deletedAt ? <Button size="sm" variant="secondary" leadingIcon={<Download aria-hidden />} aria-disabled={!!downloading || undefined}
                    loading={downloading === file.publicId} onClick={() => { void download(file); }} aria-label={`Download ${file.displayName}`}>Download</Button> : null}
                  {!file.deletedAt && !file.supersededAt && file.contentType.startsWith("audio/") ?
                    <Button size="sm" variant="secondary" onClick={() => setPlaying(file)} aria-label={`Listen to ${file.displayName}`}>Listen</Button> : null}
                  {!file.deletedAt && !file.supersededAt && file.extension === "docx" ? <Button asChild size="sm" variant="secondary">
                    <Link href={orderDocumentEditHref(orderId, file.publicId, { area })}>Edit document<span className="sr-only">: {file.displayName}</span></Link>
                  </Button> : null}
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
            />;
  }

  return (
    <Section title="Order files" description="View order documents, supporting evidence, and deliverables. Downloads are limited to your current access.">
      <div className="grid min-w-0 gap-5">
        {canChange && policy ? <Card title={<span tabIndex={-1} ref={panelHeading}>
          {chosenSlot?.label ?? (consoleArea ? "Add an order file" : "Upload supporting files")}
        </span>} headingLevel={3}
          description={consoleArea ? "Staff may add deliverables and choose who can see them." : "Add documents requested by your ReadyPackets team."}>
          <div className="grid min-w-0 gap-4">
            {uploadSlots.length ? <Field label="Upload to" hint="Choose a workflow requirement or add a file to a phase.">
              <Select value={chosenSlot?.key ?? ""} onChange={(event) => setSlotSelection({ search, key: event.target.value })}
                options={[{ value: "", label: first.stageUploadsRequired ? "Phase files" : "General order files" },
                  ...uploadSlots.map((slot) => ({ value: slot.key, label: slot.label }))]} />
            </Field> : null}
            {first.stageUploadsRequired && chosenSlot && !first.currentStageKey
              ? <p className="text-sm text-body">No current phase is available for this requirement.</p>
              : first.stageUploadsRequired && !chosenSlot ? uploadPhase ? <>
              <Field label="Upload phase">
                <Select value={uploadPhase.key} onChange={(event) => setUploadPhaseKey(event.target.value)}
                  options={phases.map((phase) => ({ value: phase.key, label: phase.label }))} />
              </Field>
              <Field label="Upload action">
                <Select value={intent} onChange={(event) => setIntent(event.target.value as UploadIntent)} options={intentChoices} />
              </Field>
              <PhaseUploadPanel key={`${uploadPhase.key}:${intent}`} orderId={orderId} stageKey={uploadPhase.key}
                intent={intent} staff={consoleArea} onChanged={reload} />
            </> : <p className="text-sm text-body">No phase currently accepts files.</p> :
              <FileUploadPanel key={`${slots?.statusKey ?? ""}:${chosenSlot?.key ?? ""}:${launchRecording ? "record" : "files"}`}
                orderId={orderId} staff={consoleArea} policy={policy}
                slot={chosenSlot && slots ? { ...chosenSlot, statusKey: slots.statusKey } : undefined}
                phase={first.stageUploadsRequired && chosenSlot && first.currentStageKey ? { key: first.currentStageKey } : undefined}
                audio={first.audio} launchRecording={launchRecording} onChanged={reload} />}
          </div>
        </Card> : first ? <Callout tone="info" title="File changes unavailable">
          Your access or the order’s current state does not allow file changes.
        </Callout> : null}
        <Card title="File library" headingLevel={3} description="Current versions appear by default. Include previous versions to see file history."
          actions={consoleArea && first?.canArchiveOrder ? <OrderArchiveAction orderId={orderId} /> : undefined}>
          <div className="grid min-w-0 gap-3">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Checkbox label="Include previous versions" checked={versions} onCheckedChange={setVersions} />
              {consoleArea ? <Checkbox label="Include trash" checked={trash} onCheckedChange={setTrash} /> : null}
            </div>
            {groups.length && !list.isError ? groups.map((group) => <div key={group.key} className="grid min-w-0 gap-2">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <h4 className="min-w-0 break-words text-base font-semibold text-ink">{group.label}</h4>
                {group.key ? <PhaseArchiveAction orderId={orderId} stageKey={group.key} phaseName={group.label} /> : null}
              </div>
              {group.items.map(([key, section]) => <div key={key} className="grid min-w-0 gap-2 pb-2">
                <h5 className="break-words text-sm font-medium text-body">{section.category} · {section.visibility}</h5>
                {fileTable(section.items.sort((a, b) => a.logicalPublicId.localeCompare(b.logicalPublicId) || b.version - a.version),
                  `${group.label}: ${section.category}, ${section.visibility}`)}
              </div>)}
            </div>) : fileTable(rows, "Files for this order")}
            <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => { void list.fetchNextPage(); }}
              summary={rows.length ? `Showing ${rows.length} ${rows.length === 1 ? "file" : "files"}` : undefined} />
          </div>
        </Card>
      </div>
      <Dialog title="Upload a new version" description={replacement ? `Choose a replacement for ${replacement.displayName}. Earlier versions remain in file history.` : undefined}
        open={!!replacement} onOpenChange={(open) => { if (!open) setReplacement(null); }}>
        {replacement && policy && (!first?.stageUploadsRequired || replacement.stageKey)
          ? <FileUploadPanel key={replacement.publicId} orderId={orderId} staff={consoleArea} policy={policy} onChanged={reload}
          audio={first?.audio} slot={replacementSlot && slots ? { ...replacementSlot, statusKey: slots.statusKey } : undefined}
          phase={replacement.stageKey ? { key: replacement.stageKey,
            intent: replacementSlot ? undefined : replacement.contentType.startsWith("audio/") ? "prerecorded_audio" : "document" } : undefined}
          replace={{ id: replacement.publicId, category: replacement.category, visibility: replacement.visibility }} /> : null}
      </Dialog>
      <FileAudioDialog orderId={orderId} file={playing} onClose={() => setPlaying(null)} />
      <ConfirmDialog open={!!action} onOpenChange={(open) => { if (!open) setAction(null); }}
        title={action?.kind === "remove" ? "Move file to trash?" : action?.kind === "restore" ? "Restore this file?" : "Change file visibility?"}
        description={action ? `${descriptions[action.kind]} File: ${action.file.displayName}` : undefined}
        confirmLabel={action?.kind === "remove" ? "Move to trash" : action?.kind === "restore" ? "Restore file" : "Change visibility"}
        destructive={action?.kind === "remove"} onConfirm={perform} />
    </Section>
  );
}
