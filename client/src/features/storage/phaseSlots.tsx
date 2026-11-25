import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { isStageOrderFileFolderTemplate } from "@shared/orderFileFolder";
import { DEFAULT_STAGE_FOLDERS, STAGE_FILE_SYNC_ROLES } from "@shared/orderStageFileSync";
import { useTRPC } from "@/lib/trpc";
import { Field, Input, Select } from "@/ui";
import type { PhaseFileSyncSlotValue, PhaseSlotProps } from "@/ui/phases/slotTypes";

const labels = { originals: "Originals", conversionStaging: "Conversion staging", intakeDelivery: "Intake delivery" };

export function PhaseFileSyncSlot({ value, onChange, stageKey, idPrefix, disabled, errors }: PhaseSlotProps<PhaseFileSyncSlotValue>) {
  const trpc = useTRPC();
  const targets = useQuery(trpc.storage.fileSync.listTargets.queryOptions(undefined, { staleTime: 30_000 }));
  const options = targets.data ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted">
        Copies go one way from the portal to approved Microsoft 365 destinations. Folder paths start below the frozen customer and order folders.
        Intake delivery receives only customer-visible files that passed portal upload checks and verified audio conversions.
        Staff-only files and audio awaiting conversion go only to Originals.
      </p>
      {errors[""] ? <p role="alert" className="text-sm text-danger">{errors[""]}</p> : null}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {(["documents", "audio"] as const).map((key) => {
          const text = value.folders[key] ?? "";
          const template = text || DEFAULT_STAGE_FOLDERS[key];
          const preview = template.replaceAll("{phase_key}", stageKey || "phase-key");
          const error = errors[`folders.${key}`] ?? (isStageOrderFileFolderTemplate(template) ? undefined : "Use a safe relative phase folder.");
          return (
            <Field key={key} id={`${idPrefix}-${key}`} label={key === "documents" ? "Document folder" : "Audio folder"} error={error}
              hint={<span className="break-all">Example: {preview}</span>}>
              <Input disabled={disabled} value={text} maxLength={400} placeholder={DEFAULT_STAGE_FOLDERS[key]}
                onBlur={() => { if (!text) onChange({ ...value, folders: { ...value.folders, [key]: DEFAULT_STAGE_FOLDERS[key] } }); }}
                onChange={(event) => onChange({ ...value, folders: { ...value.folders, [key]: event.currentTarget.value } })} />
            </Field>
          );
        })}
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {STAGE_FILE_SYNC_ROLES.map((role) => {
          const chosen = value.fileSync[role];
          const unavailable = !!chosen && !options.some((option) => option.publicId === chosen);
          return (
            <Field key={role} id={`${idPrefix}-${role}`} label={labels[role]} error={errors[`fileSync.${role}`]}>
              <Select value={chosen ?? ""} disabled={disabled}
                options={[
                  { value: "", label: "Do not transfer" },
                  ...(unavailable ? [{ value: chosen, label: targets.isPending ? "Checking selected destination…" : "Previously selected destination (unavailable)" }] : []),
                  ...options.map((option) => ({ value: option.publicId, label: option.label })),
                ]}
                onChange={(event) => onChange({ ...value, fileSync: { ...value.fileSync, [role]: event.currentTarget.value || null } })} />
            </Field>
          );
        })}
      </div>
      {targets.isError ? <p role="status" className="text-sm text-muted">Approved destinations could not be loaded. <button type="button" className="underline" onClick={() => void targets.refetch()}>Try again</button></p> : null}
      {targets.isSuccess && !options.length ? (
        <p className="text-sm text-muted">No destinations are approved yet. <Link href="/admin/storage/file-sync" className="underline">Set up Microsoft 365 file sync</Link>.</p>
      ) : null}
    </div>
  );
}
