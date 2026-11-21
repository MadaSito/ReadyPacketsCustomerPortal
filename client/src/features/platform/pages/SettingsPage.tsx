import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Settings2 } from "lucide-react";
import { Link } from "wouter";
import { safeError, useTRPC } from "@/lib/trpc";
import { Badge, Button, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, buttonClasses, cn } from "@/ui";
import { displayValue, groupLabel, managedPage, matchesSearch, type SettingView } from "../model";
import { PlatformNav } from "../PlatformNav";
import { SecretDialog, SettingEditDialog, type SaveOutcome } from "../SettingDialogs";
import { useGuarded } from "../useGuarded";

export interface SettingsViewProps {
  views: SettingView[];
  onEdit: (view: SettingView) => void;
  onSetSecret: (view: SettingView) => void;
  onClearSecret: (view: SettingView) => void;
  /** Groups whose table is hidden (disclosure collapsed). */
  collapsed?: ReadonlySet<string>;
  onToggleGroup?: (group: string) => void;
}

/** Grouped, collapsible settings tables. Secret values are never present here — only whether one is configured. */
export function SettingsView({ views, onEdit, onSetSecret, onClearSecret, collapsed, onToggleGroup }: SettingsViewProps) {
  const groups = useMemo(() => {
    const map = new Map<string, SettingView[]>();
    for (const view of views) map.set(view.group, [...(map.get(view.group) ?? []), view]);
    return [...map.entries()];
  }, [views]);
  if (groups.length === 0) {
    return <EmptyState icon={Settings2} title="No matching settings" description="Try another search term or clear the search." />;
  }
  return (
    <div className="space-y-6">
      {groups.map(([group, rows]) => {
        const open = !collapsed?.has(group);
        const panelId = `settings-group-${group}`;
        return (
          <section key={group} aria-labelledby={`${panelId}-h`} className="min-w-0">
            <h2 id={`${panelId}-h`} className="text-lg font-semibold text-ink">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => onToggleGroup?.(group)}
                className="flex w-full items-center gap-2 rounded-[var(--radius-control)] py-2 text-left hover:text-action-hover"
              >
                <ChevronRight aria-hidden="true" className={cn("size-5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
                <span className="min-w-0 flex-1 break-words">{groupLabel(group)}</span>
                <Badge tone="neutral">{rows.length}</Badge>
              </button>
            </h2>
            <div id={panelId} hidden={!open} className="mt-3">
              <SettingsTable group={group} rows={rows} onEdit={onEdit} onSetSecret={onSetSecret} onClearSecret={onClearSecret} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SettingsTable({ group, rows, onEdit, onSetSecret, onClearSecret }: { group: string; rows: SettingView[] } & Pick<SettingsViewProps, "onEdit" | "onSetSecret" | "onClearSecret">) {
  return (
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
          cell: (v) => {
            const page = managedPage(v);
            if (page) return <Badge tone="info">Managed on {page.label}</Badge>;
            return v.kind === "secret" ? (
              v.configured ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not configured</Badge>
            ) : (
              <span className="break-all font-mono text-sm text-body">
                {displayValue(v.value)}
                {v.invalidStored ? <Badge tone="warning" className="ml-2">Invalid stored value</Badge> : null}
              </span>
            );
          },
        },
        { key: "updated", header: "Last changed", hideOnMobile: true, cell: (v) => (v.updatedAt ? <DateTime value={v.updatedAt} format="relative" /> : "Default") },
      ]}
      rowActions={(v) => {
        const page = managedPage(v);
        if (page) {
          return (
            <Link href={page.href} className={buttonClasses({ variant: "ghost", size: "sm" })} aria-label={`Open ${page.label} to change ${v.label}`}>
              Open {page.label}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          );
        }
        return v.kind === "secret" ? (
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
        );
      }}
    />
  );
}

export default function SettingsPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const guarded = useGuarded();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const list = useQuery(trpc.platform.admin.settings.list.queryOptions());
  const update = useMutation(trpc.platform.admin.settings.update.mutationOptions());
  const setSecret = useMutation(trpc.platform.admin.settings.setSecret.mutationOptions());
  const [editing, setEditing] = useState<SettingView | null>(null);
  const [secret, setSecretView] = useState<SettingView | null>(null);
  const [clearing, setClearing] = useState<SettingView | null>(null);

  const views = list.data as SettingView[] | undefined;
  const groups = useMemo(() => [...new Set((views ?? []).map((v) => v.group))], [views]);
  const visible = (views ?? []).filter((v) => matchesSearch(v, query));
  // While searching every group with a match is open, so results are never hidden.
  const effectiveCollapsed = query.trim() ? new Set<string>() : collapsed;
  const toggle = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
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
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="w-full sm:max-w-sm">
              <Field label="Search settings" hint="Matches names, descriptions and keys.">
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} maxLength={100} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setCollapsed(new Set())} disabled={Boolean(query.trim())}>Expand all</Button>
              <Button size="sm" variant="secondary" onClick={() => setCollapsed(new Set(groups))} disabled={Boolean(query.trim())}>Collapse all</Button>
            </div>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {query.trim() ? `${visible.length} ${visible.length === 1 ? "setting matches" : "settings match"}` : ""}
          </p>
          <SettingsView views={visible} onEdit={setEditing} onSetSecret={setSecretView} onClearSecret={setClearing} collapsed={effectiveCollapsed} onToggleGroup={toggle} />
        </>
      )}
      <SettingEditDialog
        view={editing}
        onClose={() => setEditing(null)}
        onSave={async (value): Promise<SaveOutcome> => {
          if (!editing) return { ok: false };
          let fields: readonly string[] | undefined;
          const ok = await guarded(() => update.mutateAsync({ key: editing.key, value: value as never, expectedVersion: editing.version }), {
            success: "Setting saved",
            failure: "The setting was not saved",
            onError: (error) => {
              const rejected = safeError(error)?.details?.fields;
              if (Array.isArray(rejected)) fields = rejected.filter((f): f is string => typeof f === "string").slice(0, 20);
            },
          });
          await refresh();
          return ok !== undefined ? { ok: true } : { ok: false, ...(fields ? { fields } : {}) };
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
