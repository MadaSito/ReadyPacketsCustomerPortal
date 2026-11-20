import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, Field, PageHeader, Section, Select, Skeleton } from "@/ui";
import { displayValue, groupLabel, type SettingView } from "../model";
import { PlatformNav } from "../PlatformNav";
import { SecretDialog, SettingEditDialog } from "../SettingDialogs";
import { useGuarded } from "../useGuarded";

export interface SettingsViewProps {
  views: SettingView[];
  onEdit: (view: SettingView) => void;
  onSetSecret: (view: SettingView) => void;
  onClearSecret: (view: SettingView) => void;
}

/** Grouped settings tables. Secret values are never present here — only whether one is configured. */
export function SettingsView({ views, onEdit, onSetSecret, onClearSecret }: SettingsViewProps) {
  const groups = useMemo(() => {
    const map = new Map<string, SettingView[]>();
    for (const view of views) map.set(view.group, [...(map.get(view.group) ?? []), view]);
    return [...map.entries()];
  }, [views]);
  if (groups.length === 0) {
    return <EmptyState icon={Settings2} title="No settings in this group" description="Choose another group to see its settings." />;
  }
  return (
    <div className="space-y-8">
      {groups.map(([group, rows]) => (
        <Section key={group} id={`group-${group}`} title={groupLabel(group)}>
          <DataTable
            caption={`${groupLabel(group)} settings`}
            rows={rows}
            rowKey={(v) => v.key}
            columns={[
              {
                key: "label",
                header: "Setting",
                primary: true,
                cell: (v) => (
                  <div className="min-w-0">
                    <p className="font-medium text-ink break-words">{v.label}</p>
                    <p className="text-sm text-muted break-words">{v.description}</p>
                  </div>
                ),
              },
              {
                key: "value",
                header: "Value",
                cell: (v) =>
                  v.kind === "secret" ? (
                    v.configured ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not configured</Badge>
                  ) : (
                    <span className="break-all font-mono text-sm text-body">
                      {displayValue(v.value)}
                      {v.invalidStored ? <Badge tone="warning" className="ml-2">Invalid stored value</Badge> : null}
                    </span>
                  ),
              },
              { key: "updated", header: "Last changed", hideOnMobile: true, cell: (v) => (v.updatedAt ? <DateTime value={v.updatedAt} format="relative" /> : "Default") },
            ]}
            rowActions={(v) =>
              v.kind === "secret" ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => onSetSecret(v)} aria-label={`${v.configured ? "Replace" : "Set"} ${v.label}`}>
                    {v.configured ? "Replace" : "Set"}
                  </Button>
                  {v.configured ? (
                    <Button size="sm" variant="ghost" onClick={() => onClearSecret(v)} aria-label={`Remove ${v.label}`}>Remove</Button>
                  ) : null}
                </div>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => onEdit(v)} aria-label={`Edit ${v.label}`}>Edit</Button>
              )
            }
          />
        </Section>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const guarded = useGuarded();
  const [group, setGroup] = useState("");
  const list = useQuery(trpc.platform.admin.settings.list.queryOptions());
  const update = useMutation(trpc.platform.admin.settings.update.mutationOptions());
  const setSecret = useMutation(trpc.platform.admin.settings.setSecret.mutationOptions());
  const [editing, setEditing] = useState<SettingView | null>(null);
  const [secret, setSecretView] = useState<SettingView | null>(null);
  const [clearing, setClearing] = useState<SettingView | null>(null);

  const views = list.data as SettingView[] | undefined;
  const groups = useMemo(() => [...new Set((views ?? []).map((v) => v.group))].sort(), [views]);
  const visible = (views ?? []).filter((v) => !group || v.group === group);
  const refresh = () => client.invalidateQueries({ queryKey: trpc.platform.admin.settings.list.queryKey() });

  return (
    <>
      <PageHeader title="Settings" description="Configure the portal. Every change requires verification and is recorded in the audit log." />
      <PlatformNav />
      {list.isPending ? (
        <div aria-busy="true"><Skeleton lines={6} /></div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <div className="mb-6 max-w-xs">
            <Field label="Group">
              <Select value={group} onChange={(e) => setGroup(e.target.value)} placeholder="All groups" options={groups.map((g) => ({ value: g, label: groupLabel(g) }))} />
            </Field>
          </div>
          <SettingsView views={visible} onEdit={setEditing} onSetSecret={setSecretView} onClearSecret={setClearing} />
        </>
      )}
      <SettingEditDialog
        view={editing}
        onClose={() => setEditing(null)}
        onSave={async (value) => {
          if (!editing) return false;
          const ok = await guarded(() => update.mutateAsync({ key: editing.key, value: value as never, expectedVersion: editing.version }), {
            success: "Setting saved",
            failure: "The setting was not saved",
          });
          await refresh();
          return ok !== undefined;
        }}
      />
      <SecretDialog
        view={secret}
        onClose={() => setSecretView(null)}
        onSave={async (value) => {
          if (!secret) return false;
          const ok = await guarded(() => setSecret.mutateAsync({ key: secret.key, value, expectedVersion: secret.version }), {
            success: "Secret saved",
            failure: "The secret was not saved",
          });
          await refresh();
          return ok !== undefined;
        }}
      />
      <ConfirmDialog
        open={clearing !== null}
        onOpenChange={(open) => (!open ? setClearing(null) : undefined)}
        destructive
        title={clearing ? `Remove ${clearing.label}?` : "Remove secret?"}
        description="Features that depend on this secret stop working until a new value is set."
        confirmLabel="Remove secret"
        onConfirm={async () => {
          if (!clearing) return;
          await guarded(() => setSecret.mutateAsync({ key: clearing.key, value: null, expectedVersion: clearing.version }), {
            success: "Secret removed",
            failure: "The secret was not removed",
          });
          setClearing(null);
          await refresh();
        }}
      />
    </>
  );
}
