import { useState, type FormEvent } from "react";
import { FolderLock, ShieldAlert } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FilesModule, UploadPolicy } from "@server/modules/files/index";
import type { AudioRules, FileRules } from "@server/modules/files/settings";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ErrorState, Field, Input, KeyValueList, PageHeader,
  Skeleton, StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { formatBytes } from "./format";

const mebibyte = 1024 * 1024;
type Overview = Awaited<ReturnType<FilesModule["adminOverview"]>>;
const formatLabels: Record<UploadPolicy["extensions"][number], string> = {
  pdf: "PDF document",
  png: "PNG image",
  jpg: "JPEG image",
  wav: "WAV audio",
  webm: "WebM audio or video",
  mp4: "MP4 video",
  m4a: "M4A audio",
  ogg: "Ogg audio or video",
};

export function FileRulesEditor({ initial, supported, onSave, busy }: {
  initial: FileRules; supported: UploadPolicy; busy: boolean; onSave: (rules: FileRules) => Promise<void>;
}) {
  const [extensions, setExtensions] = useState(initial.extensions);
  const [fileLimit, setFileLimit] = useState(String(initial.maxFileBytes / mebibyte));
  const [requestLimit, setRequestLimit] = useState(String(initial.maxRequestBytes / mebibyte));
  const [count, setCount] = useState(String(initial.maxFiles));
  const [retention, setRetention] = useState(String(initial.retentionDays));
  const [error, setError] = useState<string | null>(null);
  const dirty = initial.extensions.length !== extensions.length || !initial.extensions.every((ext) => extensions.includes(ext)) ||
    Number(fileLimit) * mebibyte !== initial.maxFileBytes || Number(requestLimit) * mebibyte !== initial.maxRequestBytes ||
    Number(count) !== initial.maxFiles || Number(retention) !== initial.retentionDays;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed = {
      extensions: supported.extensions.filter((ext) => extensions.includes(ext)),
      maxFileBytes: Math.round(Number(fileLimit) * mebibyte),
      maxRequestBytes: Math.round(Number(requestLimit) * mebibyte),
      maxFiles: Number(count),
      retentionDays: Number(retention),
    };
    if (!Number.isSafeInteger(parsed.maxFileBytes) || parsed.maxFileBytes < 1024 || parsed.maxFileBytes > supported.maxFileBytes ||
        !Number.isSafeInteger(parsed.maxRequestBytes) || parsed.maxRequestBytes < 4096 || parsed.maxRequestBytes > supported.maxRequestBytes ||
        parsed.maxRequestBytes < parsed.maxFileBytes + 1024 ||
        !Number.isInteger(parsed.maxFiles) || parsed.maxFiles < 1 || parsed.maxFiles > supported.maxFiles ||
        !Number.isInteger(parsed.retentionDays) || parsed.retentionDays < 1 || parsed.retentionDays > 90) {
      setError("Check each limit. The request must allow at least 1 KiB more than a single file.");
      return;
    }
    try {
      await onSave(parsed);
    } catch (cause) {
      if (!(cause instanceof StepUpCancelledError)) setError(errorMessage(cause, "The change could not be confirmed."));
    }
  }

  return (
    <form noValidate onSubmit={(event) => { void submit(event); }} className="grid min-w-0 gap-5">
      <fieldset className="min-w-0 space-y-3" disabled={busy}>
        <legend className="font-semibold text-ink">Allowed formats</legend>
        <p className="text-sm text-body">Uncheck a format to block new uploads of it. Existing files are not changed.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {supported.extensions.map((ext) => <Checkbox key={ext} label={formatLabels[ext]} checked={extensions.includes(ext)}
            onCheckedChange={(checked) => setExtensions((previous) => checked ? [...previous, ext] : previous.filter((value) => value !== ext))} />)}
        </div>
      </fieldset>
      {!extensions.length ? <Callout tone="warning" title="Uploads will be paused">No formats are selected.</Callout> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Maximum size per file (MiB)" hint={`Up to ${formatBytes(supported.maxFileBytes)}.`} required>
          <Input type="number" inputMode="decimal" min={1024 / mebibyte} max={supported.maxFileBytes / mebibyte} step="any"
            value={fileLimit} onChange={(event) => setFileLimit(event.target.value)} disabled={busy} />
        </Field>
        <Field label="Maximum request size (MiB)" hint={`Includes multipart overhead; up to ${formatBytes(supported.maxRequestBytes)}.`} required>
          <Input type="number" inputMode="decimal" min={4096 / mebibyte} max={supported.maxRequestBytes / mebibyte} step="any"
            value={requestLimit} onChange={(event) => setRequestLimit(event.target.value)} disabled={busy} />
        </Field>
        <Field label="Files per upload" hint={`Between 1 and ${supported.maxFiles}.`} required>
          <Input type="number" inputMode="numeric" min={1} max={supported.maxFiles} step={1} value={count}
            onChange={(event) => setCount(event.target.value)} disabled={busy} />
        </Field>
        <Field label="Trash retention (days)" hint="Applies to future removals. Between 1 and 90 days." required>
          <Input type="number" inputMode="numeric" min={1} max={90} step={1} value={retention}
            onChange={(event) => setRetention(event.target.value)} disabled={busy} />
        </Field>
      </div>
      {error ? <Callout tone="danger" title="Check file rules" live="assertive">{error}</Callout> : null}
      <div><Button type="submit" disabled={!dirty} loading={busy}>Save file rules</Button></div>
    </form>
  );
}

function AudioRulesEditor({ initial, busy, version, onSave }: {
  initial: AudioRules; busy: boolean; version: string | null; onSave: (value: AudioRules) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [minutes, setMinutes] = useState(String(initial.maxMinutes));
  const [bitrate, setBitrate] = useState(String(initial.bitrateKbps));
  const [notice, setNotice] = useState<string | null>(null);
  const changed = enabled !== initial.enabled || Number(minutes) !== initial.maxMinutes || Number(bitrate) !== initial.bitrateKbps;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    const value = { enabled, maxMinutes: Number(minutes), bitrateKbps: Number(bitrate), keepOriginal: true as const };
    if (!Number.isInteger(value.maxMinutes) || value.maxMinutes < 1 || value.maxMinutes > 20 ||
      !Number.isInteger(value.bitrateKbps) || value.bitrateKbps < 24 || value.bitrateKbps > 128) {
      setNotice("Enter whole numbers within the given duration and bitrate limits.");
      return;
    }
    try { await onSave(value); }
    catch (error) { if (!(error instanceof StepUpCancelledError)) setNotice(errorMessage(error, "Audio settings could not be saved.")); }
  }
  return <form className="grid min-w-0 gap-4" onSubmit={(event) => { void submit(event); }} noValidate>
    <p className="text-sm text-body">{!initial.enabled ? "Recording and conversion are off. Ordinary file uploads remain available." :
      version ? `FFmpeg ${version} is available.` : "Conversion not available. Original audio can still be uploaded."}</p>
    <Checkbox label="Enable microphone recording and WebM conversion" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
    <Field label="Maximum recording length (minutes)" hint="Between 1 and 20 minutes." required>
      <Input type="number" min={1} max={20} step={1} value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={busy} />
    </Field>
    <Field label="WebM bitrate (kbps)" hint="Between 24 and 128 kbps." required>
      <Input type="number" min={24} max={128} step={1} value={bitrate} onChange={(event) => setBitrate(event.target.value)} disabled={busy} />
    </Field>
    <p className="text-sm text-body">Keep original: always on. Conversion creates a separate copy; it never replaces the original.</p>
    {notice ? <Callout tone="danger" live="assertive" title="Check audio settings">{notice}</Callout> : null}
    <div><Button type="submit" disabled={!changed} loading={busy}>Save audio settings</Button></div>
  </form>;
}

export function FilesAdminContent({ overview, saving, onSave, audioSaving, onSaveAudio }: {
  overview: Overview; saving: boolean; onSave: (rules: FileRules) => Promise<void>;
  audioSaving: boolean; onSaveAudio: (rules: AudioRules) => Promise<void>;
}) {
  return (
    <>
      <PageHeader title="File administration" description="Manage private file admission, retention, and recorded storage usage." />
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Upload rules" description="A file’s extension and detected format must agree. Updating admission rules requires identity verification.">
          <FileRulesEditor key={JSON.stringify(overview.rules)} initial={overview.rules} supported={overview.supported} busy={saving} onSave={onSave} />
        </Card>
        <div className="grid min-w-0 gap-5">
          <Card title="Audio recording and conversion" description="Control browser recording and the worker’s WebM/Opus output.">
            <AudioRulesEditor initial={overview.audioRules} version={overview.audioVersion} key={JSON.stringify(overview.audioRules)}
              busy={audioSaving} onSave={onSaveAudio} />
          </Card>
          <Card title="Recorded storage usage" description="Includes active versions and files retained in trash. Staging and export artifacts are excluded.">
            <KeyValueList columns={1} items={[
              { label: "Stored file versions", value: overview.storedFiles.toLocaleString() },
              { label: "Stored data", value: formatBytes(overview.storedBytes) },
              { label: "Versions retained in trash", value: overview.retainedFiles.toLocaleString() },
            ]} />
          </Card>
          <Card title="Antivirus scanning" actions={<Badge tone={overview.antivirus === "not_configured" ? "warning" : "neutral"} icon={<ShieldAlert aria-hidden />}>
            {overview.antivirus === "not_configured" ? "Not configured" : "Configured"}
          </Badge>}>
            <p className="text-sm text-body">{overview.antivirus === "not_configured"
              ? "Format checks are enabled but do not replace antivirus scanning. No external scan is performed."
              : "An external scanner is registered. A new file is refused if the scanner cannot confirm it."}</p>
          </Card>
        </div>
      </div>
    </>
  );
}

export default function FilesAdminPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const overview = useQuery(trpc.files.admin.get.queryOptions());
  const save = useMutation(trpc.files.admin.setTypeRules.mutationOptions());
  const saveAudio = useMutation(trpc.files.admin.setAudioRules.mutationOptions());
  const [verifying, setVerifying] = useState(false);

  async function change(rules: FileRules) {
    setVerifying(true);
    try {
      await stepUp.run(() => save.mutateAsync(rules), { reason: "Changing private file admission rules requires a fresh identity check." });
      await queryClient.invalidateQueries({ queryKey: trpc.files.pathKey() });
      toast.show({ tone: "success", title: "File rules saved" });
    } finally {
      setVerifying(false);
    }
  }
  async function changeAudio(rules: AudioRules) {
    setVerifying(true);
    try {
      await stepUp.run(() => saveAudio.mutateAsync(rules), { reason: "Changing audio recording and conversion requires a fresh identity check." });
      await queryClient.invalidateQueries({ queryKey: trpc.files.pathKey() });
      toast.show({ tone: "success", title: "Audio settings saved" });
    } finally { setVerifying(false); }
  }

  if (!overview.data) {
    return <>
      <PageHeader title="File administration" description="Manage private file admission, retention, and recorded storage usage."
        meta={<FolderLock aria-hidden className="size-5 text-action" />} />
      {overview.isPending ? <div role="status" aria-label="Loading file administration"><Skeleton lines={6} /></div> :
        <ErrorState title="File settings are unavailable" error={overview.error} onRetry={() => { void overview.refetch(); }} />}
    </>;
  }
  return <FilesAdminContent overview={overview.data} onSave={change} saving={save.isPending || verifying}
    onSaveAudio={changeAudio} audioSaving={saveAudio.isPending || verifying} />;
}
