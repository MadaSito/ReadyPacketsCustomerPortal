import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState,
  Field, Input, PageHeader, Select, Skeleton, StatCard, StatGrid, StepUpCancelledError, TagInput, useStepUp,
} from "@/ui";
import { protectionPages } from "./routes";

type Out = inferRouterOutputs<AppRouter>["protection"];
type In = inferRouterInputs<AppRouter>["protection"];
type Policy = Out["getPolicy"]["policy"];
type Rule = Policy["custom"][number];
type IpEntry = Policy["ipLists"][number];
type Group = keyof Policy["managed"];
type Event = Out["listEvents"]["items"][number];
type EventFilter = In["exportEvents"];
type Feedback = { error: boolean; message: string };
const groupLabels = { injection: "Injection patterns", traversal: "Path traversal", protocol: "Protocol anomalies", scanner: "Scanners and bad agents", oversize: "Oversized requests" } satisfies Record<Group, string>;
const groups = Object.keys(groupLabels) as Group[];
const headerNames = ["user-agent", "content-type", "accept", "accept-language", "sec-fetch-site"] as const;
const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
const modes = [{ value: "off", label: "Off" }, { value: "detect", label: "Detect" }, { value: "block", label: "Block" }];

function Page({ index, description, children }: { index: number; description: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-5">
    <PageHeader title={protectionPages[index]?.title ?? "Protection"} description={description} />
    <nav aria-label="Protection sections" className="flex flex-wrap gap-2">
      {protectionPages.map((item, i) => <Button key={item.path} asChild variant={i === index ? "secondary" : "ghost"}>
        <Link href={item.path} aria-current={i === index ? "page" : undefined}>{item.navigation}</Link>
      </Button>)}
    </nav>
    {children}
  </div>;
}

function Status({ feedback }: { feedback: Feedback | null }) {
  return feedback ? <Callout tone={feedback.error ? "danger" : "success"} live={feedback.error ? "assertive" : "polite"}>{feedback.message}</Callout> : null;
}

function useReleaseFocus(rows: readonly { publicId: string }[] | undefined, dialogOpen: boolean) {
  const headingId = useId();
  const [releasedId, setReleasedId] = useState<string | null>(null);
  useEffect(() => {
    if (!releasedId || dialogOpen || !rows || rows.some((row) => row.publicId === releasedId)) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body) document.getElementById(headingId)?.focus();
      setReleasedId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [dialogOpen, headingId, releasedId, rows]);
  return { headingId, setReleasedId };
}

function PolicyEditor({ children }: { children: (policy: Policy, update: (next: Policy) => void) => ReactNode }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const query = useQuery(trpc.protection.getPolicy.queryOptions());
  const mutation = useMutation(trpc.protection.setPolicy.mutationOptions());
  const [draft, setDraft] = useState<Out["getPolicy"] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const form = draft ?? query.data;
  const stale = Boolean(draft && query.data && draft.version !== query.data.version);

  async function save() {
    if (!draft || stale) return;
    try {
      const result = await stepUp.run(() => mutation.mutateAsync(draft), { reason: "Changing protection can affect access to the portal." });
      qc.setQueryData(trpc.protection.getPolicy.queryKey(), result);
      void qc.invalidateQueries(trpc.protection.overview.queryFilter());
      setDraft(null);
      setFeedback({ error: false, message: "Protection policy saved." });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) setFeedback({ error: true, message: errorMessage(error) });
      void query.refetch();
    }
  }

  if (query.isPending) return <Skeleton lines={4} />;
  if (query.isError || !form) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <div className="grid min-w-0 gap-4">
    {children(form.policy, (policy) => { setDraft({ version: form.version, policy }); setFeedback(null); })}
    {stale ? <Callout tone="warning" live="polite">Another administrator saved a newer policy. Discard your draft to continue.</Callout> : null}
    <Status feedback={feedback} />
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={!draft || stale} onClick={() => setConfirm(true)}>Review policy changes</Button>
      <Button type="button" variant="secondary" disabled={!draft} onClick={() => { setDraft(null); setFeedback(null); }}>Discard changes</Button>
    </div>
    {confirm ? <ConfirmDialog open onOpenChange={setConfirm} destructive={form.policy.mode === "enforce"} title="Save protection policy?"
      description="Changes apply to all requests. Make sure your current administrative access remains available." confirmLabel="Save protection policy" onConfirm={save} /> : null}
  </div>;
}

export function OverviewPage() {
  const trpc = useTRPC();
  const overview = useQuery(trpc.protection.overview.queryOptions());
  return <Page index={0} description="Review abuse signals and manage application-level safeguards.">
    {overview.isPending ? <Skeleton lines={3} /> : overview.isError ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : <>
      <StatGrid label="24-hour sample">
        <StatCard label="Current mode" value={overview.data.bypassed ? "Emergency bypass" : overview.data.mode === "detect" ? "Detect only" : "Enforce"} />
        <StatCard label="Sampled detections" value={overview.data.detected} hint="Last 24 hours; not a total request count." />
        <StatCard label="Sampled blocks" value={overview.data.blocked} hint="Last 24 hours; not a total request count." />
        <StatCard label="Country source" value={overview.data.countrySourceConfigured ? "Configured" : "Not configured"} hint="Configuration does not guarantee a lookup result." />
      </StatGrid>
      {overview.data.bypassed ? <Callout tone="warning" title="Emergency bypass is active">Host configuration has disabled protection rules and restored default rate budgets.</Callout> : null}
    </>}
    <Card title="How protection works">
      <p>Detect mode records a sample without blocking traffic. Enforce mode applies configured blocks. These controls supplement a network firewall; they do not replace one.</p>
    </Card>
  </Page>;
}

function RuleEditor({ rule, index, onChange, remove }: { rule: Rule; index: number; onChange: (rule: Rule) => void; remove: () => void }) {
  const fixedOperator = rule.field === "ip" || rule.field === "country";
  return <Card title={`Custom rule ${index + 1}`} headingLevel={3} actions={<Button variant="ghost" onClick={remove} aria-label={`Remove custom rule ${index + 1}`}>Remove</Button>}>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <Field label="Rule name" required><Input value={rule.label} maxLength={160} onChange={(e) => onChange({ ...rule, label: e.target.value })} /></Field>
      <Field label="Request field"><Select value={rule.field} options={options(["path", "method", "header", "query", "ip", "country"])}
        onChange={(e) => {
          const field = e.target.value as Rule["field"];
          onChange({
            id: rule.id, label: rule.label, value: rule.value, action: rule.action,
            field, ...(field === "header" ? { header: "user-agent" } : {}), operator: "exact",
          });
        }} /></Field>
      {rule.field === "header" ? <Field label="Header name"><Select options={options(headerNames)} value={rule.header}
        onChange={(e) => onChange({ ...rule, header: e.target.value as Rule["header"] })} /></Field> : null}
      <Field label="Match type"><Select value={rule.operator} options={options(fixedOperator ? ["exact"] : ["exact", "prefix", "contains"])}
        onChange={(e) => onChange({ ...rule, operator: e.target.value as Rule["operator"] })} /></Field>
      <Field label="Match value" hint="Literal text. Use a CIDR for IP ranges or a two-letter code for countries." required>
        <Input value={rule.value} maxLength={160} onChange={(e) => onChange({ ...rule, value: rule.field === "country" ? e.target.value.toUpperCase() : e.target.value })} />
      </Field>
      <Field label="Action"><Select options={[{ value: "log", label: "Detect only" }, { value: "block", label: "Block in enforce mode" }]} value={rule.action}
        onChange={(e) => onChange({ ...rule, action: e.target.value as Rule["action"] })} /></Field>
    </div>
  </Card>;
}

export function RulesPage() {
  return <Page index={1} description="Choose how managed and custom rules evaluate incoming requests.">
    <PolicyEditor>{(policy, update) => <>
      <Card title="Managed rules">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field label="Protection mode" hint="Detect mode never blocks requests.">
            <Select options={[{ value: "detect", label: "Detect only" }, { value: "enforce", label: "Enforce" }]} value={policy.mode}
              onChange={(e) => update({ ...policy, mode: e.target.value as Policy["mode"] })} />
          </Field>
          {groups.map((group) => <Field key={group} label={groupLabels[group]}>
            <Select options={modes} value={policy.managed[group]} onChange={(e) => update({ ...policy, managed: { ...policy.managed, [group]: e.target.value as Policy["managed"][Group] } })} />
          </Field>)}
        </div>
      </Card>
      <Card title="Custom rules" description="Match a literal value. Rules never run regular expressions." actions={
        <Button variant="secondary" disabled={policy.custom.length >= 32} onClick={() => update({
          ...policy, custom: [...policy.custom, { id: crypto.randomUUID(), label: "", field: "path", operator: "exact", value: "", action: "log" }],
        })}>Add rule</Button>
      }>
        <div className="grid min-w-0 gap-3">
          {policy.custom.length ? policy.custom.map((rule, index) => <RuleEditor key={rule.id} rule={rule} index={index}
            onChange={(next) => update({ ...policy, custom: policy.custom.map((r) => r.id === rule.id ? next : r) })}
            remove={() => update({ ...policy, custom: policy.custom.filter((r) => r.id !== rule.id) })} />) :
            <EmptyState title="No custom rules" description="Managed rules still apply." headingLevel={3} />}
        </div>
      </Card>
    </>}</PolicyEditor>
  </Page>;
}

function IpEntryEditor({ entry, index, onChange, remove }: { entry: IpEntry; index: number; onChange: (entry: IpEntry) => void; remove: () => void }) {
  return <Card title={`IP entry ${index + 1}`} headingLevel={3} actions={<Button variant="ghost" onClick={remove} aria-label={`Remove IP entry ${index + 1}`}>Remove</Button>}>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <Field label="IP address or CIDR" required><Input value={entry.network} maxLength={48} onChange={(e) => onChange({ ...entry, network: e.target.value })} /></Field>
      <Field label="List"><Select value={entry.action} options={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]}
        onChange={(e) => onChange({ ...entry, action: e.target.value as IpEntry["action"] })} /></Field>
      <Field label="Reason" required><Input value={entry.reason} maxLength={160} onChange={(e) => onChange({ ...entry, reason: e.target.value })} /></Field>
      <Field label="Expiry (UTC)" hint="Leave blank for no expiry."><Input type="datetime-local" value={entry.expiresAt?.slice(0, 16) ?? ""}
        onChange={(e) => onChange({ ...entry, expiresAt: e.target.value ? `${e.target.value}:00.000Z` : null })} /></Field>
    </div>
  </Card>;
}

export function IpListsPage() {
  return <Page index={2} description="Set manual allow and deny ranges and control temporary blocks.">
    <PolicyEditor>{(policy, update) => <>
      <Card title="Manual IP lists" description="An allow entry exempts the address from protection rules, but not from authentication or baseline rate limits." actions={
        <Button variant="secondary" disabled={policy.ipLists.length >= 128}
          onClick={() => update({ ...policy, ipLists: [...policy.ipLists, { network: "", action: "deny", reason: "", expiresAt: null }] })}>Add IP entry</Button>
      }>
        <div className="grid min-w-0 gap-3">
          {policy.ipLists.length ? policy.ipLists.map((entry, index) => <IpEntryEditor key={index} entry={entry} index={index}
            onChange={(next) => update({ ...policy, ipLists: policy.ipLists.map((r, i) => i === index ? next : r) })}
            remove={() => update({ ...policy, ipLists: policy.ipLists.filter((_r, i) => i !== index) })} />) :
            <EmptyState title="No manual IP entries" headingLevel={3} />}
        </div>
      </Card>
      <Card title="Automatic temporary blocks" description="Only active in enforce mode. Thresholds count repeated rule blocks within one minute per worker.">
        <div className="grid min-w-0 gap-3">
          <Checkbox label="Enable automatic blocks" checked={policy.automatic.enabled}
            onCheckedChange={(enabled) => update({ ...policy, automatic: { ...policy.automatic, enabled } })} />
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <Field label="Blocks before temporary ban"><Input type="number" min={5} max={50} value={policy.automatic.threshold}
              onChange={(e) => update({ ...policy, automatic: { ...policy.automatic, threshold: Number(e.target.value) } })} /></Field>
            <Field label="Ban length (minutes)"><Input type="number" min={1} max={60} value={policy.automatic.minutes}
              onChange={(e) => update({ ...policy, automatic: { ...policy.automatic, minutes: Number(e.target.value) } })} /></Field>
          </div>
        </div>
      </Card>
    </>}</PolicyEditor>
    <Blocks source="automatic" />
  </Page>;
}

export function CountriesPage() {
  return <Page index={3} description="Set geographic rules using an approved proxy header or the local country database.">
    <PolicyEditor>{(policy, update) => <Card title="Country policy" description="Allow-only rules block unknown countries in enforce mode. Test in detect mode before enforcing.">
      <div className="grid min-w-0 gap-3">
        <Field label="Country policy mode"><Select value={policy.countries.mode} options={[{ value: "off", label: "Off" }, { value: "allow", label: "Allow listed countries only" }, { value: "deny", label: "Block listed countries" }]}
          onChange={(e) => update({ ...policy, countries: { ...policy.countries, mode: e.target.value as Policy["countries"]["mode"] } })} /></Field>
        <TagInput label="Country codes" max={249} maxLength={2} value={policy.countries.codes} normalize={(s) => s.trim().toUpperCase()}
          validate={(s) => /^[A-Z]{2}$/.test(s) ? null : "Use a two-letter country code."}
          hint="For example, US or CA. Press Enter to add a code."
          onValueChange={(codes) => update({ ...policy, countries: { ...policy.countries, codes } })} />
      </div>
    </Card>}</PolicyEditor>
  </Page>;
}

const categoryLabels = {
  auth_high_risk: "Sensitive authentication", user_login: "Sign-in", form_submission: "Form submission",
  api: "API requests", expensive: "Resource-intensive requests", standard_browsing: "Standard browsing",
} satisfies Record<Out["getRateLimits"][number]["category"], string>;

function RateEditor({ item }: { item: Out["getRateLimits"][number] }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const save = useMutation(trpc.protection.setRateLimit.mutationOptions());
  const reset = useMutation(trpc.protection.resetRateLimit.mutationOptions());
  const [draft, setDraft] = useState<typeof item.budget | null>(null);
  const [confirmation, setConfirmation] = useState<"save" | "reset" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const effective = draft ?? item.budget;
  async function run() {
    try {
      await stepUp.run(() => confirmation === "reset" ? reset.mutateAsync({ category: item.category }) :
        save.mutateAsync({ category: item.category, ...effective }), { reason: "Changing request budgets requires fresh verification." });
      setDraft(null);
      setFeedback({ error: false, message: "Rate limit updated." });
      void qc.invalidateQueries(trpc.protection.getRateLimits.queryFilter());
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) setFeedback({ error: true, message: errorMessage(error) });
    }
  }
  return <Card title={categoryLabels[item.category]} description={`Default: ${item.defaults.maxRequests} requests per ${item.defaults.windowSeconds} seconds.`}>
    <form className="grid min-w-0 gap-3" onSubmit={(e) => { e.preventDefault(); setConfirmation("save"); }}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="Requests per window" hint={`${item.bounds.min}–${item.bounds.max} requests.`} required>
          <Input type="number" min={item.bounds.min} max={item.bounds.max} required value={effective.maxRequests}
            onChange={(e) => setDraft({ ...effective, maxRequests: Number(e.target.value) })} />
        </Field>
        <Field label="Window in seconds" hint={`1–${item.bounds.maxWindow} seconds.`} required>
          <Input type="number" min={1} max={item.bounds.maxWindow} required value={effective.windowSeconds}
            onChange={(e) => setDraft({ ...effective, windowSeconds: Number(e.target.value) })} />
        </Field>
      </div>
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-2 font-medium">Progressive back-off</legend>
        <Checkbox label="Increase waits after repeated refusals" checked={effective.backoff.enabled}
          onCheckedChange={(enabled) => setDraft({ ...effective, backoff: { ...effective.backoff, enabled } })} />
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          {([
            ["factor", "Multiplier", 2, 8],
            ["maxSeconds", "Maximum wait (seconds)", 30, 3600],
            ["resetAfterMinutes", "Forget after (minutes)", 1, 1440],
          ] as const).map(([key, label, min, max]) => <Field key={key} label={label} required>
            <Input type="number" min={min} max={max} required value={effective.backoff[key]}
              onChange={(e) => setDraft({ ...effective, backoff: { ...effective.backoff, [key]: Number(e.target.value) } })} />
          </Field>)}
        </div>
      </fieldset>
      <Status feedback={feedback} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!draft}>Review limit</Button>
        <Button type="button" variant="secondary" onClick={() => setConfirmation("reset")}>Restore defaults</Button>
      </div>
    </form>
    {confirmation ? <ConfirmDialog open onOpenChange={() => setConfirmation(null)} title={confirmation === "reset" ? "Restore default rate limit?" : "Save rate limit?"}
      description="Changes apply to all requests in this category. Existing windows may not reset immediately." confirmLabel="Apply rate limit" onConfirm={run} /> : null}
  </Card>;
}

function Blocks({ source }: { source: "automatic" | "rate" }) {
  const title = source === "automatic" ? "Active temporary IP blocks" : "Rate-limit refusals in active windows";
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const query = useQuery(trpc.protection.listBlocks.queryOptions());
  const release = useMutation(trpc.protection.releaseBlock.mutationOptions());
  const [selection, setSelection] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const rows = source === "automatic" ? query.data?.automatic.map((r) => ({ publicId: r.publicId, expiresAt: r.expiresAt, subject: r.ipAddress })) :
    query.data?.rateLimits.map((r) => ({ publicId: r.publicId, expiresAt: r.expiresAt, subject: categoryLabels[r.category] }));
  const releaseFocus = useReleaseFocus(rows, selection !== null);
  async function confirm() {
    if (!selection) return;
    try {
      await stepUp.run(() => release.mutateAsync({ source, publicId: selection }), { reason: "Releasing blocks requires fresh verification." });
      releaseFocus.setReleasedId(selection);
      setFeedback({ error: false, message: "Block released." });
      void query.refetch();
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) setFeedback({ error: true, message: errorMessage(error) });
    }
  }
  return <Card title={<span id={releaseFocus.headingId} tabIndex={-1}>{title}</span>} description={source === "automatic" ? "Release does not remove an IP from the manual deny list." : "This view shows up to 100 anonymized buckets. Subjects sharing a bucket are released together."}>
    <Status feedback={feedback} />
    <DataTable caption={title} loading={query.isPending} error={query.error} onRetry={() => void query.refetch()}
      rows={rows ?? []} rowKey={(r) => r.publicId}
      columns={[{ key: "subject", header: source === "automatic" ? "IP address" : "Category", primary: true, cell: (r) => <span className="break-all">{r.subject}</span> },
        { key: "expires", header: "Expires", cell: (r) => <DateTime value={r.expiresAt} /> }]}
      empty={<EmptyState title="No active entries" headingLevel={3} />}
      rowActions={(r) => <Button variant="secondary" onClick={() => setSelection(r.publicId)} aria-label={`Release ${r.subject}`}>Release</Button>} />
    {selection ? <ConfirmDialog open onOpenChange={() => setSelection(null)} title="Release this block?" confirmLabel="Release block"
      description="This clears the current entry. A new refusal can create another entry." onConfirm={confirm} /> : null}
  </Card>;
}

export function RateLimitsPage() {
  const trpc = useTRPC();
  const query = useQuery(trpc.protection.getRateLimits.queryOptions());
  return <Page index={4} description="Adjust request budgets within safe bounds. Baseline rate limits cannot be turned off.">
    {query.isPending ? <Skeleton lines={3} /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">{query.data.map((item) => <RateEditor key={item.category} item={item} />)}</div>
    )}
    <Blocks source="rate" />
  </Page>;
}

type SignInBanList = Out["listSignInBans"];
type SignInBanPolicy = SignInBanList["policy"];

function SignInBanControls({ data, refetch }: { data: SignInBanList; refetch: () => void }) {
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const create = useMutation(trpc.protection.manualSignInBan.mutationOptions());
  const release = useMutation(trpc.protection.releaseSignInBan.mutationOptions());
  const save = useMutation(trpc.protection.setSignInBanPolicy.mutationOptions());
  const [draft, setDraft] = useState<SignInBanPolicy | null>(null);
  const [address, setAddress] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("60");
  const [permanent, setPermanent] = useState(false);
  const [selection, setSelection] = useState<SignInBanList["items"][number] | null>(null);
  const [confirm, setConfirm] = useState<"ban" | "release" | "settings" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const policy = draft ?? data.policy;
  const canBan = data.determinable && !data.bypassed;
  const releaseFocus = useReleaseFocus(data.items, confirm !== null);
  async function apply() {
    try {
      if (confirm === "ban" && canBan) {
        await stepUp.run(() => create.mutateAsync({ address, durationMinutes: permanent ? null : Number(duration), reason }),
          { reason: "Banning a network requires fresh verification." });
        setAddress(""); setReason(""); setPermanent(false); setDuration("60");
        setFeedback({ error: false, message: "Sign-in ban saved." });
      } else if (confirm === "release" && selection) {
        await stepUp.run(() => release.mutateAsync({ publicId: selection.publicId }), { reason: "Releasing a sign-in ban requires fresh verification." });
        releaseFocus.setReleasedId(selection.publicId);
        setFeedback({ error: false, message: "Sign-in ban released." });
      } else if (confirm === "settings" && draft) {
        await stepUp.run(() => save.mutateAsync(draft), { reason: "Changing automatic sign-in bans requires fresh verification." });
        setDraft(null);
        setFeedback({ error: false, message: "Automatic ban settings saved." });
      }
      refetch();
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) setFeedback({ error: true, message: errorMessage(error) });
    }
  }
  return <>
    {data.bypassed ? <Callout tone="warning" title="Emergency bypass is active">Sign-in bans are not being enforced.</Callout>
      : !data.determinable ? <Callout tone="warning" title="Client address cannot be verified">
        Sign-in bans are not applied when the client address cannot be determined. Check the proxy configuration before adding bans.
      </Callout> : null}
    <Status feedback={feedback} />
    <Card title={<span id={releaseFocus.headingId} tabIndex={-1}>Active sign-in bans</span>}>
      {!data.policy.enabled && data.items.some((item) => item.source === "automatic") ? <Callout tone="info" title="Automatic bans are paused">
        Automatic entries remain listed until release or expiry. Manual bans are still enforced when the client address is verified.
      </Callout> : null}
      <DataTable caption="Active sign-in bans" rows={data.items} rowKey={(item) => item.publicId}
        columns={[
          { key: "address", header: "Address or CIDR", primary: true, cell: (item) => <span className="break-all">{item.address}</span> },
          { key: "source", header: "Source", cell: (item) => item.source === "manual" ? "Manual" : "Automatic" },
          { key: "reason", header: "Reason", cell: (item) => <span className="[overflow-wrap:anywhere]">{item.reason}</span> },
          { key: "strikes", header: "Strikes", cell: (item) => <span className="tabular-nums">{item.strikes}</span> },
          { key: "expiry", header: "Expires", cell: (item) => item.expiresAt ? <DateTime value={item.expiresAt} /> : "Permanent" },
        ]}
        empty={<EmptyState title="No active sign-in bans" headingLevel={3} />}
        rowActions={(item) => <Button variant="secondary" aria-label={`Unban ${item.address}`} onClick={() => { setSelection(item); setConfirm("release"); }}>Unban</Button>} />
    </Card>
    <Card title="Ban an IP address or range" description="Protected networks and your own address cannot be banned. Avoid broad ranges on shared networks.">
      <form className="grid min-w-0 gap-3" onSubmit={(e) => { e.preventDefault(); if (canBan) setConfirm("ban"); }}>
        <fieldset disabled={!canBan} className="grid min-w-0 gap-3 sm:grid-cols-2" aria-label="Manual ban details">
          <Field label="IP address or CIDR" required><Input value={address} maxLength={48} required onChange={(e) => setAddress(e.target.value)} /></Field>
          <Field label="Reason" hint="Do not include credentials or personal details." required><Input value={reason} minLength={3} maxLength={240} required onChange={(e) => setReason(e.target.value)} /></Field>
          <Checkbox label="Permanent ban" checked={permanent} disabled={!canBan} onCheckedChange={setPermanent} />
          {!permanent ? <Field label="Duration (minutes)" required><Input type="number" min={1} max={10080} required value={duration} onChange={(e) => setDuration(e.target.value)} /></Field> : null}
        </fieldset>
        <div><Button type="submit" disabled={!canBan}>Review manual ban</Button></div>
      </form>
    </Card>
    <Card title="Automatic ban settings" description="These settings are independent of firewall monitor and enforce modes.">
      <form className="grid min-w-0 gap-3" onSubmit={(e) => { e.preventDefault(); if (draft) setConfirm("settings"); }}>
        <Checkbox label="Enable automatic sign-in bans" checked={policy.enabled} onCheckedChange={(enabled) => setDraft({ ...policy, enabled })} />
        <Checkbox label="Require more failures when only one account is targeted" checked={policy.countDistinctAccounts}
          onCheckedChange={(countDistinctAccounts) => setDraft({ ...policy, countDistinctAccounts })} />
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {([
            ["threshold", "Failure threshold", 3, 100],
            ["windowMinutes", "Failure window (minutes)", 1, 60],
            ["banMinutes", "First ban (minutes)", 1, 120],
          ] as const).map(([key, label, min, max]) => <Field key={key} label={label} required>
            <Input type="number" min={min} max={max} required value={policy[key]} onChange={(e) => setDraft({ ...policy, [key]: Number(e.target.value) })} />
          </Field>)}
          {([
            ["factor", "Escalation multiplier", 2, 8],
            ["maxMinutes", "Maximum ban (minutes)", policy.banMinutes, 10080],
            ["memoryHours", "Escalation memory (hours)", 1, 168],
          ] as const).map(([key, label, min, max]) => <Field key={key} label={label} required>
            <Input type="number" min={min} max={max} required value={policy.escalation[key]}
              onChange={(e) => setDraft({ ...policy, escalation: { ...policy.escalation, [key]: Number(e.target.value) } })} />
          </Field>)}
          <Field label="Permanent after this many bans" hint="Leave empty to keep all automatic bans temporary.">
            <Input type="number" min={2} max={20} value={policy.permanentAfter ?? ""}
              onChange={(e) => setDraft({ ...policy, permanentAfter: e.target.value ? Number(e.target.value) : null })} />
          </Field>
        </div>
        <div><Button type="submit" disabled={!draft}>Review automatic ban settings</Button></div>
      </form>
    </Card>
    {confirm ? <ConfirmDialog open onOpenChange={() => { setConfirm(null); setSelection(null); }}
      destructive={confirm !== "release"}
      title={confirm === "ban" ? "Apply this sign-in ban?" : confirm === "release" ? "Release this sign-in ban?" : "Save automatic ban settings?"}
      description={confirm === "ban" ? `${address} will be blocked from credential endpoints ${permanent ? "until released" : `for ${duration} minutes`}.`
        : confirm === "release" ? `${selection?.address ?? "This network"} can try to sign in again, subject to other protections.`
          : "These changes can affect administrators and customers who share an address."}
      confirmLabel={confirm === "ban" ? "Ban address" : confirm === "release" ? "Unban address" : "Save automatic ban settings"} onConfirm={apply} /> : null}
  </>;
}

export function SignInBansPage() {
  const trpc = useTRPC();
  const query = useQuery(trpc.protection.listSignInBans.queryOptions());
  return <Page index={6} description="Review and manage network restrictions for sign-in.">
    {query.isPending ? <Skeleton lines={4} /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> :
      <SignInBanControls data={query.data} refetch={() => { void query.refetch(); }} />}
  </Page>;
}

const eventMethods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "OTHER"] as const;
const emptyFilter = { action: "", country: "", rule: "", method: "", since: "", until: "" };
const eventColumns = [
  { key: "date", header: "Time", primary: true, cell: (row: Event) => <DateTime value={row.createdAt} /> },
  { key: "action", header: "Action", cell: (row: Event) => <Badge tone={row.action === "block" ? "danger" : "neutral"}>{row.action === "block" ? "Blocked" : "Detected"}</Badge> },
  { key: "rule", header: "Rule", cell: (row: Event) => <span className="break-all">{row.rule}</span> },
  { key: "source", header: "Source", cell: (row: Event) => <span className="break-all">{row.ipAddress ?? "Unknown"} · {row.country ?? "Unknown country"}</span> },
  { key: "request", header: "Request", cell: (row: Event) => <span className="break-all">{row.method} {row.route}</span> },
  { key: "agent", header: "User agent", cell: (row: Event) => row.agent },
  { key: "correlation", header: "Correlation ID", cell: (row: Event) => <span className="break-all">{row.correlationId}</span> },
];

export function EventsPage() {
  const trpc = useTRPC();
  const [form, setForm] = useState(emptyFilter);
  const [filter, setFilter] = useState<EventFilter>({});
  const [history, setHistory] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const query = useQuery(trpc.protection.listEvents.queryOptions({ ...filter, cursor: history.at(-1), limit: 25 }));
  const exportEvents = useMutation(trpc.protection.exportEvents.mutationOptions());
  const update = (name: keyof typeof emptyFilter, value: string) => setForm((current) => ({ ...current, [name]: value }));
  function apply() {
    const since = form.since ? new Date(form.since) : undefined;
    const until = form.until ? new Date(form.until) : undefined;
    if (since && until && since > until) { setFeedback({ error: true, message: "Enter an end date on or after the start date." }); return; }
    setFeedback(null);
    setFilter({
      action: (form.action || undefined) as EventFilter["action"], country: form.country || undefined,
      rule: form.rule || undefined, method: (form.method || undefined) as EventFilter["method"], since, until,
    });
    setHistory([]);
  }
  async function download() {
    try {
      const result = await exportEvents.mutateAsync(filter);
      const href = URL.createObjectURL(new Blob([JSON.stringify(result.items, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "readypackets-protection-events.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setFeedback({ error: false, message: result.truncated ? "Exported the latest 1,000 matches. Narrow the filters for a smaller export." : "Protection event export is ready." });
    } catch (error) {
      setFeedback({ error: true, message: errorMessage(error) });
    }
  }
  return <Page index={5} description="Filter sampled protection activity or export the matching records.">
    <Card title="Filter events">
      <form className="grid min-w-0 gap-4" onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Action"><Select options={[{ value: "", label: "Any action" }, ...options(["detect", "block"])]} value={form.action} onChange={(e) => update("action", e.target.value)} /></Field>
          <Field label="Country"><Input value={form.country} pattern="[A-Z]{2}" maxLength={2} onChange={(e) => update("country", e.target.value.toUpperCase())} /></Field>
          <Field label="Rule identifier"><Input value={form.rule} pattern="[a-z0-9.\\-]+" maxLength={80} onChange={(e) => update("rule", e.target.value)} /></Field>
          <Field label="Method"><Select options={[{ value: "", label: "Any method" }, ...options(eventMethods)]} value={form.method} onChange={(e) => update("method", e.target.value)} /></Field>
          <Field label="From (local time)"><Input type="datetime-local" value={form.since} onChange={(e) => update("since", e.target.value)} /></Field>
          <Field label="To (local time)"><Input type="datetime-local" value={form.until} onChange={(e) => update("until", e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Apply filters</Button>
          <Button type="button" variant="secondary" onClick={() => { setForm(emptyFilter); setFilter({}); setHistory([]); setFeedback(null); }}>Clear filters</Button>
          <Button type="button" variant="secondary" disabled={exportEvents.isPending} onClick={() => void download()}>Export filtered events</Button>
        </div>
      </form>
    </Card>
    <Status feedback={feedback} />
    <Card title="Recent events">
      <DataTable caption="Sampled protection events" rows={query.data?.items ?? []} rowKey={(r) => r.publicId} columns={eventColumns}
        loading={query.isPending} error={query.error} onRetry={() => void query.refetch()} empty={<EmptyState title="No events match these filters" headingLevel={3} />} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={history.length === 0 || query.isPending} onClick={() => setHistory((value) => value.slice(0, -1))}>Previous page</Button>
        <Button variant="secondary" disabled={!query.data?.nextCursor || query.isPending} onClick={() => {
          const next = query.data?.nextCursor;
          if (next) setHistory((value) => [...value, next]);
        }}>Next page</Button>
      </div>
    </Card>
  </Page>;
}
