import { useId, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { FileCategory, FileUploadSlot, FileVisibility, UploadPolicy } from "@server/modules/files/index";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { Button, Callout, Field, FileDropzone, Select, StatusBadge, Textarea } from "@/ui";
import { AudioRecorder } from "./AudioRecorder";
import { formatBytes } from "./format";

export const categoryLabels: Record<FileCategory, string> = {
  supporting: "Supporting document",
  intake_attachment: "Intake attachment",
  deliverable: "Deliverable",
};
export const visibilityLabels: Record<FileVisibility, string> = {
  customer_visible: "Customer-visible",
  staff_only: "Staff only",
};

export type UploadOutcome = { index: number; outcome: "completed" | "refused" | "unknown"; message?: string };

const uploadRefusals = new Map([
  ["UPLOAD_REQUEST_TOO_LARGE", "The total upload exceeds the request limit. Choose fewer or smaller files."],
  ["TOO_MANY_FILES", "This batch exceeds the file count limit."],
  ["ORDER_LOCKED", "This order is locked for file changes."],
  ["ORDER_ACCEPTANCE_REQUIRED", "Accept the order's required policy before uploading files or saving a recording."],
  ["PHASE_LOCKED", "This phase is locked for file changes."],
  ["UPLOAD_SLOT_STATUS_CHANGED", "The order status changed. Reload to see the current upload slots."],
  ["UPLOAD_SLOT_UNAVAILABLE", "This upload slot is no longer available to you."],
  ["AUDIT_WRITE_FAILED", "A security record could not be saved. Reload the list to confirm which files were saved."],
]);

function decodeResults(data: unknown, count: number): UploadOutcome[] {
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) return [];
  const seen = new Set<number>();
  const results: UploadOutcome[] = [];
  for (const item of data.results as unknown[]) {
    if (!item || typeof item !== "object" || !("index" in item) || !("outcome" in item) ||
        typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || item.index >= count ||
        seen.has(item.index) || (item.outcome !== "refused" && item.outcome !== "completed" && item.outcome !== "unknown")) continue;
    seen.add(item.index);
    results.push({ index: item.index, outcome: item.outcome,
      message: "message" in item && typeof item.message === "string" ? item.message.slice(0, 300) : undefined });
  }
  return results;
}

export interface FileUploadPanelProps {
  orderId: string;
  staff: boolean;
  policy: UploadPolicy;
  replace?: { id: string; category: FileCategory; visibility: FileVisibility };
  slot?: FileUploadSlot & { statusKey: string };
  audio?: { enabled: boolean; maxMinutes: number } | null;
  onChanged: () => void | Promise<void>;
}

export function FileUploadPanel({ orderId, staff, policy, replace, slot, audio, onChanged }: FileUploadPanelProps) {
  const hintId = useId();
  const transcriptInput = useRef<HTMLTextAreaElement>(null);
  const [category, setCategory] = useState<FileCategory>(replace?.category ?? "supporting");
  const [visibility, setVisibility] = useState<FileVisibility>(replace?.visibility ?? "customer_visible");
  const [selection, setSelection] = useState<File[]>([]);
  const [recording, setRecording] = useState(false);
  const [results, setResults] = useState<UploadOutcome[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const maxFiles = replace ? 1 : Math.min(policy.maxFiles, slot?.maxCount ?? policy.maxFiles);
  const extensions = slot ? policy.extensions.filter((extension) => {
    if (slot.allowedTypes.length && !slot.allowedTypes.includes(extension)) return false;
    return (slot.kind === "audio" ? ["wav", "webm", "ogg", "m4a"] : ["pdf", "png", "jpg"]).includes(extension);
  }) : policy.extensions;
  const allowsTranscript = selection.length === 1 && (slot?.kind === "audio" ||
    /^(?:audio\/)|\.(?:wav|ogg|webm|m4a)$/iu.test(`${selection[0]?.type} ${selection[0]?.name}`));
  const categories = (Object.keys(categoryLabels) as FileCategory[]).filter((key) => staff || key !== "deliverable");

  function choose(files: File[], isRecording = false) {
    setMessage(null);
    setResults([]);
    setTranscript("");
    setRecording(isRecording);
    if (files.length > maxFiles) {
      setSelection([]);
      setMessage(`Choose at most ${maxFiles} ${maxFiles === 1 ? "file" : "files"} per upload.`);
      return;
    }
    if (files.some((file) => file.size > policy.maxFileBytes) || files.reduce((total, file) => total + file.size, 0) + 1024 > policy.maxRequestBytes) {
      setSelection([]);
      setMessage(`Choose files that fit within the ${formatBytes(policy.maxRequestBytes)} request limit.`);
      return;
    }
    setSelection(files);
  }

  async function upload() {
    if (!selection.length || running) return;
    setRunning(true);
    setMessage(null);
    setResults([]);
    const query = new URLSearchParams({ category, visibility: slot ? "customer_visible" : visibility });
    if (recording) query.set("source", "recording");
    if (slot) {
      query.set("slotKey", slot.key);
      query.set("statusKey", slot.statusKey);
    }
    if (replace) query.set("versionOf", replace.id);
    const payload = new FormData();
    for (const file of selection) payload.append("files", file);
    if (allowsTranscript && transcript.trim()) payload.append("transcript", transcript.trim());
    try {
      const response = await sessionFetch(apiUrl(`/api/files/upload/${encodeURIComponent(orderId)}?${query.toString()}`), {
        method: "POST", body: payload, cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const safe = body && typeof body === "object" && "safe" in body ? body.safe : null;
        const reason = safe && typeof safe === "object" && "reasonCode" in safe && typeof safe.reasonCode === "string" ? safe.reasonCode : "";
        setMessage(uploadRefusals.get(reason) ?? "The upload was not confirmed. Reload the file list before retrying.");
        if ([401, 403, 404, 409, 413, 429].includes(response.status) || uploadRefusals.has(reason) && reason !== "AUDIT_WRITE_FAILED") {
          setResults(selection.map((_, index) => ({ index, outcome: "refused" })));
        } else setResults(selection.map((_, index) => ({ index, outcome: "unknown" })));
      } else {
        const outcomes = decodeResults(body, selection.length);
        setResults(selection.map((_, index) => outcomes.find((item) => item.index === index) ?? { index, outcome: "unknown" }));
      }
    } catch {
      setMessage("The connection ended before the uploads were confirmed. Reload the file list before retrying.");
      setResults(selection.map((_, index) => ({ index, outcome: "unknown" })));
    } finally {
      setRunning(false);
      void onChanged();
    }
  }

  const accept = extensions.flatMap((ext) => ext === "jpg" ? [".jpg", ".jpeg"] : [`.${ext}`]).join(",");
  const finished = selection.length > 0 && results.length === selection.length;
  return (
    <div className="grid min-w-0 gap-4">
      {!replace ? <div className="grid gap-4 sm:grid-cols-2">
        <Field label="File category">
          <Select value={category} onChange={(e) => setCategory(e.target.value as FileCategory)}
            options={categories.map((value) => ({ value, label: categoryLabels[value] }))} disabled={running} />
        </Field>
        {staff && !slot ? <Field label="Visibility">
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as FileVisibility)} disabled={running}
            options={Object.entries(visibilityLabels).map(([value, label]) => ({ value, label }))} />
        </Field> : null}
      </div> : null}
      {slot ? <p className="text-sm text-body">Files in this slot are visible to authorized order readers.</p> : null}
      {extensions.length ? <FileDropzone onFiles={choose} accept={accept} multiple={maxFiles !== 1} maxSize={policy.maxFileBytes}
        disabled={running} label={replace ? "Choose replacement file" : "Choose files"}
        hint={`Approved formats: ${extensions.map((ext) => ext.toUpperCase()).join(", ")}. Up to ${maxFiles} per upload.`} /> :
        <Callout tone="warning" title="Uploads paused">No file formats are enabled. Existing files remain available to authorized readers.</Callout>}
      {audio?.enabled && !running && !selection.length && slot?.kind !== "document" ?
        <AudioRecorder extensions={extensions} maxSeconds={audio.maxMinutes * 60}
          maxBytes={Math.min(policy.maxFileBytes, policy.maxRequestBytes - 1024)}
          onChoose={(file) => { choose([file], true); window.requestAnimationFrame(() => transcriptInput.current?.focus()); }} /> : null}
      {message ? <Callout tone="warning" title="Upload notice" live="polite">{message}</Callout> : null}
      {selection.length ? <>
        <ul className="grid min-w-0 divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface px-3" aria-label="Selected files and upload results">
          {selection.map((file, index) => {
            const result = results[index];
            return <li key={`${index}-${file.name}`} className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
              <div className="min-w-0">
                <p className="break-all font-medium text-ink">{file.name}</p>
                <p className="text-sm text-muted">{formatBytes(file.size)}</p>
                {result?.message ? <p className="mt-1 break-words text-sm text-body">{result.message}</p> : null}
              </div>
              <div><StatusBadge state={result?.outcome ?? (running ? "running" : "queued")} /></div>
            </li>;
          })}
        </ul>
        {allowsTranscript ? <Field label="Audio transcript (optional)" hint="Plain text, up to 4,000 characters. The transcript has the same access rules as the recording.">
          <Textarea ref={transcriptInput} value={transcript} disabled={running || finished} maxLength={4000} onChange={(event) => setTranscript(event.target.value)} rows={3} />
        </Field> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button leadingIcon={<Upload aria-hidden />} onClick={() => { void upload(); }} disabled={running || finished || !extensions.length} loading={running}>
            {replace ? "Upload new version" : `Upload ${selection.length === 1 ? "file" : `${selection.length} files`}`}
          </Button>
          <Button variant="ghost" disabled={running} onClick={() => choose([])}>{finished ? "Clear results" : "Clear selection"}</Button>
        </div>
      </> : null}
      {running ? <div className="grid gap-1" role="status">
        <span id={hintId} className="text-sm text-body">Sending and validating selected files…</span>
        <progress className="w-full accent-action" aria-labelledby={hintId} />
      </div> : null}
      {finished ? <p role="status" className="text-sm text-body">
        {results.filter((result) => result.outcome === "completed").length} of {selection.length} uploads confirmed.
      </p> : null}
    </div>
  );
}
