import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileCheck2 } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, EmptyState, Field, FileDropzone, Input, KeyValueList, PageHeader } from "@/ui";
import { MIN_PASSPHRASE, type ImportPreview } from "../model";
import { PlatformNav } from "../PlatformNav";
import { useGuarded } from "../useGuarded";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const CHANGE_LABEL = { add: "Add", modify: "Change", unchanged: "Unchanged", clear: "Clear" } as const;
const REJECT_LABEL = { UNKNOWN_SETTING: "Not recognised by this version", NOT_EXPORTABLE: "Cannot be imported", INVALID_VALUE: "Invalid value", DUPLICATE: "Listed twice" } as const;

export function ImportPreviewView({ preview }: { preview: ImportPreview }) {
  return (
    <div className="space-y-4">
      {preview.integrity === "checksum-only" ? (
        <Callout tone="warning" title="Not authenticated">
          This file was exported without a passphrase. Its checksum catches accidental damage, but anyone could have edited it. Import it only if you trust where it came from.
        </Callout>
      ) : (
        <Callout tone="success" title="Authenticated">The passphrase verified that this file has not been modified.</Callout>
      )}
      <KeyValueList
        columns={3}
        items={[
          { label: "To add", value: preview.counts.add.toLocaleString() },
          { label: "To change", value: preview.counts.modify.toLocaleString() },
          { label: "Unchanged", value: preview.counts.unchanged.toLocaleString() },
          { label: "Rejected", value: preview.counts.rejected.toLocaleString() },
          { label: "Includes secrets", value: preview.secretsIncluded ? "Yes" : "No" },
        ]}
      />
      <DataTable
        caption="Changes in this file"
        rows={preview.changes.filter((c) => c.change !== "unchanged")}
        rowKey={(c) => c.key}
        empty={<EmptyState icon={FileCheck2} title="Nothing to change" description="Every setting in the file already matches this installation." headingLevel={3} />}
        columns={[
          { key: "key", header: "Setting", primary: true, cell: (c) => <span className="break-all font-mono text-sm">{c.key}</span> },
          { key: "kind", header: "Type", cell: (c) => (c.kind === "secret" ? "Secret" : c.kind === "flag" ? "Feature" : "Value") },
          { key: "change", header: "Change", cell: (c) => <Badge tone={c.change === "clear" ? "warning" : "info"}>{CHANGE_LABEL[c.change]}</Badge> },
        ]}
      />
      {preview.rejected.length > 0 ? (
        <DataTable
          caption="Entries that will be skipped"
          rows={preview.rejected}
          rowKey={(r) => r.key}
          columns={[
            { key: "key", header: "Setting", primary: true, cell: (r) => <span className="break-all font-mono text-sm">{r.key}</span> },
            { key: "reason", header: "Reason", cell: (r) => REJECT_LABEL[r.reason] },
          ]}
        />
      ) : null}
    </div>
  );
}

function ExportCard() {
  const trpc = useTRPC();
  const guarded = useGuarded();
  const exporter = useMutation(trpc.platform.admin.config.export.mutationOptions());
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ url: string; name: string; counts: { settings: number; secrets: number } } | null>(null);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (includeSecrets && passphrase.length < MIN_PASSPHRASE) return setError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters to include secrets.`);
    if (passphrase && passphrase !== confirm) return setError("The passphrases do not match.");
    setError(null);
    const result = await guarded(() => exporter.mutateAsync({ includeSecrets, passphrase: passphrase || undefined }), {
      success: "Configuration exported",
      failure: "The configuration was not exported",
      reason: "Exporting configuration needs verification.",
    });
    setPassphrase("");
    setConfirm("");
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.document], { type: "application/json" }));
    setDownload({ url, name: `readypackets-config-${new Date().toISOString().slice(0, 10)}.json`, counts: result.counts });
  }

  return (
    <Card title="Export configuration" description="Download settings to move them to another installation or keep them as a record.">
      <form onSubmit={submit} noValidate className="grid gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Checkbox label="Include secrets" description="Only secrets their module allows to be exported. They are encrypted with your passphrase." checked={includeSecrets} onCheckedChange={setIncludeSecrets} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Passphrase" hint={includeSecrets ? "Required for secrets." : "Optional. Lets the importer verify the file was not modified."} required={includeSecrets}>
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" maxLength={1024} />
          </Field>
          <Field label="Confirm passphrase">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={1024} />
          </Field>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {download ? (
            <Button asChild variant="secondary" leadingIcon={<Download aria-hidden className="size-4" />}>
              <a href={download.url} download={download.name}>Download file ({download.counts.settings} settings, {download.counts.secrets} secrets)</a>
            </Button>
          ) : <span />}
          <Button type="submit" loading={exporter.isPending}>Export</Button>
        </div>
      </form>
    </Card>
  );
}

function ImportCard() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const guarded = useGuarded();
  const previewer = useMutation(trpc.platform.admin.config.importPreview.mutationOptions());
  const applier = useMutation(trpc.platform.admin.config.importApply.mutationOptions());
  const [document, setDocument] = useState<{ name: string; text: string } | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function choose(files: File[]) {
    const file = files[0];
    setPreview(null);
    if (!file) return setDocument(null);
    setDocument({ name: file.name, text: await file.text() });
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!document) return;
    const result = await guarded(() => previewer.mutateAsync({ document: document.text, passphrase: passphrase || undefined }), {
      success: "Preview ready",
      failure: "The file could not be checked",
      reason: "Importing configuration needs verification.",
    });
    setPreview(result ?? null);
  }

  return (
    <Card title="Import configuration" description="Nothing changes until you review the preview and apply it.">
      <form onSubmit={runPreview} noValidate className="grid gap-4">
        <FileDropzone onFiles={(files) => void choose(files)} accept="application/json,.json" maxSize={MAX_DOCUMENT_BYTES} label="Choose a configuration file" hint={document ? `Selected: ${document.name}` : "JSON file exported from ReadyPackets, up to 1 MB."} />
        <Field label="Passphrase" hint="Needed if the file was exported with one.">
          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" maxLength={1024} />
        </Field>
        <div className="flex justify-end"><Button type="submit" variant="secondary" disabled={!document} loading={previewer.isPending}>Preview changes</Button></div>
      </form>
      {preview ? (
        <div className="mt-6 space-y-4">
          <ImportPreviewView preview={preview} />
          <div className="flex justify-end">
            <Button disabled={preview.counts.add + preview.counts.modify === 0 && !preview.changes.some((c) => c.change === "clear")} onClick={() => setConfirming(true)}>Apply changes</Button>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Apply this configuration?"
        description="All listed changes are applied together, or none are. If settings changed since the preview, the import is refused."
        confirmLabel="Apply changes"
        confirmText="APPLY"
        onConfirm={async () => {
          if (!document || !preview) return;
          const ok = await guarded(() => applier.mutateAsync({ document: document.text, passphrase: passphrase || undefined, expectedPreviewDigest: preview.digest }), {
            success: "Configuration imported",
            failure: "The configuration was not imported",
          });
          setConfirming(false);
          if (ok !== undefined) {
            setPreview(null);
            setDocument(null);
            setPassphrase("");
            await client.invalidateQueries({ queryKey: trpc.platform.admin.settings.list.queryKey() });
          }
        }}
      />
    </Card>
  );
}

export default function ConfigTransferPage() {
  return (
    <>
      <PageHeader title="Export and import" description="Move configuration between installations safely. Every export and import is audited." />
      <PlatformNav />
      <div className="grid gap-6 xl:grid-cols-2">
        <ExportCard />
        <ImportCard />
      </div>
    </>
  );
}
