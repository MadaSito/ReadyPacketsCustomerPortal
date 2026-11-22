/**
 * Console order tab "Acceptances (n)" (key "acceptances", order 100, staff). Owner: identity_engineer.
 * Lists the order's append-only acceptance evidence. The source address column appears only for holders of
 * `sessions.read_all` (the server returns null otherwise — hiding it here is not the control).
 */
import type { inferRouterOutputs } from "@trpc/server";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { FileSignature, Printer } from "lucide-react";
import { Link } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, DataTable, DateTime, EmptyState, LoadMore, Section, type Column } from "@/ui";
import { receiptHref } from "./AcceptanceGate";

type ListPage = inferRouterOutputs<AppRouter>["compliance"]["acceptance"]["console"]["list"];
export type AcceptanceItem = ListPage["items"][number];

export interface AcceptancesTabProps {
  orderId: string;
  area: "customer" | "console";
}

/** Text-only tab label: "Acceptances (n)". One cheap COUNT, console only. */
export function AcceptancesTabLabel({ orderId, area }: AcceptancesTabProps) {
  const trpc = useTRPC();
  const count = useQuery({ ...trpc.compliance.acceptance.console.count.queryOptions({ orderId }), enabled: area === "console" });
  return <>{count.data ? `Acceptances (${count.data.total})` : "Acceptances"}</>;
}

export function signatureText(item: Pick<AcceptanceItem, "signerName" | "signatureMode" | "typedName">): string {
  return item.signatureMode === "typed_name" ? `Signed by ${item.typedName ?? item.signerName} using typed signature` : `Accepted by ${item.signerName} using checkbox`;
}

export default function AcceptancesTab({ orderId, area }: AcceptancesTabProps) {
  const trpc = useTRPC();
  const { view } = useSession();
  const showAddress = view.status === "full" && roleHasCapability(view.role, "sessions.read_all");
  const list = useInfiniteQuery(
    trpc.compliance.acceptance.console.list.infiniteQueryOptions(
      { orderId, limit: 25 },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, enabled: area === "console" },
    ),
  );
  if (area !== "console") return null;
  const rows = list.data?.pages.flatMap((p) => p.items);

  const columns: Column<AcceptanceItem>[] = [
    {
      key: "signer",
      header: "Signature",
      primary: true,
      cell: (r) => (
        <span className="flex flex-col gap-1">
          <span className="font-medium text-ink">{signatureText(r)}</span>
          <Badge tone={r.signerRole === "owner" ? "brand" : "neutral"}>{r.signerRole === "owner" ? "Order owner" : "Person with access"}</Badge>
        </span>
      ),
    },
    { key: "acceptedAt", header: "Accepted", cell: (r) => <DateTime value={r.acceptedAt} format="datetime" /> },
    { key: "policy", header: "Policy", cell: (r) => <span>{r.policy.title} · version {r.policy.versionLabel}</span> },
    { key: "gate", header: "Step", cell: (r) => (r.gateKey === "order_start" ? "Before work starts" : r.gateKey) },
    ...(showAddress
      ? [{ key: "address", header: "Source address", cell: (r: AcceptanceItem) => <span className="font-mono text-sm break-all">{r.sourceAddress ?? "Not recorded"}</span> }]
      : []),
    { key: "hash", header: "Text fingerprint (SHA-256)", hideOnMobile: true, cell: (r) => <span className="font-mono text-xs break-all text-muted">{r.textSha256}</span> },
  ];

  return (
    <Section title="Acceptances" description="Policy acceptances recorded for this order. Each person accepts for themselves; records can't be changed.">
      <DataTable
        caption="Policy acceptances for this order, newest first"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.receiptId}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        empty={<EmptyState icon={FileSignature} title="No acceptances yet" description="Acceptances appear here when the customer or people with access accept a policy for this order." />}
        rowActions={(r) => (
          <Button asChild variant="ghost" size="sm" leadingIcon={<Printer className="h-4 w-4" aria-hidden />}>
            <Link href={receiptHref("console", r.receiptId)} aria-label={`Receipt for ${signatureText(r)}`}>
              Receipt
            </Link>
          </Button>
        )}
      />
      {rows && rows.length > 0 ? (
        <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={`Showing ${rows.length} of ${list.data?.pages[0]?.total ?? rows.length} acceptances`} />
      ) : null}
    </Section>
  );
}
