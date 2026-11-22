/** /admin/sign-in-log — every sign-in, failure, lock, sign-out, forced end, expiry and refusal (kept 180 days). */
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Download, History } from "lucide-react";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import { Badge, Button, DataTable, DateTime, EmptyState, Field, FilterBar, Input, LoadMore, PageHeader, Select, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import { ROLE_LABELS } from "../shared";
import { AUTH_METHOD_OPTIONS, ROLE_OPTIONS, SIGN_IN_KIND_OPTIONS, authMethodLabel, signInKindMeta, type SignInKind } from "../security/labels";

type Page = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["signInLog"]["list"]["query"]>>;
type Row = Page["items"][number];
type Role = "customer" | "staff" | "admin";
type Method = "local" | "saml" | "entra";

/** `yyyy-mm-dd` from a date input → start (or end) of that day in the viewer's time zone. */
function dayBoundary(value: string, end: boolean): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Hand the CSV to the browser as a download (never stored). */
function download(csv: string, name: string) {
  const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  try {
    const trigger = document.createElement("a");
    trigger.href = href;
    trigger.download = name;
    document.body.append(trigger);
    try { trigger.click(); } finally { trigger.remove(); }
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}

export default function SignInLogPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const { me } = useSession();
  const [kind, setKind] = useState<SignInKind | "">("");
  const [role, setRole] = useState<Role | "">("");
  const [method, setMethod] = useState<Method | "">("");
  const [country, setCountry] = useState("");
  const [ipText, setIpText] = useState("");
  const [ip, setIp] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const code = country.trim().toUpperCase();
  const filter = {
    ...(kind ? { kind } : {}), ...(role ? { role } : {}), ...(method ? { authMethod: method } : {}),
    ...(/^[A-Z]{2}$/.test(code) ? { country: code } : {}), ...(ip ? { ip } : {}),
    ...(dayBoundary(from, false) ? { from: dayBoundary(from, false) } : {}), ...(dayBoundary(to, true) ? { to: dayBoundary(to, true) } : {}),
  };
  const list = useInfiniteQuery(
    trpc.identity.admin.signInLog.list.infiniteQueryOptions({ ...filter, limit: 50 }, { getNextPageParam: (page) => page.nextCursor ?? undefined, retry: false }),
  );
  const exporter = useMutation(trpc.identity.admin.signInLog.export.mutationOptions());
  const rows = list.data?.pages.flatMap((page) => page.items);
  const active = Object.keys(filter).length;
  const ipError = list.isError && safeError(list.error)?.reasonCode === "IP_INVALID" ? safeError(list.error)?.safeMessage : undefined;

  const onExport = async () => {
    try {
      const result = await stepUp.run(() => exporter.mutateAsync(filter), { reason: "Confirm it's you to export the sign-in log." });
      download(result.csv, `sign-in-log-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.show({
        tone: result.truncated ? "warning" : "success",
        title: `Exported ${result.rows} events`,
        description: result.truncated ? "Only the newest 5,000 matching events were exported. Narrow the filters to export the rest." : undefined,
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Export failed", description: errorMessage(err) });
    }
  };

  return (
    <>
      <PageHeader
        title="Sign-in log"
        description="Sign-ins, failed attempts, lockouts, sign-outs, forced ends, expiries and refusals. Events are kept for 180 days; the audit log keeps the full record."
        actions={me?.user.role === "admin"
          ? <Button variant="secondary" leadingIcon={<Download className="size-4" aria-hidden />} loading={exporter.isPending} onClick={() => void onExport()}>Export CSV</Button>
          : undefined}
      />
      <FilterBar
        activeCount={active}
        onReset={() => { setKind(""); setRole(""); setMethod(""); setCountry(""); setIpText(""); setIp(""); setFrom(""); setTo(""); }}
      >
        <Field label="Event">
          <Select options={SIGN_IN_KIND_OPTIONS} placeholder="Any event" value={kind} onChange={(e) => setKind(e.target.value as SignInKind | "")} />
        </Field>
        <Field label="Role">
          <Select options={ROLE_OPTIONS} placeholder="Any role" value={role} onChange={(e) => setRole(e.target.value as Role | "")} />
        </Field>
        <Field label="Sign-in method">
          <Select options={AUTH_METHOD_OPTIONS} placeholder="Any method" value={method} onChange={(e) => setMethod(e.target.value as Method | "")} />
        </Field>
        <Field label="Country" hint="Two-letter code">
          <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} autoComplete="off" className="uppercase" />
        </Field>
        <Field label="IP address" hint="Full address; press Enter to search">
          <Input
            value={ipText}
            onChange={(e) => setIpText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setIp(ipText.trim()); } }}
            onBlur={() => setIp(ipText.trim())}
            maxLength={64}
            autoComplete="off"
            inputMode="text"
            placeholder="203.0.113.7"
          />
        </Field>
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </FilterBar>
      {ipError ? <p role="alert" className="mb-3 text-sm font-semibold text-danger">{ipError}</p> : null}
      <DataTable<Row>
        caption="Sign-in events, newest first"
        rows={rows}
        loading={list.isPending}
        error={ipError ? null : list.error}
        onRetry={() => void list.refetch()}
        rowKey={(row) => row.id}
        columns={[
          { key: "occurredAt", header: "When", primary: true, cell: (row) => <DateTime value={row.occurredAt} format="datetime" /> },
          {
            key: "kind",
            header: "Event",
            cell: (row) => {
              const meta = signInKindMeta(row.kind);
              return (
                <span className="flex flex-col gap-1">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {row.reasonCode ? <span className="font-mono text-xs break-all text-muted">{row.reasonCode}</span> : null}
                </span>
              );
            },
          },
          {
            key: "user",
            header: "Account",
            cell: (row) => row.user
              ? <span className="flex flex-col"><span className="font-semibold text-ink">{row.user.name}</span><span className="text-sm text-muted">{ROLE_LABELS[row.user.role]}</span></span>
              : <span className="text-muted">Unknown account</span>,
          },
          { key: "method", header: "Method", hideOnMobile: true, cell: (row) => authMethodLabel(row.authMethod) },
          { key: "ip", header: "Address", cell: (row) => <span className="break-all">{[row.ipAddress, row.country].filter(Boolean).join(" · ") || "—"}</span> },
          { key: "device", header: "Device", hideOnMobile: true, cell: (row) => row.deviceSummary ?? "—" },
          { key: "actor", header: "Ended by", hideOnMobile: true, cell: (row) => row.actor?.name ?? "—" },
        ]}
        empty={<EmptyState icon={History} title={active ? "No matching events" : "No sign-in events yet"} description={active ? "Try a wider date range or remove a filter." : "Events appear here as people sign in and out."} />}
      />
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={rows ? `Showing ${rows.length} events` : undefined} />
    </>
  );
}
