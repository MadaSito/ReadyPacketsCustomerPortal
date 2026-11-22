import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, CodeBlock, ConfirmDialog, CopyField, DataTable, DateTime, Dialog, EmptyState, ErrorState,
  Field, Input, PageHeader, Select, Skeleton, StepUpCancelledError, TagInput, useStepUp,
} from "@/ui";
import { publicApiPages } from "./routes";

type Out = inferRouterOutputs<AppRouter>["publicApi"]["admin"];
type In = inferRouterInputs<AppRouter>["publicApi"]["admin"];
type Key = Out["keys"]["list"]["items"][number];
// Dates are coerced on the server, so the inferred input type is too loose to use for form state.
type KeyForm = Omit<In["keys"]["create"], "expiresAt"> & { expiresAt: Date | string | null };
type Scope = KeyForm["scopes"][number];
type LogRow = Out["log"]["list"]["items"][number];
type LogFilter = {
  search?: string;
  statusClass?: "2xx" | "3xx" | "4xx" | "5xx";
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  replay?: boolean;
  from?: Date;
  to?: Date;
  keyId?: string;
  correlationId?: string;
  cursor?: string | null;
  limit?: number;
};
type Feedback = { error: boolean; message: string };
type Secrets = { title: string; token?: string | null; signingSecret?: string | null };

const scopeLabels = {
  "customers:read": "Read customers",
  "orders:read": "Read orders",
  "orders:write": "Create and move orders",
  "files:read": "Read order file details",
  "invoices:read": "Read invoices",
  "tickets:read": "Read support tickets",
  "tickets:write": "Open support tickets",
  "knowledge:read": "Read published knowledge articles",
  "webhooks:read": "Read webhook subscriptions",
} satisfies Record<Scope, string>;
const scopes = Object.keys(scopeLabels) as Scope[];
const emptyForm: KeyForm = { name: "", scopes: [], expiresAt: null, ipAllowList: [], rateLimitPerMinute: 120, requireSigning: false };
const stateTone = { active: "success", revoked: "neutral", expired: "warning" } as const;
const stateLabel = { active: "Active", revoked: "Revoked", expired: "Expired" } as const;

function Page({ index, description, children }: { index: number; description: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-5">
    <PageHeader title={publicApiPages[index]?.title ?? "Public API"} description={description} />
    <nav aria-label="Public API sections" className="flex flex-wrap gap-2">
      {publicApiPages.map((item, i) => <Button key={item.path} asChild variant={i === index ? "secondary" : "ghost"}>
        <Link href={item.path} aria-current={i === index ? "page" : undefined}>{item.navigation}</Link>
      </Button>)}
    </nav>
    {children}
  </div>;
}

function Status({ feedback }: { feedback: Feedback | null }) {
  return feedback ? <Callout tone={feedback.error ? "danger" : "success"} live={feedback.error ? "assertive" : "polite"}>{feedback.message}</Callout> : null;
}

function useGuarded() {
  const stepUp = useStepUp();
  return async function guarded<T>(fn: () => Promise<T>, reason: string, onError: (message: string) => void): Promise<T | undefined> {
    try {
      return await stepUp.run(fn, { reason });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) onError(errorMessage(error));
      return undefined;
    }
  };
}

function SettingsCard() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const guarded = useGuarded();
  const query = useQuery(trpc.publicApi.admin.settings.get.queryOptions());
  const update = useMutation(trpc.publicApi.admin.settings.update.mutationOptions());
  const [retention, setRetention] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  if (query.isPending) return <Card title="API access"><Skeleton lines={2} /></Card>;
  if (query.isError) return <Card title="API access"><ErrorState error={query.error} onRetry={() => void query.refetch()} /></Card>;
  const data = query.data;
  const retentionValue = retention ?? String(data.retentionDays);
  async function save(enabled: boolean) {
    const days = Number(retentionValue);
    if (!Number.isInteger(days) || days < 1 || days > 90) { setFeedback({ error: true, message: "Enter a retention between 1 and 90 days." }); return; }
    const result = await guarded(() => update.mutateAsync({ expectedVersion: data.version, enabled, retentionDays: days }), "Changing API access affects every integration.", (message) => setFeedback({ error: true, message }));
    if (result) {
      qc.setQueryData(trpc.publicApi.admin.settings.get.queryKey(), result);
      setRetention(null);
      setFeedback({ error: false, message: enabled ? "The public API is on." : "The public API is off." });
    }
    void query.refetch();
  }
  return <Card title="API access" description="The public API is off until you turn it on. While it is off, every call returns not found.">
    <div className="grid min-w-0 gap-4">
      <p>Status: <Badge tone={data.enabled ? "success" : "neutral"}>{data.enabled ? "On" : "Off"}</Badge></p>
      <Field label="Keep request log for (days)" hint="Between 1 and 90 days. Older entries are removed every hour.">
        <Input type="number" inputMode="numeric" min={1} max={90} value={retentionValue} onChange={(e) => setRetention(e.target.value)} />
      </Field>
      <Status feedback={feedback} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant={data.enabled ? "secondary" : "primary"} onClick={() => setConfirm(true)}>{data.enabled ? "Turn the API off" : "Turn the API on"}</Button>
        <Button type="button" variant="secondary" disabled={retention === null} onClick={() => void save(data.enabled)}>Save retention</Button>
        <Button asChild variant="ghost"><a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI document</a></Button>
      </div>
    </div>
    {confirm ? <ConfirmDialog open onOpenChange={setConfirm} destructive={data.enabled} title={data.enabled ? "Turn the public API off?" : "Turn the public API on?"}
      description={data.enabled ? "Every integration using an API key stops working immediately." : "Active API keys can call the API within their scopes."}
      confirmLabel={data.enabled ? "Turn off" : "Turn on"} onConfirm={() => save(!data.enabled)} /> : null}
  </Card>;
}

function KeyFormFields({ form, onChange }: { form: KeyForm; onChange: (form: KeyForm) => void }) {
  return <div className="grid min-w-0 gap-4">
    <Field label="Name" hint="For example, the system that uses the key." required>
      <Input value={form.name} maxLength={120} autoComplete="off" onChange={(e) => onChange({ ...form, name: e.target.value })} />
    </Field>
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1 font-medium">Scopes</legend>
      <p className="text-sm text-ink-muted">Grant only what the integration needs.</p>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {scopes.map((scope) => <Checkbox key={scope} label={scopeLabels[scope]} description={scope} checked={form.scopes.includes(scope)}
          onCheckedChange={(checked) => onChange({ ...form, scopes: checked ? [...form.scopes, scope] : form.scopes.filter((s) => s !== scope) })} />)}
      </div>
    </fieldset>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <Field label="Expires (local time)" hint="Leave blank for no expiry.">
        <Input type="datetime-local" value={form.expiresAt ? toLocalInput(new Date(form.expiresAt)) : ""} onChange={(e) => onChange({ ...form, expiresAt: e.target.value ? new Date(e.target.value) : null })} />
      </Field>
      <Field label="Requests per minute" hint="Between 1 and 6,000.">
        <Input type="number" inputMode="numeric" min={1} max={6000} value={form.rateLimitPerMinute} onChange={(e) => onChange({ ...form, rateLimitPerMinute: Number(e.target.value) })} />
      </Field>
    </div>
    <TagInput label="Allowed IP addresses" hint="IP addresses or CIDR ranges, up to 50. Leave empty to allow any address." value={form.ipAllowList} max={50} maxLength={64}
      onValueChange={(ipAllowList) => onChange({ ...form, ipAllowList })} />
    <Checkbox label="Require signed requests" description="Callers must send X-RP-Timestamp and X-RP-Signature headers. A signing secret is shown once." checked={form.requireSigning}
      onCheckedChange={(requireSigning) => onChange({ ...form, requireSigning })} />
  </div>;
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function SecretsDialog({ secrets, onClose }: { secrets: Secrets; onClose: () => void }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={secrets.title} size="lg"
    description="Copy these values now and store them in your integration's secret store. They are not shown again."
    footer={<Button type="button" onClick={onClose}>I have stored them</Button>}>
    <div className="grid min-w-0 gap-4">
      {secrets.token ? <CopyField label="API key" value={secrets.token} monospace secret /> : null}
      {secrets.signingSecret ? <CopyField label="Signing secret" value={secrets.signingSecret} monospace secret /> : null}
      <Callout tone="warning">Anyone with this key can call the API within its scopes. Rotate or revoke it if it is exposed.</Callout>
    </div>
  </Dialog>;
}

function KeyDialog({ title, initial, confirmLabel, onSubmit, onClose }: { title: string; initial: KeyForm; confirmLabel: string; onSubmit: (form: KeyForm) => Promise<string | null>; onClose: () => void }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!form.name.trim()) { setError("Enter a name."); return; }
    if (form.scopes.length === 0) { setError("Choose at least one scope."); return; }
    setBusy(true);
    const failure = await onSubmit(form);
    setBusy(false);
    if (failure) setError(failure);
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={title} size="lg" dismissible={!busy}
    footer={<>
      <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button type="button" disabled={busy} onClick={() => void submit()}>{confirmLabel}</Button>
    </>}>
    <div className="grid min-w-0 gap-4">
      <KeyFormFields form={form} onChange={(next) => { setForm(next); setError(null); }} />
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
    </div>
  </Dialog>;
}

export function KeysPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const guarded = useGuarded();
  const [history, setHistory] = useState<string[]>([]);
  const query = useQuery(trpc.publicApi.admin.keys.list.queryOptions({ cursor: history.at(-1) }));
  const create = useMutation(trpc.publicApi.admin.keys.create.mutationOptions());
  const update = useMutation(trpc.publicApi.admin.keys.update.mutationOptions());
  const rotate = useMutation(trpc.publicApi.admin.keys.rotate.mutationOptions());
  const revoke = useMutation(trpc.publicApi.admin.keys.revoke.mutationOptions());
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; key: Key } | null>(null);
  const [confirm, setConfirm] = useState<{ action: "rotate" | "revoke"; key: Key } | null>(null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const refresh = () => void qc.invalidateQueries(trpc.publicApi.admin.keys.list.queryFilter());
  const reason = "Managing API keys changes who can reach portal data.";

  async function submit(form: KeyForm): Promise<string | null> {
    let failure: string | null = null;
    const onError = (message: string) => { failure = message; };
    if (dialog?.mode === "edit") {
      const result = await guarded(() => update.mutateAsync({ keyId: dialog.key.keyId, expectedVersion: dialog.key.version, key: form }), reason, onError);
      if (result) {
        setDialog(null);
        setFeedback({ error: false, message: `Saved ${result.key.name}.` });
        if (result.signingSecret) setSecrets({ title: "Signing secret created", signingSecret: result.signingSecret });
      }
    } else {
      const result = await guarded(() => create.mutateAsync(form), reason, onError);
      if (result) {
        setDialog(null);
        setFeedback({ error: false, message: `Created ${result.key.name}.` });
        setSecrets({ title: "API key created", token: result.token, signingSecret: result.signingSecret });
      }
    }
    refresh();
    return failure;
  }

  async function act() {
    if (!confirm) return;
    const { action, key } = confirm;
    const onError = (message: string) => setFeedback({ error: true, message });
    if (action === "rotate") {
      const result = await guarded(() => rotate.mutateAsync({ keyId: key.keyId, expectedVersion: key.version }), reason, onError);
      if (result) {
        setFeedback({ error: false, message: `Rotated ${key.name}. The previous key no longer works.` });
        setSecrets({ title: "API key rotated", token: result.token, signingSecret: result.signingSecret });
      }
    } else {
      const result = await guarded(() => revoke.mutateAsync({ keyId: key.keyId, expectedVersion: key.version }), reason, onError);
      if (result) setFeedback({ error: false, message: `Revoked ${key.name}.` });
    }
    setConfirm(null);
    refresh();
  }

  return <Page index={0} description="Create keys for systems that call the ReadyPackets API, and control what each key can reach.">
    <SettingsCard />
    <Status feedback={feedback} />
    <Card title="Keys" actions={<Button type="button" onClick={() => setDialog({ mode: "create" })}>Create API key</Button>}>
      <DataTable caption="API keys" rows={query.data?.items ?? []} rowKey={(k) => k.keyId} loading={query.isPending} error={query.error} onRetry={() => void query.refetch()}
        columns={[
          { key: "name", header: "Name", primary: true, cell: (k) => <span className="break-words">{k.name}</span> },
          { key: "prefix", header: "Key prefix", cell: (k) => <code className="break-all">{k.prefix}</code> },
          { key: "state", header: "Status", cell: (k) => <Badge tone={stateTone[k.state]}>{stateLabel[k.state]}</Badge> },
          { key: "scopes", header: "Scopes", cell: (k) => <span className="break-words">{k.scopes.join(", ")}</span> },
          { key: "used", header: "Last used", cell: (k) => (k.lastUsedAt ? <DateTime value={k.lastUsedAt} /> : "Never") },
          { key: "expires", header: "Expires", cell: (k) => (k.expiresAt ? <DateTime value={k.expiresAt} /> : "No expiry") },
        ]}
        empty={<EmptyState title="No API keys yet" description="Create a key to connect another system." headingLevel={3} />}
        rowActions={(k) => k.state === "revoked" ? null : <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDialog({ mode: "edit", key: k })} aria-label={`Edit ${k.name}`}>Edit</Button>
          <Button variant="secondary" onClick={() => setConfirm({ action: "rotate", key: k })} aria-label={`Rotate ${k.name}`}>Rotate</Button>
          <Button variant="secondary" onClick={() => setConfirm({ action: "revoke", key: k })} aria-label={`Revoke ${k.name}`}>Revoke</Button>
        </div>} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={history.length === 0} onClick={() => setHistory((h) => h.slice(0, -1))}>Previous page</Button>
        <Button variant="secondary" disabled={!query.data?.nextCursor} onClick={() => { const next = query.data?.nextCursor; if (next) setHistory((h) => [...h, next]); }}>Next page</Button>
      </div>
    </Card>
    {dialog ? <KeyDialog title={dialog.mode === "create" ? "Create API key" : `Edit ${dialog.key.name}`} confirmLabel={dialog.mode === "create" ? "Create key" : "Save key"}
      initial={dialog.mode === "create" ? emptyForm : { name: dialog.key.name, scopes: dialog.key.scopes, expiresAt: dialog.key.expiresAt, ipAllowList: dialog.key.ipAllowList, rateLimitPerMinute: dialog.key.rateLimitPerMinute, requireSigning: dialog.key.requireSigning }}
      onSubmit={submit} onClose={() => setDialog(null)} /> : null}
    {confirm ? <ConfirmDialog open onOpenChange={(open) => { if (!open) setConfirm(null); }} destructive
      title={confirm.action === "rotate" ? `Rotate ${confirm.key.name}?` : `Revoke ${confirm.key.name}?`}
      description={confirm.action === "rotate" ? "A new key is issued and the current key stops working immediately. Update the integration right away." : "The key stops working immediately. This cannot be undone."}
      confirmLabel={confirm.action === "rotate" ? "Rotate key" : "Revoke key"} onConfirm={act} /> : null}
    {secrets ? <SecretsDialog secrets={secrets} onClose={() => setSecrets(null)} /> : null}
  </Page>;
}

const emptyFilter = { search: "", statusClass: "", method: "", from: "", to: "", replay: "" };
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

function statusTone(status: number) {
  return status >= 500 ? "danger" : status >= 400 ? "warning" : "success";
}

export function LogPage() {
  const trpc = useTRPC();
  const [form, setForm] = useState(emptyFilter);
  const [filter, setFilter] = useState<LogFilter>({});
  const [history, setHistory] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const query = useQuery(trpc.publicApi.admin.log.list.queryOptions({ ...filter, cursor: history.at(-1), limit: 25 }));
  const set = (name: keyof typeof emptyFilter, value: string) => setForm((f) => ({ ...f, [name]: value }));
  function apply() {
    const from = form.from ? new Date(form.from) : undefined;
    const to = form.to ? new Date(form.to) : undefined;
    if (from && to && from > to) { setFeedback({ error: true, message: "Enter an end date on or after the start date." }); return; }
    setFeedback(null);
    setFilter({
      search: form.search.trim() || undefined,
      statusClass: (form.statusClass || undefined) as LogFilter["statusClass"],
      method: (form.method || undefined) as LogFilter["method"],
      replay: form.replay === "" ? undefined : form.replay === "yes",
      from, to,
    });
    setHistory([]);
  }
  return <Page index={1} description="Review calls made with API keys. Request and response details are stored encrypted and shown with sensitive fields hidden.">
    <Card title="Filter requests">
      <form className="grid min-w-0 gap-4" onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Search" hint="Path, route, error code or request ID."><Input value={form.search} maxLength={100} onChange={(e) => set("search", e.target.value)} /></Field>
          <Field label="Status"><Select options={[{ value: "", label: "Any status" }, ...["2xx", "3xx", "4xx", "5xx"].map((v) => ({ value: v, label: v }))]} value={form.statusClass} onChange={(e) => set("statusClass", e.target.value)} /></Field>
          <Field label="Method"><Select options={[{ value: "", label: "Any method" }, ...methods.map((v) => ({ value: v, label: v }))]} value={form.method} onChange={(e) => set("method", e.target.value)} /></Field>
          <Field label="Replays"><Select options={[{ value: "", label: "All requests" }, { value: "yes", label: "Only replays" }, { value: "no", label: "Exclude replays" }]} value={form.replay} onChange={(e) => set("replay", e.target.value)} /></Field>
          <Field label="From (local time)"><Input type="datetime-local" value={form.from} onChange={(e) => set("from", e.target.value)} /></Field>
          <Field label="To (local time)"><Input type="datetime-local" value={form.to} onChange={(e) => set("to", e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Apply filters</Button>
          <Button type="button" variant="secondary" onClick={() => { setForm(emptyFilter); setFilter({}); setHistory([]); setFeedback(null); }}>Clear filters</Button>
        </div>
      </form>
    </Card>
    <Status feedback={feedback} />
    <Card title="Requests">
      <DataTable caption="API requests" rows={query.data?.items ?? []} rowKey={(r: LogRow) => r.requestId} loading={query.isPending} error={query.error} onRetry={() => void query.refetch()}
        columns={[
          { key: "time", header: "Time", primary: true, cell: (r: LogRow) => <Link href={`/admin/api/log/${r.requestId}`} className="underline underline-offset-2"><DateTime value={r.createdAt} /></Link> },
          { key: "request", header: "Request", cell: (r: LogRow) => <span className="break-all">{r.method} {r.path}</span> },
          { key: "status", header: "Status", cell: (r: LogRow) => <Badge tone={statusTone(r.status)}>{r.status}{r.errorCode ? ` ${r.errorCode}` : ""}</Badge> },
          { key: "duration", header: "Duration", cell: (r: LogRow) => `${r.durationMs} ms` },
          { key: "replay", header: "Replay", cell: (r: LogRow) => (r.replayOf ? "Replay" : "Original") },
        ]}
        empty={<EmptyState title="No requests match these filters" headingLevel={3} />} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={history.length === 0 || query.isPending} onClick={() => setHistory((h) => h.slice(0, -1))}>Previous page</Button>
        <Button variant="secondary" disabled={!query.data?.nextCursor || query.isPending} onClick={() => { const next = query.data?.nextCursor; if (next) setHistory((h) => [...h, next]); }}>Next page</Button>
      </div>
    </Card>
  </Page>;
}

export function RequestDetailPage() {
  const trpc = useTRPC();
  const guarded = useGuarded();
  const { requestId = "" } = useParams<{ requestId: string }>();
  const query = useQuery(trpc.publicApi.admin.log.get.queryOptions({ requestId }));
  const replay = useMutation(trpc.publicApi.admin.log.replay.mutationOptions());
  const [confirm, setConfirm] = useState(false);
  const [feedback, setFeedback] = useState<ReactNode>(null);
  const write = query.data ? !["GET", "HEAD"].includes(query.data.method) : false;
  async function run() {
    const result = await guarded(() => replay.mutateAsync({ requestId, confirmWrite: write }), "Replaying runs the call again with the key's current permissions.",
      (message) => setFeedback(<Callout tone="danger" live="assertive">{message}</Callout>));
    if (result) {
      setFeedback(<Callout tone="success" live="polite">Replay finished with status {result.status}.{" "}
        {result.requestId ? <Link href={`/admin/api/log/${result.requestId}`} className="underline underline-offset-2">View the replay</Link> : null}</Callout>);
      void query.refetch();
    }
    setConfirm(false);
  }
  return <div className="grid min-w-0 gap-5">
    <PageHeader title="API request details" description="Sensitive values are hidden. The exact original body is never shown." />
    <p><Link href="/admin/api/log" className="underline underline-offset-2">Back to the request log</Link></p>
    {query.isPending ? <Skeleton lines={6} /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <>
      <Card title="Summary">
        <dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
          {([
            ["Request ID", <code key="id" className="break-all">{query.data.requestId}</code>],
            ["Time", <DateTime key="t" value={query.data.createdAt} />],
            ["Request", <span key="r" className="break-all">{query.data.method} {query.data.path}</span>],
            ["Route", <span key="ro" className="break-all">{query.data.route}</span>],
            ["Status", <Badge key="s" tone={statusTone(query.data.status)}>{query.data.status}{query.data.errorCode ? ` ${query.data.errorCode}` : ""}</Badge>],
            ["Duration", `${query.data.durationMs} ms`],
            ["Key", query.data.keyId ?? "None"],
            ["Client address", query.data.ipAddress ?? "Unknown"],
            ["Replay of", query.data.replayOf ? <Link key="ro2" href={`/admin/api/log/${query.data.replayOf}`} className="break-all underline underline-offset-2">{query.data.replayOf}</Link> : "Original request"],
          ] as const).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-sm text-ink-muted">{label}</dt><dd className="min-w-0">{value}</dd></div>)}
        </dl>
      </Card>
      <Card title="Request"><CodeBlock label="Request, redacted" wrap>{JSON.stringify(query.data.request, null, 2)}</CodeBlock></Card>
      <Card title="Response"><CodeBlock label="Response, redacted" wrap>{JSON.stringify(query.data.response, null, 2)}</CodeBlock></Card>
      <Card title="Replay" description="Runs the call again with the key's current scopes. The key must still be active.">
        <div className="grid min-w-0 gap-3">
          {query.data.replayable ? null : <Callout tone="info">This call cannot be replayed. Only calls that passed every check can be replayed, and writes only when they completed.</Callout>}
          {feedback}
          <div><Button type="button" disabled={!query.data.replayable || replay.isPending} onClick={() => setConfirm(true)}>Replay request</Button></div>
          {query.data.replays.length ? <ul className="grid gap-1" aria-label="Earlier replays">
            {query.data.replays.map((r) => <li key={r.requestId}><Link href={`/admin/api/log/${r.requestId}`} className="underline underline-offset-2"><DateTime value={r.createdAt} /></Link> · status {r.status}</li>)}
          </ul> : null}
        </div>
      </Card>
      {confirm ? <ConfirmDialog open onOpenChange={setConfirm} destructive={write} title="Replay this request?"
        description={write ? "This is a write call. Replaying it can change data again, such as creating another order." : "The call is read-only and runs again with the key's current scopes."}
        confirmLabel="Replay request" onConfirm={run} /> : null}
    </>}
  </div>;
}
