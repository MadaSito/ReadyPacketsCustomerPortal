/**
 * /admin/integrations/egress — the outbound connection allowlist, the permanently blocked ranges and a dry-run checker.
 * The blocked-range read-out mirrors server/modules/integrations/API.md §1.1 (ipPolicy.ts is the enforcement point).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus, ShieldBan } from "lucide-react";
import { useState, type FormEvent } from "react";
import { safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, Dialog, DropdownMenu, EmptyState, Field, IconButton, Input,
  PageHeader, Select, Textarea,
} from "@/ui";
import { IntegrationsCrumbs, usePrivilegedAction } from "../shared";

type Client = ReturnType<typeof useTRPCClient>;
type Rule = Awaited<ReturnType<Client["integrations"]["admin"]["egress"]["list"]["query"]>>[number];
type CheckResult = Awaited<ReturnType<Client["integrations"]["admin"]["egress"]["check"]["mutate"]>>;
type Purpose = Rule["purpose"];
type Protocol = Rule["protocol"];
type MatchType = Rule["matchType"];

export const PURPOSE_LABELS: Record<Purpose, string> = { siem: "SIEM / syslog", smtp: "E-mail relay", webhook: "Webhook", sharepoint: "SharePoint", stripe: "Stripe", antivirus: "Malware scanner" };
const PROTOCOL_LABELS: Record<Protocol, string> = { "https:": "HTTPS", "tls:": "TLS (syslog over TLS)", "smtp:": "SMTP with STARTTLS", "smtps:": "SMTP over implicit TLS" };
const MATCH_LABELS: Record<MatchType, string> = { host: "Host name", ip: "IP address", cidr: "Address range (CIDR)" };
const opts = <K extends string>(labels: Record<K, string>) => (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));

/** Never allowlistable, whatever rule exists. */
export const NEVER_ALLOWED: readonly { label: string; ranges: string }[] = [
  { label: "Loopback", ranges: "127.0.0.0/8, ::1, *.localhost" },
  { label: "Unspecified", ranges: "0.0.0.0/8, ::" },
  { label: "Link-local", ranges: "169.254.0.0/16, fe80::/10, *.local" },
  { label: "Cloud metadata", ranges: "169.254.169.254, 100.100.100.200, fd00:ec2::254, metadata.google.internal" },
  { label: "Multicast", ranges: "224.0.0.0/4, ff00::/8" },
  { label: "Broadcast and reserved", ranges: "240.0.0.0/4" },
  { label: "IPv4-in-IPv6 transition forms", ranges: "::ffff:0:0/96, ::ffff:0:0:0/96, 64:ff9b::/96, 2002::/16, 2001::/32" },
  { label: "Obfuscated IPv4 encodings", ranges: "Octal, hex, decimal and shorthand forms such as 0177.0.0.1, 0x7f000001, 127.1" },
];
/** Refused unless a matching rule has "allow private address" on. */
export const PRIVATE_UNLESS_ALLOWED: readonly { label: string; ranges: string }[] = [
  { label: "Private networks (RFC 1918)", ranges: "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16" },
  { label: "Unique local IPv6 (RFC 4193)", ranges: "fc00::/7" },
  { label: "Carrier-grade NAT", ranges: "100.64.0.0/10" },
  { label: "Benchmarking", ranges: "198.18.0.0/15" },
  { label: "Non-default ports", ranges: "Any port other than the protocol's standard port" },
];

export default function EgressPage() {
  const trpc = useTRPC();
  const run = usePrivilegedAction();
  const list = useQuery(trpc.integrations.admin.egress.list.queryOptions());
  const update = useMutation(trpc.integrations.admin.egress.update.mutationOptions());
  const remove = useMutation(trpc.integrations.admin.egress.remove.mutationOptions());
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Rule | null>(null);

  const toggle = async (rule: Rule) => {
    await run(() => update.mutateAsync({ publicId: rule.publicId, expectedVersion: rule.version, enabled: !rule.enabled }),
      rule.enabled ? "Rule switched off" : "Rule switched on", "Changing the allowlist needs verification.").catch(() => undefined);
    await list.refetch();
  };

  return (
    <>
      <PageHeader breadcrumbs={<IntegrationsCrumbs current="Outbound connections" />} title="Outbound connections"
        description="Every connection the server opens to another system must pass this policy. Changes need your verification and are audited."
        actions={<Button leadingIcon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>Add rule</Button>} />
      <div className="flex min-w-0 flex-col gap-6">
        <DataTable<Rule>
          caption="Allowlist rules"
          rows={list.data}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(rule) => rule.publicId}
          columns={[
            { key: "pattern", header: "Target", primary: true, cell: (r) => <span className="break-all font-mono text-sm text-ink">{r.pattern}:{r.port}</span> },
            { key: "purpose", header: "Used for", cell: (r) => PURPOSE_LABELS[r.purpose] },
            { key: "protocol", header: "Protocol", hideOnMobile: true, cell: (r) => PROTOCOL_LABELS[r.protocol] },
            { key: "private", header: "Private address", hideOnMobile: true, cell: (r) => (r.allowPrivateAddress ? <Badge tone="warning">Allowed</Badge> : <Badge>Refused</Badge>) },
            { key: "enabled", header: "State", cell: (r) => (r.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>) },
            { key: "justification", header: "Reason", hideOnMobile: true, cell: (r) => <span className="text-sm">{r.justification}</span> },
            { key: "updatedAt", header: "Updated", hideOnMobile: true, cell: (r) => <DateTime value={r.updatedAt} format="date" /> },
          ]}
          rowActions={(rule) => (
            <DropdownMenu align="end"
              trigger={<IconButton label={`Actions for ${rule.pattern}`} icon={<MoreHorizontal className="size-5" aria-hidden />} variant="ghost" />}
              items={[
                { label: rule.enabled ? "Switch off" : "Switch on", onSelect: () => void toggle(rule) },
                "separator" as const,
                { label: "Remove", destructive: true, onSelect: () => setRemoving(rule) },
              ]} />
          )}
          empty={<EmptyState icon={ShieldBan} title="No allowlist rules" description="Only public addresses on standard ports are reachable. Add a rule for a private relay or SIEM collector." />}
        />
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
          <Card as="section" title="Always blocked" description="These destinations can never be allowlisted.">
            <RangeList items={NEVER_ALLOWED} />
          </Card>
          <Card as="section" title="Blocked unless a rule allows it" description="A matching rule with “allow private address” is required.">
            <RangeList items={PRIVATE_UNLESS_ALLOWED} />
            <p className="mt-3 text-sm text-muted">Redirects are never followed, DNS answers are pinned for the connection, and lookups time out after 5 seconds.</p>
          </Card>
        </div>
        <CheckCard />
      </div>
      <CreateRuleDialog open={creating} onOpenChange={setCreating} onCreated={() => void list.refetch()} />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => { if (!o) setRemoving(null); }} destructive confirmLabel="Remove rule"
        title="Remove this rule?" description={removing ? `Connections to ${removing.pattern}:${removing.port} will be refused unless another rule allows them.` : undefined}
        onConfirm={async () => {
          if (!removing) return;
          const done = await run(() => remove.mutateAsync({ publicId: removing.publicId }), "Rule removed", "Changing the allowlist needs verification.");
          if (done === undefined) throw new Error("cancelled");
          setRemoving(null);
          await list.refetch();
        }} />
    </>
  );
}

function RangeList({ items }: { items: readonly { label: string; ranges: string }[] }) {
  return (
    <dl className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-sm font-semibold text-ink">{item.label}</dt>
          <dd className="break-words font-mono text-xs text-muted">{item.ranges}</dd>
        </div>
      ))}
    </dl>
  );
}

function CheckCard() {
  const trpc = useTRPC();
  const run = usePrivilegedAction();
  const check = useMutation(trpc.integrations.admin.egress.check.mutationOptions());
  const [target, setTarget] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("siem");
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<CheckResult>();
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!target.trim()) { setError("Enter a URL or host:port to check."); return; }
    try {
      const r = await run(() => check.mutateAsync({ target: target.trim(), purpose }), "Check finished", "Checking a destination needs verification.");
      if (r) setResult(r);
    } catch (err) {
      setError(safeError(err)?.safeMessage ?? "The check could not be run.");
    }
  };
  return (
    <Card as="section" title="Check a destination" description="Resolves the destination and applies the policy without connecting.">
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4 md:flex-row md:items-end" aria-label="Check a destination">
        <Field label="Destination" hint="For example https://siem.example.com:6514 or relay.example.com:587" error={error} className="min-w-0 flex-1">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Used for" className="md:w-56">
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)} options={opts(PURPOSE_LABELS)} />
        </Field>
        <Button type="submit" variant="secondary" loading={check.isPending}>Check</Button>
      </form>
      {result ? (
        <div className="mt-4" aria-live="polite">
          <Callout tone={result.allowed ? "success" : "danger"} title={result.allowed ? "Connection would be allowed" : "Connection would be refused"}>
            <p>{result.safeMessage}</p>
            {result.pinned ? <p className="mt-1 break-all font-mono text-xs">{result.pinned.hostname} → {result.pinned.address}:{result.pinned.port} (IPv{result.pinned.family})</p> : null}
          </Callout>
        </div>
      ) : null}
    </Card>
  );
}

interface RuleForm { purpose: Purpose; matchType: MatchType; pattern: string; port: string; protocol: Protocol; allowPrivateAddress: boolean; justification: string }
const EMPTY_RULE: RuleForm = { purpose: "siem", matchType: "host", pattern: "", port: "6514", protocol: "tls:", allowPrivateAddress: false, justification: "" };

export function validateRule(f: RuleForm): Partial<Record<keyof RuleForm | "form", string>> {
  const e: Partial<Record<keyof RuleForm | "form", string>> = {};
  if (!f.pattern.trim()) e.pattern = "Enter the host name, IP address or range.";
  else if (f.matchType === "cidr" && !f.pattern.includes("/")) e.pattern = "Enter a range such as 10.20.0.0/24.";
  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) e.port = "Enter a port between 1 and 65535.";
  const j = f.justification.trim().length;
  if (j < 8 || j > 280) e.justification = "Explain why this connection is needed (8–280 characters).";
  return e;
}

function CreateRuleDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const trpc = useTRPC();
  const run = usePrivilegedAction();
  const create = useMutation(trpc.integrations.admin.egress.create.mutationOptions());
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE);
  const [errors, setErrors] = useState<ReturnType<typeof validateRule>>({});
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setForm((p) => ({ ...p, [k]: v }));
  const close = () => { setForm(EMPTY_RULE); setErrors({}); onOpenChange(false); };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateRule(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    try {
      const done = await run(() => create.mutateAsync({
        purpose: form.purpose, matchType: form.matchType, pattern: form.pattern.trim(), port: Number(form.port), protocol: form.protocol,
        allowPrivateAddress: form.allowPrivateAddress, enabled: true, justification: form.justification.trim(),
      }), "Rule added", "Changing the allowlist needs verification.");
      if (done === undefined) return;
      onCreated();
      close();
    } catch (err) {
      setErrors({ form: safeError(err)?.safeMessage ?? "The rule was not added." });
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())} title="Add allowlist rule" size="lg"
      description="Rules can open private destinations or non-standard ports. They cannot open loopback, link-local or metadata addresses."
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" form="rp-egress-create" loading={create.isPending}>Add rule</Button></>}>
      <form id="rp-egress-create" noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        {errors.form ? <Callout tone="danger" live="assertive">{errors.form}</Callout> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Used for"><Select value={form.purpose} onChange={(e) => set("purpose", e.target.value as Purpose)} options={opts(PURPOSE_LABELS)} /></Field>
          <Field label="Protocol"><Select value={form.protocol} onChange={(e) => set("protocol", e.target.value as Protocol)} options={opts(PROTOCOL_LABELS)} /></Field>
          <Field label="Match"><Select value={form.matchType} onChange={(e) => set("matchType", e.target.value as MatchType)} options={opts(MATCH_LABELS)} /></Field>
          <Field label="Port" required error={errors.port}><Input value={form.port} inputMode="numeric" onChange={(e) => set("port", e.target.value)} autoComplete="off" /></Field>
        </div>
        <Field label={MATCH_LABELS[form.matchType]} required error={errors.pattern}>
          <Input value={form.pattern} onChange={(e) => set("pattern", e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Checkbox label="Allow a private address" description="Needed for relays or collectors on your internal network." checked={form.allowPrivateAddress} onCheckedChange={(v) => set("allowPrivateAddress", v)} />
        <Field label="Reason" required hint="Recorded in the audit log." error={errors.justification}>
          <Textarea rows={3} value={form.justification} onChange={(e) => set("justification", e.target.value)} maxLength={280} />
        </Field>
      </form>
    </Dialog>
  );
}
