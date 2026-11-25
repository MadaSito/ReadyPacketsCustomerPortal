import { useState } from "react";
import { Download } from "lucide-react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileRecord, UploadIntent } from "@server/modules/files/index";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { Button, Callout, LoadMore } from "@/ui";
import { FileUploadPanel, type FileUploadPanelProps } from "./FileUploadPanel";
import { formatAudioTimeRemaining, formatBytes } from "./format";
import { saveFileBlob } from "./fileDownload";

const disabledMessages: Record<string, string> = {
  STAGE_ACTION_OFF: "This phase does not use this upload action.",
  STAGE_LOCKED: "This phase is locked for changes.",
  STAGE_NOT_OPEN: "This phase is not open for changes.",
  ORDER_LOCKED: "This order is locked for file changes.",
  ORDER_ACCEPTANCE_REQUIRED: "Accept the order’s required policy before adding files.",
  RECORDING_DISABLED: "Recording is currently disabled.",
  FILE_TYPE_DISABLED: "No approved formats are currently available for this action.",
  PHASE_CAPACITY_REACHED: "This phase has reached its limit for this type of file.",
};

type PhaseUploadProps = {
  orderId: string; stageKey: string; intent: UploadIntent; staff?: boolean;
  onChanged?: FileUploadPanelProps["onChanged"];
  /** Counts selected files still awaiting a definitive result; reports zero when the form unmounts. */
  onPendingChange?: FileUploadPanelProps["onPendingChange"];
  readOnly?: boolean;
};

export function PhaseUploadPanel({ readOnly, ...props }: PhaseUploadProps) {
  return readOnly ? <PhaseReadOnlyFiles orderId={props.orderId} stageKey={props.stageKey} intent={props.intent} /> : <PhaseUploadForm {...props} />;
}

function PhaseUploadForm({ orderId, stageKey, intent, staff = false, onPendingChange, onChanged }: PhaseUploadProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phase = useQuery(trpc.files.phasePolicy.queryOptions({ orderPublicId: orderId, stageKey, intent }, { retry: false }));
  if (phase.isPending) return <p role="status" className="text-sm text-body">Checking phase upload limits…</p>;
  if (!phase.data) return <Callout tone="warning" title="Upload settings unavailable">
    <Button variant="secondary" onClick={() => { void phase.refetch(); }}>Retry settings check</Button>
  </Callout>;
  if (!phase.data.enabled && phase.data.disabledReason !== "PHASE_CAPACITY_REACHED") {
    return <Callout tone="info" title="Upload unavailable">
      {disabledMessages[phase.data.disabledReason ?? ""] ?? "Your access or the current phase state does not allow this action."}
    </Callout>;
  }
  const { maxSeconds, policy, remainingAudio, remainingAudioSeconds, remainingDocuments } = phase.data;
  const available = intent === "document" ? remainingDocuments : remainingAudio;
  // Keep the form mounted after a successful final upload so the user keeps the result and focus.
  const maxFiles = Math.min(available ?? policy.maxFiles, policy.maxFiles);
  return <div className="grid min-w-0 gap-4">
    {available !== null ? <p className="text-sm text-body">
      {available} {available === 1 ? "file" : "files"} remaining{remainingAudioSeconds !== null && intent !== "document"
        ? ` · ${formatAudioTimeRemaining(remainingAudioSeconds)} of audio remaining` : ""}
    </p> : null}
    {phase.data.disabledReason === "PHASE_CAPACITY_REACHED" ? <Callout tone="info" title="Phase limit reached">
      {disabledMessages.PHASE_CAPACITY_REACHED}
    </Callout> : null}
    <FileUploadPanel key={`${stageKey}:${intent}`} orderId={orderId} staff={staff}
      phase={{ key: stageKey, intent }} disabled={!phase.data.enabled} policy={{ ...policy, maxFiles: Math.max(1, maxFiles) }}
      audio={intent === "recording" ? { enabled: true, maxMinutes: Math.ceil(maxSeconds / 60) } : null} maxSeconds={maxSeconds}
      onPendingChange={onPendingChange}
      onChanged={async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.files.phasePolicy.pathKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.files.list.pathKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.files.teamFiles.pathKey() }),
          onChanged?.(),
        ]);
      }} />
  </div>;
}

export function PhaseTeamFiles({ orderId, stageKey }: { orderId: string; stageKey: string }) {
  const trpc = useTRPC();
  const files = useInfiniteQuery(trpc.files.teamFiles.infiniteQueryOptions(
    { orderPublicId: orderId, stageKey }, { getNextPageParam: (page) => page.nextCursor, retry: false },
  ));
  return <PhaseFileItems files={files} label="Team files" empty="There are no team files to review in this phase." />;
}

function PhaseReadOnlyFiles({ orderId, stageKey, intent }: Pick<PhaseUploadProps, "orderId" | "stageKey" | "intent">) {
  const trpc = useTRPC();
  const files = useInfiniteQuery(trpc.files.list.infiniteQueryOptions(
    { orderId, stageKey, limit: 25 }, { getNextPageParam: (page) => page.nextCursor, retry: false },
  ));
  return <PhaseFileItems files={files} label="Submitted phase files" empty="There are no submitted files of this type in this phase."
    include={(file) => file.category !== "deliverable" && file.contentType.startsWith("audio/") === (intent !== "document")} />;
}

function PhaseFileItems({ files, label, empty, include }: {
  files: { data?: { pages: Array<{ items: FileRecord[] }> }; isPending: boolean; isError: boolean; hasNextPage: boolean;
    isFetchingNextPage: boolean; fetchNextPage: () => Promise<unknown>; refetch: () => Promise<unknown> };
  label: string; empty: string; include?: (file: FileRecord) => boolean;
}) {
  const api = useTRPCClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const allItems = files.data?.pages.flatMap((page) => page.items) ?? [];
  const items = include ? allItems.filter(include) : allItems;
  async function download(file: FileRecord) {
    if (busy) return;
    setBusy(file.publicId);
    setNotice(false);
    try {
      const { ticket } = await api.files.issueDownloadTicket.mutate({ fileId: file.publicId });
      const response = await sessionFetch(apiUrl("/api/files/download"), {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }),
      });
      if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) throw Error();
      const blob = await response.blob();
      if (blob.size !== file.size) throw Error();
      saveFileBlob(blob, file.displayName);
    } catch { setNotice(true); }
    finally { setBusy(null); }
  }
  if (files.isPending) return <p role="status" className="text-sm text-body">Loading phase files…</p>;
  if (files.isError && !items.length) return <Callout tone="warning" title="Phase files unavailable">
    <Button variant="secondary" onClick={() => { void files.refetch(); }}>Retry phase files</Button>
  </Callout>;
  return <div className="grid min-w-0 gap-3">
    {items.length ? <ul className="grid min-w-0 gap-2" aria-label={label}>
      {items.map((file) => <li key={file.publicId} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3">
        <div className="min-w-0">
          <span className="block break-all font-medium text-ink">{file.displayName}</span>
          <span className="text-sm text-body">{formatBytes(file.size)} · Version {file.version}</span>
        </div>
        <Button size="sm" variant="secondary" leadingIcon={<Download aria-hidden />} aria-disabled={busy !== null || undefined}
          loading={busy === file.publicId} aria-label={`Download ${file.displayName}`} onClick={() => { void download(file); }}>Download</Button>
      </li>)}
    </ul> : <p className="text-sm text-body">{files.hasNextPage ? "No matching files on this page." : empty}</p>}
    {notice ? <Callout tone="warning" live="polite" title="Download not available">Refresh this phase and try again.</Callout> : null}
    <LoadMore hasMore={files.hasNextPage} loading={files.isFetchingNextPage} onLoadMore={() => { void files.fetchNextPage(); }} />
  </div>;
}
