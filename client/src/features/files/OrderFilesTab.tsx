import { useEffect, useRef, useState } from "react";
import { Download, FileText, MoreHorizontal } from "lucide-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import type { FileRecord } from "@server/modules/files/index";
import { orderDocumentEditHref } from "@/lib/docconvert";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, Dialog, DropdownMenu,
  EmptyState, Field, IconButton, LoadMore, Section, Select, useToast,
} from "@/ui";
import { formatDuration } from "./AudioRecorder";
import { categoryLabels, FileUploadPanel, visibilityLabels } from "./FileUploadPanel";
import { formatBytes } from "./format";
import { audioFileExtensions } from "./recordingDevice";

type Props = { orderId: string; area: "customer" | "console" };
type FileAction = { file: FileRecord; kind: "remove" | "restore" | "visibility" };

const descriptions = {
  remove: "This version will stop being available to order readers. Staff may restore it until the retention window closes.",
  restore: "This version will become available again according to its existing visibility.",
  visibility: "Access will change immediately and previously issued download tickets will be invalidated.",
};

function AudioPlayback({ file, load }: { file: FileRecord; load: (signal: AbortSignal) => Promise<{ blob: Blob; transcript: string | null }> }) {
  const [duration, setDuration] = useState(file.durationSeconds);
  const [state, setState] = useState<{ url: string; transcript: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => () => { if (state) URL.revokeObjectURL(state.url); }, [state]);

  async function openAudio() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNotice(null);
    try {
      const { blob, transcript } = await load(controller.signal);
      if (!controller.signal.aborted) setState({ url: URL.createObjectURL(blob), transcript });
    } catch {
      if (!controller.signal.aborted) setNotice("The recording could not be loaded. Check your access or download the original from the file list.");
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="grid min-w-0 gap-3">
    {!state ? <div><Button loading={busy} onClick={() => { void openAudio(); }}>Load audio and transcript</Button></div> : <>
      <p className="text-sm text-body">Duration: {duration === null ? "Not available" : formatDuration(duration)}</p>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Audio-only content exposes the provided transcript alongside the player. */}
      <audio controls preload="metadata" className="w-full min-w-0" aria-label={`Play ${file.displayName}`} src={state.url}
        onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
        onError={() => setNotice("This format could not be played in your browser. You can download the original from the file list.")} />
      <p className="font-medium text-ink">Transcript</p>
      <p className="whitespace-pre-wrap break-words text-sm text-body">{state.transcript || "No transcript was supplied."}</p>
    </>}
    {notice ? <Callout tone="warning" title="Audio playback notice" live="polite">{notice}</Callout> : null}
  </div>;
}

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
        {canChange && policy ? <Card title={<span tabIndex={-1} ref={panelHeading}>
          {chosenSlot?.label ?? (consoleArea ? "Add an order file" : "Upload supporting files")}
        </span>} headingLevel={3}
          description={consoleArea ? "Staff may add deliverables and choose who can see them." : "Add documents requested by your ReadyPackets team."}>
          <div className="grid min-w-0 gap-4">
            {uploadSlots.length ? <Field label="Upload to" hint="Choose a workflow requirement, or add a general file that does not count toward a requirement.">
              <Select value={chosenSlot?.key ?? ""} onChange={(event) => setSlotSelection({ search, key: event.target.value })}
                options={[{ value: "", label: "General order files" }, ...uploadSlots.map((slot) => ({ value: slot.key, label: slot.label }))]} />
            </Field> : null}
            <FileUploadPanel key={`${slots?.statusKey ?? ""}:${chosenSlot?.key ?? ""}:${launchRecording ? "record" : "files"}`} orderId={orderId} staff={consoleArea} policy={policy}
              slot={chosenSlot && slots ? { ...chosenSlot, statusKey: slots.statusKey } : undefined} audio={first.audio} launchRecording={launchRecording} onChanged={reload} />
          </div>
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
                  (consoleArea || file.category !== "deliverable") && (!file.slotKey || (!!slots?.slots.some((slot) => slot.key === file.slotKey) && file.statusKey === slots?.statusKey));
                const staffActions = consoleArea && canChange && !file.derivedFromPublicId;
                return <div className="flex flex-wrap items-center gap-1">
                  {!file.deletedAt ? <Button size="sm" variant="secondary" leadingIcon={<Download aria-hidden />} disabled={!!downloading}
                    loading={downloading === file.publicId} onClick={() => { void download(file); }} aria-label={`Download ${file.displayName}`}>Download</Button> : null}
                  {!file.deletedAt && file.contentType.startsWith("audio/") ?
                    <Button size="sm" variant="secondary" onClick={() => setPlaying(file)} aria-label={`Listen to ${file.displayName}`}>Listen</Button> : null}
                  {!file.deletedAt && !file.supersededAt && file.extension === "docx" ? <Button asChild size="sm" variant="secondary">
                    <Link href={orderDocumentEditHref(orderId, file.publicId, { area })} aria-label={`Edit ${file.displayName}`}>Edit document</Link>
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
            />
            <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => { void list.fetchNextPage(); }}
              summary={rows.length ? `Showing ${rows.length} ${rows.length === 1 ? "file" : "files"}` : undefined} />
          </div>
        </Card>
      </div>
      <Dialog title="Upload a new version" description={replacement ? `Choose a replacement for ${replacement.displayName}. Earlier versions remain in file history.` : undefined}
        open={!!replacement} onOpenChange={(open) => { if (!open) setReplacement(null); }}>
        {replacement && policy ? <FileUploadPanel key={replacement.publicId} orderId={orderId} staff={consoleArea} policy={policy} onChanged={reload}
          audio={first?.audio} slot={replacementSlot && slots ? { ...replacementSlot, statusKey: slots.statusKey } : undefined}
          replace={{ id: replacement.publicId, category: replacement.category, visibility: replacement.visibility }} /> : null}
      </Dialog>
      <Dialog title="Listen to order audio" description={playing?.displayName} open={!!playing} onOpenChange={(open) => { if (!open) setPlaying(null); }}>
        {playing ? <AudioPlayback key={playing.publicId} file={playing} load={async (signal) => {
          const blob = await readBlob(playing, signal);
          if (!blob || blob.size !== playing.size) throw Error("Audio unavailable");
          const source = playing.derivedFromPublicId ?? playing.publicId;
          const { transcript } = await api.files.readTranscript.mutate({ fileId: source }, { signal });
          return { blob: new Blob([blob], { type: playing.contentType }), transcript };
        }} /> : null}
      </Dialog>
      <ConfirmDialog open={!!action} onOpenChange={(open) => { if (!open) setAction(null); }}
        title={action?.kind === "remove" ? "Move file to trash?" : action?.kind === "restore" ? "Restore this file?" : "Change file visibility?"}
        description={action ? `${descriptions[action.kind]} File: ${action.file.displayName}` : undefined}
        confirmLabel={action?.kind === "remove" ? "Move to trash" : action?.kind === "restore" ? "Restore file" : "Change visibility"}
        destructive={action?.kind === "remove"} onConfirm={perform} />
    </Section>
  );
}
