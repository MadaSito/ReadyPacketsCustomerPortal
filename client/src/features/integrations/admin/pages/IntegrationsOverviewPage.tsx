/** /admin/integrations — truthful status cards for every integration plus links to the pages that configure them. */
import { useQuery } from "@tanstack/react-query";
import { BarChart3, CreditCard, FileStack, KeyRound, Mail, Network, ScanEye } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Callout, Card, DateTime, ErrorState, PageHeader, Skeleton, buttonClasses } from "@/ui";
import { INTEGRATION_PATHS, ProviderStatusBadge, type ProviderKey, type ProviderRow } from "../shared";

const ORDER: readonly ProviderKey[] = ["smtp", "clarity", "posthog", "saml", "stripe", "sharepoint"];

const META: Record<ProviderKey, { title: string; icon: typeof Mail; href?: string; manage?: string; blurb: string }> = {
  smtp: { title: "E-mail (SMTP)", icon: Mail, href: INTEGRATION_PATHS.smtp, manage: "Configure e-mail", blurb: "Delivers sign-in codes, invitations, receipts and order notices through your mail relay." },
  clarity: { title: "Microsoft Clarity", icon: ScanEye, href: INTEGRATION_PATHS.analytics, manage: "Configure analytics", blurb: "Optional, consent-gated session analytics on public legal pages only." },
  posthog: { title: "PostHog", icon: BarChart3, href: INTEGRATION_PATHS.analytics, manage: "Configure analytics", blurb: "Optional, consent-gated product analytics on public legal pages only." },
  saml: { title: "SAML single sign-on", icon: KeyRound, blurb: "Federated sign-in. Local sign-in with multi-factor verification stays the only active method." },
  stripe: { title: "Stripe", icon: CreditCard, blurb: "Card payments. Design scaffold only — no payment is taken through Stripe in this release." },
  sharepoint: { title: "SharePoint", icon: FileStack, blurb: "Document library sync with Microsoft 365. Design scaffold only." },
};

export default function IntegrationsOverviewPage() {
  const trpc = useTRPC();
  const providers = useQuery(trpc.integrations.admin.providers.queryOptions());
  const stripe = useQuery(trpc.integrations.admin.stripe.get.queryOptions());
  const saml = useQuery(trpc.integrations.admin.saml.get.queryOptions());
  const sharepoint = useQuery(trpc.integrations.admin.sharepoint.get.queryOptions());
  const byKey = new Map((providers.data ?? []).map((row) => [row.key, row] as const));
  const scaffold: Partial<Record<ProviderKey, { banner?: string; notes?: readonly string[] }>> = {
    stripe: stripe.data ? { banner: stripe.data.releaseBanner, notes: [stripe.data.verificationNote] } : undefined,
    saml: saml.data ? { banner: saml.data.releaseBanner, notes: saml.data.securityRequirements } : undefined,
    sharepoint: sharepoint.data ? { banner: sharepoint.data.summary, notes: sharepoint.data.targetRequirements } : undefined,
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connections between ReadyPackets and outside services. Each status comes from the server; nothing is shown as working until it is configured and checked."
      />
      <div className="flex min-w-0 flex-col gap-6">
        {providers.error ? (
          <ErrorState error={providers.error} title="Integration status unavailable" onRetry={() => void providers.refetch()} />
        ) : (
          <ul className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Integrations" aria-busy={providers.isPending || undefined}>
            {ORDER.map((key) => (
              <li key={key} className="min-w-0">
                <ProviderCard providerKey={key} row={byKey.get(key)} loading={providers.isPending} scaffold={scaffold[key]} />
              </li>
            ))}
            <li className="min-w-0">
              <Card as="article" className="h-full" title={<CardTitle icon={Network}>Outbound connections</CardTitle>}
                description="The egress allowlist every integration must pass before the server opens a connection."
                footer={<Link href={INTEGRATION_PATHS.egress} className={buttonClasses("secondary", "sm")}>Review allowlist</Link>}>
                <p className="text-sm text-muted">Private, loopback and cloud-metadata addresses are refused unless a rule explicitly allows them.</p>
              </Card>
            </li>
          </ul>
        )}
      </div>
    </>
  );
}

function CardTitle({ icon: Icon, children }: { icon: typeof Mail; children: ReactNode }) {
  return <span className="flex items-center gap-2"><Icon className="size-5 shrink-0 text-action" aria-hidden />{children}</span>;
}

function ProviderCard({ providerKey, row, loading, scaffold }: {
  providerKey: ProviderKey; row: ProviderRow | undefined; loading: boolean; scaffold?: { banner?: string; notes?: readonly string[] };
}) {
  const meta = META[providerKey];
  const scaffoldOnly = row?.scaffoldOnly ?? false;
  const manage = !scaffoldOnly && meta.href && meta.manage
    ? <Link href={meta.href} className={buttonClasses("secondary", "sm")} aria-label={`${meta.manage} (${meta.title})`}>{meta.manage}</Link>
    : undefined;
  return (
    <Card as="article" className="h-full" title={<CardTitle icon={meta.icon}>{row?.name ?? meta.title}</CardTitle>} description={meta.blurb} footer={manage}>
      {loading ? <Skeleton lines={2} /> : !row ? (
        <p className="text-sm text-muted">Status not reported by the server.</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div><ProviderStatusBadge state={row.state} verified={row.verified} scaffoldOnly={row.scaffoldOnly} /></div>
          {row.summary ? <p className="text-sm text-body">{row.summary}</p> : null}
          <p className="text-xs text-muted">
            {row.lastCheckedAt ? <>Last checked <DateTime value={row.lastCheckedAt} /></> : "Never checked"}
          </p>
          {scaffoldOnly && scaffold?.banner ? (
            <Callout tone="info" title="Not available in this release">
              <p>{scaffold.banner}</p>
              {scaffold.notes?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">{scaffold.notes.map((note) => <li key={note}>{note}</li>)}</ul>
              ) : null}
            </Callout>
          ) : null}
        </div>
      )}
    </Card>
  );
}
