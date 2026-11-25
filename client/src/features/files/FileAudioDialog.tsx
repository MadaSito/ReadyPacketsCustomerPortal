import { useEffect, useRef, useState } from "react";
import type { FileRecord } from "@server/modules/files/index";
import { apiUrl, RUNTIME } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { useTRPCClient } from "@/lib/trpc";
import { Button, Callout, Dialog } from "@/ui";
import { formatDuration } from "./AudioRecorder";

export function FileAudioDialog({ orderId, file, onClose }: { orderId: string; file: FileRecord | null; onClose: () => void }) {
  const api = useTRPCClient();
  return <Dialog title="Listen to order audio" description={file?.displayName} open={!!file} onOpenChange={(open) => { if (!open) onClose(); }}>
    {file ? <AudioPlayback key={file.publicId} file={file} load={async (signal) => {
      const source = file.derivedFromPublicId ?? file.publicId;
      const { transcript } = await api.files.readTranscript.mutate({ fileId: source }, { signal });
      // Header-only preview sessions cannot authenticate a native media request.
      if (RUNTIME.preview) {
        const { ticket } = await api.files.issueDownloadTicket.mutate({ fileId: file.publicId }, { signal });
        const response = await sessionFetch(apiUrl("/api/files/download"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }), cache: "no-store", signal,
        });
        if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) throw Error("Audio unavailable");
        const blob = await response.blob();
        if (blob.size !== file.size) throw Error("Audio unavailable");
        return { url: URL.createObjectURL(new Blob([blob], { type: file.contentType })), transcript };
      }
      const { ticket } = await api.files.issuePlaybackTicket.mutate({ orderId, fileId: file.publicId }, { signal });
      const response = await sessionFetch(apiUrl("/api/files/playback"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }), cache: "no-store", signal,
      });
      if (!response.ok) throw Error("Audio unavailable");
      const result: { grantPublicId?: string } = await response.json();
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(result.grantPublicId ?? "")) throw Error("Audio unavailable");
      return { url: apiUrl(`/api/files/playback/${result.grantPublicId}`), transcript };
    }} /> : null}
  </Dialog>;
}

function AudioPlayback({ file, load }: { file: FileRecord; load: (signal: AbortSignal) => Promise<{ url: string; transcript: string | null }> }) {
  const [duration, setDuration] = useState(file.durationSeconds);
  const [state, setState] = useState<{ url: string; transcript: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const playbackDetails = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => () => { if (state?.url.startsWith("blob:")) URL.revokeObjectURL(state.url); }, [state]);
  useEffect(() => { if (state) playbackDetails.current?.focus(); }, [state]);

  async function openAudio() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    if (!state) setNotice(null);
    try {
      const { url, transcript } = await load(controller.signal);
      if (!controller.signal.aborted) {
        setState({ url, transcript });
        setNotice(null);
      } else if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    } catch {
      if (!controller.signal.aborted) setNotice("The recording could not be loaded. Check your access or download the original from the file list.");
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="grid min-w-0 gap-3">
    {!state ? <div><Button loading={busy} onClick={() => { void openAudio(); }}>Load audio and transcript</Button></div> : <>
      <p ref={playbackDetails} tabIndex={-1} className="text-sm text-body">Duration: {duration === null ? "Not available" : formatDuration(duration)}</p>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Audio-only content exposes the provided transcript alongside the player. */}
      <audio controls preload="metadata" className="w-full min-w-0" aria-label={`Play ${file.displayName}`} src={state.url}
        onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
        onError={() => setNotice("The browser could not continue playback. Try refreshing access or download the file from the library.")} />
      <p className="font-medium text-ink">Transcript</p>
      <p className="whitespace-pre-wrap break-words text-sm text-body">{state.transcript || "No transcript was supplied."}</p>
    </>}
    {notice ? <Callout tone="warning" title="Audio playback notice" live="polite">
      <p>{notice}</p>
      {state ? <Button variant="secondary" size="sm" loading={busy} onClick={() => { void openAudio(); }}>Refresh playback access</Button> : null}
    </Callout> : null}
  </div>;
}
