/** Console → Cookies and consent (increment 04, package J). Owner: platform engineer. Admin only; the server re-checks. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { safeError, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  DateTime,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
  StatCard,
  StatGrid,
  type Column,
} from "@/ui";
import type { SettingView } from "../model";
import { PlatformNav } from "../PlatformNav";
import { SettingEditDialog, type SaveOutcome } from "../SettingDialogs";
import { useGuarded } from "../useGuarded";

const ACTIONS = [
  { value: "", label: "Any action" },
  { value: "accept_all", label: "Accepted all" },
  { value: "reject_all", label: "Rejected all" },
  { value: "save", label: "Saved choices" },
  { value: "withdraw", label: "Withdrew" },
];
const SOURCES = [
  { value: "", label: "Any source" },
  { value: "banner", label: "Banner" },
  { value: "preferences", label: "Preference centre" },
  { value: "account", label: "Account page" },
  { value: "gpc", label: "Browser privacy signal" },
];
const ACTION_LABEL: Record<string, string> = Object.fromEntries(ACTIONS.slice(1).map((a) => [a.value, a.label]));
const SOURCE_LABEL: Record<string, string> = Object.fromEntries(SOURCES.slice(1).map((s) => [s.value, s.label]));

interface Stats {
  total: number;
  acceptance: { preferences: number; analytics: number; session_replay: number };
  gpc: number;
  byAction: Record<string, number>;
}
interface LedgerRow {
  publicId: string;
  consentId: string;
  userPublicId: string | null;
  policyVersion: number;
  choices: { preferences: boolean; analytics: boolean; session_replay: boolean };
  action: string;
  source: string;
  gpc: boolean;
  createdAt: Date | string;
}
interface Filters {
  from: string;
  to: string;
  action: string;
  source: string;
  consentId: string;
  userPublicId: string;
}
const EMPTY: Filters = { from: "", to: "", action: "", source: "", consentId: "", userPublicId: "" };

const pct = (n: number) => `${Math.round(n * 100)}%`;

function toInput(f: Filters) {
  return {
    ...(f.from ? { from: new Date(`${f.from}T00:00:00`) } : {}),
    ...(f.to ? { to: new Date(`${f.to}T23:59:59`) } : {}),
    ...(f.action ? { action: f.action as "save" } : {}),
    ...(f.source ? { source: f.source as "banner" } : {}),
    ...(f.consentId.trim() ? { consentId: f.consentId.trim() } : {}),
    ...(f.userPublicId.trim() ? { userPublicId: f.userPublicId.trim() } : {}),
  };
}

function summary(view: SettingView): string {
  if (Array.isArray(view.value)) return `${view.value.length} ${view.value.length === 1 ? "item" : "items"}`;
  return String(view.value ?? view.defaultValue ?? "");
}

export default function ConsentAdminPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const guarded = useGuarded();
  const stats = useQuery(trpc.platform.admin.consent.stats.queryOptions({ days: 30 }));
  const settings = useQuery(trpc.platform.admin.settings.list.queryOptions({ group: "privacy" }));
  const update = useMutation(trpc.platform.admin.settings.update.mutationOptions());
  const exportCsv = useMutation(trpc.platform.admin.consent.export.mutationOptions());
  const [editing, setEditing] = useState<SettingView | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const ledger = useQuery(trpc.platform.admin.consent.search.queryOptions({ ...toInput(filters), limit: 25, ...(cursor ? { cursor } : {}) }));
  const page = ledger.data as { items: LedgerRow[]; nextCursor: number | null } | undefined;
  const s = stats.data as Stats | undefined;
  const views = ((settings.data ?? []) as SettingView[]).filter((v) => v.kind === "value");

  const columns: Column<LedgerRow>[] = [
    { key: "time", header: "Time", primary: true, cell: (r) => <DateTime value={r.createdAt} format="datetime" /> },
    { key: "action", header: "Action", cell: (r) => ACTION_LABEL[r.action] ?? r.action },
    {
      key: "choices",
      header: "Allowed",
      cell: (r) =>
        [r.choices.preferences && "Preferences", r.choices.analytics && "Analytics", r.choices.session_replay && "Session replay"].filter(Boolean).join(", ") || "None",
    },
    { key: "source", header: "Source", cell: (r) => (r.gpc ? <Badge tone="info">{SOURCE_LABEL[r.source] ?? r.source} · signal</Badge> : (SOURCE_LABEL[r.source] ?? r.source)) },
    { key: "version", header: "Policy", align: "end", cell: (r) => `v${r.policyVersion}` },
    { key: "who", header: "Person", hideOnMobile: false, cell: (r) => <span className="font-mono text-xs break-all">{r.userPublicId ?? "Anonymous"}</span> },
    { key: "id", header: "Consent id", cell: (r) => <span className="font-mono text-xs break-all">{r.consentId}</span> },
  ];

  async function runExport() {
    const result = await guarded(() => exportCsv.mutateAsync(toInput(filters)), {
      success: "Export ready",
      failure: "The export failed",
      reason: "Exporting the consent ledger needs verification.",
    });
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "consent-ledger.csv";
    a.rel = "noopener";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <>
      <PageHeader title="Cookies and consent" description="The cookie banner, the list of cookies and tools, and the record of every visitor's choice." />
      <PlatformNav />
      <Callout tone="info" className="mb-6">
        Turn the banner on or off on the <Link href="/admin/settings/features" className="font-medium underline">Features</Link> page. Optional tools never run before a visitor chooses.
      </Callout>

      <div className="grid gap-6">
        <section aria-labelledby="consent-stats-title">
          <h2 id="consent-stats-title" className="mb-3 text-lg font-semibold text-ink">
            Last 30 days
          </h2>
          {stats.error ? (
            <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
          ) : (
            <StatGrid label="Consent statistics">
              <StatCard label="Decisions" value={s ? s.total : "–"} loading={stats.isPending} />
              <StatCard label="Allowed analytics" value={s ? pct(s.acceptance.analytics) : "–"} loading={stats.isPending} />
              <StatCard label="Allowed session replay" value={s ? pct(s.acceptance.session_replay) : "–"} loading={stats.isPending} />
              <StatCard label="Browser privacy signal" value={s ? s.gpc : "–"} hint="Rejected automatically" loading={stats.isPending} />
            </StatGrid>
          )}
        </section>

        <Card title="Policy and cookie list" description="Raising the policy version asks everyone again. Each change needs verification and is audited.">
          {settings.isPending ? (
            <div aria-busy="true">
              <Skeleton lines={4} />
            </div>
          ) : settings.error ? (
            <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <ul className="divide-y divide-line">
              {views.map((v) => (
                <li key={v.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{v.label}</p>
                    <p className="text-sm text-body break-words">{v.description}</p>
                    <p className="mt-1 text-sm text-ink">Current: {summary(v)}</p>
                  </div>
                  <Button variant="secondary" size="sm" aria-label={`Edit ${v.label}`} onClick={() => setEditing(v)}>
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Consent ledger" description="Every decision, without IP addresses. Consent ids group one browser's choices; they do not identify a person.">
          <form
            className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              setFilters(draft);
              setCursors([undefined]);
            }}
          >
            <Field label="From">
              <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </Field>
            <Field label="Action">
              <Select options={ACTIONS} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
            </Field>
            <Field label="Source">
              <Select options={SOURCES} value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
            </Field>
            <Field label="Consent id">
              <Input value={draft.consentId} maxLength={22} autoComplete="off" spellCheck={false} onChange={(e) => setDraft({ ...draft, consentId: e.target.value })} />
            </Field>
            <Field label="Person id">
              <Input value={draft.userPublicId} maxLength={32} autoComplete="off" spellCheck={false} onChange={(e) => setDraft({ ...draft, userPublicId: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
              <Button type="submit">Apply filters</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(EMPTY);
                  setFilters(EMPTY);
                  setCursors([undefined]);
                }}
              >
                Clear
              </Button>
              <Button variant="secondary" loading={exportCsv.isPending} onClick={() => void runExport()}>
                Export CSV
              </Button>
            </div>
          </form>
          <DataTable
            caption="Consent decisions"
            columns={columns}
            rows={page?.items ?? []}
            rowKey={(r) => r.publicId}
            loading={ledger.isPending}
            error={ledger.error}
            onRetry={() => void ledger.refetch()}
            empty={<p className="py-4 text-sm text-body">No decisions match these filters.</p>}
          />
          <Pagination
            label="Consent ledger pages"
            hasPrevious={cursors.length > 1}
            hasNext={Boolean(page?.nextCursor)}
            onPrevious={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => page?.nextCursor && setCursors((c) => [...c, page.nextCursor ?? undefined])}
            loading={ledger.isFetching}
          />
        </Card>
      </div>

      <SettingEditDialog
        view={editing}
        onClose={() => setEditing(null)}
        onSave={async (value): Promise<SaveOutcome> => {
          if (!editing) return { ok: false };
          let fields: readonly string[] | undefined;
          const ok = await guarded(() => update.mutateAsync({ key: editing.key, value: value as never, expectedVersion: editing.version }), {
            success: "Saved",
            failure: "The change was not saved",
            reason: "Changing cookie settings needs verification.",
            onError: (error) => {
              const rejected = safeError(error)?.details?.fields;
              if (Array.isArray(rejected)) fields = rejected.filter((f): f is string => typeof f === "string").slice(0, 20);
            },
          });
          await client.invalidateQueries({ queryKey: trpc.platform.admin.settings.list.queryKey() });
          await client.invalidateQueries({ queryKey: trpc.platform.bootstrap.queryKey() });
          return ok !== undefined ? { ok: true } : { ok: false, ...(fields ? { fields } : {}) };
        }}
      />
    </>
  );
}
