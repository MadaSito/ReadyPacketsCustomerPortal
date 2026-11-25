import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Mic, Upload } from "lucide-react";
import type { FileCategory, FileUploadSlot, FileVisibility, UploadIntent, UploadPolicy } from "@server/modules/files/index";
import { apiUrl } from "@/lib/runtime";
import { AgreementDialog, type AgreementSignatureMode } from "@/lib/agreementGate";
import { sessionFetch } from "@/lib/sessionTransport";
import { Button, Callout, Field, FileDropzone, Select, StatusBadge, Textarea } from "@/ui";
import { AudioRecorder } from "./AudioRecorder";
import { formatBytes } from "./format";
import { RecordingPreflight } from "./RecordingPreflight";
import { audioFileExtensions, extensionForRecording, pickRecorderFormat } from "./recordingDevice";

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
type Agreement = { policyPublicId: string; signatureMode: AgreementSignatureMode };
type PendingAgreement = Agreement & ({ indices: number[] } | { preflight: "record" | "check" });

function readAgreement(reason: unknown, details: unknown): Agreement | null {
  if (reason !== "AGREEMENT_REQUIRED" || !details || typeof details !== "object" ||
      !("policyPublicId" in details) || !("signatureMode" in details) ||
      typeof details.policyPublicId !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(details.policyPublicId) ||
      (details.signatureMode !== "checkbox" && details.signatureMode !== "typed_name")) return null;
  return { policyPublicId: details.policyPublicId, signatureMode: details.signatureMode };
}

const uploadRefusals = new Map([
  ["UPLOAD_REQUEST_TOO_LARGE", "The total upload exceeds the request limit. Choose fewer or smaller files."],
  ["TOO_MANY_FILES", "This batch exceeds the file count limit."],
  ["ORDER_LOCKED", "This order is locked for file changes."],
  ["ORDER_ACCEPTANCE_REQUIRED", "Accept the order's required policy before uploading files or saving a recording."],
  ["AGREEMENT_REQUIRED", "Accept the order agreement before uploading files or saving a recording."],
  ["PHASE_LOCKED", "This phase is locked for file changes."],
  ["STAGE_LOCKED", "This phase is locked for file changes."],
  ["STAGE_REQUIRED", "Choose the phase this file belongs to."],
  ["UPLOAD_SLOT_STATUS_CHANGED", "The order status changed. Reload to see the current upload slots."],
  ["UPLOAD_SLOT_UNAVAILABLE", "This upload slot is no longer available to you."],
  ["AUDIT_WRITE_FAILED", "A security record could not be saved. Reload the list to confirm which files were saved."],
]);

function decodeResults(data: unknown, count: number): (UploadOutcome & { agreement: Agreement | null })[] {
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) return [];
  const seen = new Set<number>();
  const results: (UploadOutcome & { agreement: Agreement | null })[] = [];
  for (const item of data.results as unknown[]) {
    if (!item || typeof item !== "object" || !("index" in item) || !("outcome" in item) ||
        typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || item.index >= count ||
        seen.has(item.index) || (item.outcome !== "refused" && item.outcome !== "completed" && item.outcome !== "unknown")) continue;
    seen.add(item.index);
    results.push({ index: item.index, outcome: item.outcome,
      agreement: item.outcome === "refused" ? readAgreement("reason" in item ? item.reason : undefined, "details" in item ? item.details : undefined) : null,
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
  launchRecording?: boolean;
  phase?: { key: string; intent?: UploadIntent };
  maxSeconds?: number;
  disabled?: boolean;
  onPendingChange?: (count: number) => void;
  onChanged: () => void | Promise<void>;
}

export function FileUploadPanel({ orderId, staff, policy, replace, slot, audio, phase, maxSeconds,
  disabled = false, launchRecording = false, onPendingChange, onChanged }: FileUploadPanelProps) {
  const hintId = useId();
  const captureId = useId();
  const recordButton = useRef<HTMLButtonElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const restoreUploadFocus = useRef(false);
  const transcriptInput = useRef<HTMLTextAreaElement>(null);
  const [category, setCategory] = useState<FileCategory>(replace?.category ?? "supporting");
  const [visibility, setVisibility] = useState<FileVisibility>(replace?.visibility ?? "customer_visible");
  const [selection, setSelection] = useState<File[]>([]);
  const [recording, setRecording] = useState(false);
  const [results, setResults] = useState<UploadOutcome[]>([]);
  const [agreement, setAgreement] = useState<PendingAgreement | null>(null);
  const [activeUpload, setActiveUpload] = useState<number[]>([]);
  const running = activeUpload.length > 0;
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [checking, setChecking] = useState<"record" | "check" | null>(() =>
    launchRecording && audio?.enabled && slot?.kind === "audio" && slot.capture !== "upload" ? "record" : null);
  const [preflightComplete, setPreflightComplete] = useState(false);
  const [checkedMaxSeconds, setCheckedMaxSeconds] = useState<number>();
  const [deviceId, setDeviceId] = useState("");
  const [showRecorder, setShowRecorder] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  const maxFiles = replace ? 1 : Math.min(policy.maxFiles, slot?.maxCount ?? policy.maxFiles);
  const extensions = slot ? policy.extensions.filter((extension) => {
    if (slot.allowedTypes.length && !slot.allowedTypes.includes(extension)) return false;
    return (slot.kind === "audio" ? (audioFileExtensions as readonly string[]) : ["pdf", "png", "jpg", "docx"]).includes(extension);
  }) : policy.extensions;
  const canPick = phase?.intent !== "recording" && slot?.acceptsUpload !== false && slot?.capture !== "record";
  const canRecord = (!phase?.intent || phase.intent === "recording") && audio?.enabled && slot?.acceptsUpload !== false && slot?.capture !== "upload" &&
    slot?.kind !== "document" && audioFileExtensions.some((extension) => extensions.includes(extension));
  const allowsTranscript = selection.length === 1 && (slot?.kind === "audio" ||
    /^(?:audio\/)|\.(?:wav|ogg|webm|m4a|mp4|mp3|aac|caf)$/iu.test(`${selection[0]?.type} ${selection[0]?.name}`));
  const categories = (Object.keys(categoryLabels) as FileCategory[]).filter((key) => staff || key !== "deliverable");
  const byIndex = new Map(results.map((result) => [result.index, result]));
  const retryAfterAgreement = agreement && "indices" in agreement ? agreement.indices : [];
  const pendingCount = selection.filter((_, index) => {
    const outcome = byIndex.get(index)?.outcome;
    return activeUpload.includes(index) || retryAfterAgreement.includes(index) || !outcome || outcome === "unknown";
  }).length;
  const reportPending = useEffectEvent((count: number) => onPendingChange?.(count));
  useEffect(() => { reportPending(pendingCount); }, [pendingCount]);
  useEffect(() => () => { reportPending(0); }, []);

  function choose(files: File[], isRecording = false) {
    setMessage(null);
    setResults([]);
    setAgreement(null);
    setTranscript("");
    setRecording(isRecording);
    if (files.length > maxFiles) {
      setSelection([]);
      setMessage(`Choose at most ${maxFiles} ${maxFiles === 1 ? "file" : "files"} per upload.`);
      return;
    }
    if (files.some((file) => file.size > policy.maxFileBytes)) {
      setSelection([]);
      setMessage(`Choose files no larger than ${formatBytes(policy.maxFileBytes)} each.`);
      return;
    }
    if (files.reduce((total, file) => total + file.size, 0) + 1024 > policy.maxRequestBytes) {
      setSelection([]);
      setMessage(`Choose files that fit within the ${formatBytes(policy.maxRequestBytes)} request limit.`);
      return;
    }
    setSelection(files);
  }

  function chooseRecording(file: File) {
    const suffix = file.name.split(".").at(-1)?.toLowerCase();
    const extension = suffix && (audioFileExtensions as readonly string[]).includes(suffix)
      ? (extensions.includes(suffix as typeof extensions[number]) ? suffix : undefined)
      : extensionForRecording(file.type, extensions);
    if (!extension) { setMessage("This recording format is not accepted by this order. Choose an approved audio format."); return; }
    choose([suffix === extension ? file : new File([file], `recording.${extension}`, { type: file.type })], true);
    window.requestAnimationFrame(() => transcriptInput.current?.focus());
  }

  function openRecorder(fallback = false) {
    if (fallback || pickRecorderFormat(extensions) === null || window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) {
      setShowCapture(true);
      setShowRecorder(false);
    } else setShowRecorder(true);
  }

  async function upload(indices = selection.map((_, index) => index)) {
    if (!indices.length || running || disabled) return;
    setActiveUpload(indices);
    setMessage(null);
    setAgreement(null);
    function update(outcomes: UploadOutcome[]) {
      setResults((prior) => [...prior.filter((result) => !indices.includes(result.index)), ...outcomes]);
    }
    const query = new URLSearchParams({ category, visibility: slot ? "customer_visible" : visibility });
    if (phase) {
      query.set("stageKey", phase.key);
      query.set("intent", phase.intent ?? (recording ? "recording" : slot?.kind === "audio" ? "prerecorded_audio" : "document"));
    } else if (recording) query.set("source", "recording");
    if (slot) {
      query.set("slotKey", slot.key);
      query.set("statusKey", slot.statusKey);
    }
    if (replace) query.set("versionOf", replace.id);
    const payload = new FormData();
    for (const index of indices) payload.append("files", selection[index]!);
    if (allowsTranscript && transcript.trim()) payload.append("transcript", transcript.trim());
    try {
      const response = await sessionFetch(apiUrl(`/api/files/upload/${encodeURIComponent(orderId)}?${query.toString()}`), {
        method: "POST", body: payload, cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const safe = body && typeof body === "object" && "safe" in body ? body.safe : null;
        const reason = safe && typeof safe === "object" && "reasonCode" in safe && typeof safe.reasonCode === "string" ? safe.reasonCode : "";
        const pending = readAgreement(reason, safe && typeof safe === "object" && "details" in safe ? safe.details : undefined);
        if (pending) {
          setAgreement({ ...pending, indices });
          return;
        }
        setMessage(uploadRefusals.get(reason) ?? "The upload was not confirmed. Reload the file list before retrying.");
        if ([401, 403, 404, 409, 413, 429].includes(response.status) || uploadRefusals.has(reason) && reason !== "AUDIT_WRITE_FAILED") {
          update(indices.map((index) => ({ index, outcome: "refused" })));
        } else update(indices.map((index) => ({ index, outcome: "unknown" })));
      } else {
        const outcomes = decodeResults(body, indices.length);
        const pending = outcomes.find((result) => result.agreement !== null)?.agreement;
        const retryIndices: number[] = [];
        update(indices.map((index, position) => {
          const result = outcomes.find((item) => item.index === position);
          if (pending && result?.agreement?.policyPublicId === pending.policyPublicId && result.agreement.signatureMode === pending.signatureMode) retryIndices.push(index);
          return { index, outcome: result?.outcome ?? "unknown", message: result?.message };
        }));
        if (pending && retryIndices.length) setAgreement({ ...pending, indices: retryIndices });
      }
    } catch {
      setMessage("The connection ended before the uploads were confirmed. Reload the file list before retrying.");
      update(indices.map((index) => ({ index, outcome: "unknown" })));
    } finally {
      restoreUploadFocus.current = document.activeElement === uploadButton.current;
      setActiveUpload([]);
      void onChanged();
    }
  }

  const accept = extensions.flatMap((ext) => ext === "jpg" ? [".jpg", ".jpeg"] : [`.${ext}`]).join(",");
  const finished = selection.length > 0 && results.length === selection.length;
  const showUpload = running || !finished;
  useEffect(() => {
    if (!showUpload && restoreUploadFocus.current &&
        (document.activeElement === document.body || document.activeElement === null)) {
      clearButton.current?.focus();
    }
    if (!running) restoreUploadFocus.current = false;
  }, [running, showUpload]);
  return (
    <div className="grid min-w-0 gap-4">
      {!replace && (staff || !phase) ? <div className="grid gap-4 sm:grid-cols-2">
        <Field label="File category">
          <Select value={category} onChange={(e) => setCategory(e.target.value as FileCategory)}
            options={categories.map((value) => ({ value, label: categoryLabels[value] }))} disabled={running || disabled} />
        </Field>
        {staff && !slot ? <Field label="Visibility">
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as FileVisibility)} disabled={running || disabled}
            options={Object.entries(visibilityLabels).map(([value, label]) => ({ value, label }))} />
        </Field> : null}
      </div> : null}
      {slot ? <p className="text-sm text-body">Files in this slot are visible to authorized order readers.</p> : null}
      {canPick && extensions.length ? <FileDropzone onFiles={choose} accept={accept} multiple={maxFiles !== 1} maxSize={policy.maxFileBytes}
        disabled={running || disabled} label={replace ? "Choose replacement file" : "Choose files"}
        hint={`Approved formats: ${extensions.map((ext) => ext.toUpperCase()).join(", ")}. Up to ${maxFiles} per upload.`} /> :
        canPick ? <Callout tone="warning" title="Uploads paused">No file formats are enabled. Existing files remain available to authorized readers.</Callout> : null}
      {canRecord ? <div className="flex flex-wrap gap-2">
        <Button ref={recordButton} leadingIcon={<Mic aria-hidden />} disabled={running || disabled || selection.length > 0} onClick={() => {
          if (preflightComplete) openRecorder();
          else setChecking("record");
        }}>Record</Button>
        <Button ref={checkButton} variant="ghost" disabled={running || disabled || showRecorder} onClick={() => setChecking("check")}>Check microphone</Button>
      </div> : null}
      {checking && canRecord && !disabled ? <RecordingPreflight orderId={orderId} slotKey={slot?.key} stageKey={phase?.key} deviceId={deviceId} onDevice={setDeviceId}
        onAgreementRequired={(pending) => { setAgreement({ ...pending, preflight: checking }); setChecking(null); }}
        onClose={() => {
          const trigger = checking === "record" ? recordButton : checkButton;
          setChecking(null);
          window.requestAnimationFrame(() => trigger.current?.focus());
        }}
        onContinue={(fallback, seconds) => {
          setCheckedMaxSeconds(seconds);
          setChecking(null); setPreflightComplete(true); openRecorder(fallback);
          window.requestAnimationFrame(() => document.getElementById(fallback ? captureId : `${captureId}-recorder`)?.focus());
        }} /> : null}
      {canRecord && showRecorder && !running && !disabled && !selection.length ?
        <div id={`${captureId}-recorder`} tabIndex={-1} className="min-w-0">
          <AudioRecorder extensions={extensions} maxSeconds={Math.min(
            (slot?.maxMinutes ?? audio.maxMinutes) * 60, maxSeconds ?? Infinity, checkedMaxSeconds ?? Infinity)}
          maxBytes={Math.min(policy.maxFileBytes, policy.maxRequestBytes - 1024)}
          deviceId={deviceId} onUnavailable={() => setShowCapture(true)} onChoose={chooseRecording} />
          <Button className="mt-2" variant="ghost" onClick={() => { setShowRecorder(false); window.requestAnimationFrame(() => recordButton.current?.focus()); }}>Close recorder</Button>
        </div> : null}
      {canRecord && showCapture && !running && !disabled && !selection.length ? <div className="grid min-w-0 gap-2">
        <label className="font-medium text-ink" htmlFor={captureId}>Record with your device</label>
        <input className="w-full min-w-0 rounded-md border border-line bg-surface p-2 text-sm text-ink" id={captureId} aria-describedby={`${captureId}-hint`}
          type="file" accept="audio/*" capture onChange={(event) => {
            const [file] = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (file) chooseRecording(file);
          }} />
        <p id={`${captureId}-hint`} className="text-sm text-body">Some devices open a file picker instead. The server checks the selected file and enforces the task’s recording limits.</p>
      </div> : null}
      {!canPick && !canRecord ? <Callout tone="info" title="Recording unavailable">This task requires a recording, but browser recording is disabled or no audio formats are enabled.</Callout> : null}
      {message ? <Callout tone="warning" title="Upload notice" live="polite">{message}</Callout> : null}
      {agreement ? <AgreementDialog open policyPublicId={agreement.policyPublicId} signatureMode={agreement.signatureMode}
        onClose={() => { setAgreement(null); setMessage("Accept the order agreement before uploading or recording."); }}
        onAccepted={() => {
          if ("indices" in agreement) return upload(agreement.indices);
          setAgreement(null);
          setChecking(agreement.preflight);
        }} /> : null}
      {selection.length ? <>
        <ul className="grid min-w-0 divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface px-3" aria-label="Selected files and upload results">
          {selection.map((file, index) => {
            const result = byIndex.get(index);
            return <li key={`${index}-${file.name}`} className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
              <div className="min-w-0">
                <p className="break-all font-medium text-ink">{file.name}</p>
                <p className="text-sm text-muted">{formatBytes(file.size)}</p>
                {result?.message ? <p className="mt-1 break-words text-sm text-body">{result.message}</p> : null}
              </div>
              <div><StatusBadge state={activeUpload.includes(index) ? "running" : result?.outcome ?? "queued"} /></div>
            </li>;
          })}
        </ul>
        {allowsTranscript ? <Field label="Audio transcript (optional)" hint="Plain text, up to 4,000 characters. The transcript has the same access rules as the recording.">
          <Textarea ref={transcriptInput} value={transcript} disabled={running || finished} maxLength={4000} onChange={(event) => setTranscript(event.target.value)} rows={3} />
        </Field> : null}
        <div className="flex flex-wrap items-center gap-2">
          {showUpload ? <Button ref={uploadButton} leadingIcon={<Upload aria-hidden />} onClick={() => { void upload(); }}
            disabled={disabled || !extensions.length} loading={running}>
            {replace ? "Upload new version" : `Upload ${selection.length === 1 ? "file" : `${selection.length} files`}`}
          </Button> : null}
          <Button ref={clearButton} variant="ghost" disabled={running} onClick={() => choose([])}>{finished ? "Clear results" : "Clear selection"}</Button>
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
