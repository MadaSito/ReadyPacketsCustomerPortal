/** /admin/integrations — truthful status cards for every integration plus live links to the pages that configure them. */
import { useQuery } from "@tanstack/react-query";
import { BarChart3, CreditCard, FileStack, KeyRound, Mail, Network, ScanEye, Send, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Card, DateTime, ErrorState, PageHeader, Skeleton, buttonClasses } from "@/ui";
import { INTEGRATION_PATHS, ProviderStatusBadge, type ProviderKey, type ProviderRow } from "../shared";

const ORDER: readonly ProviderKey[] = ["smtp", "graph", "clarity", "posthog", "saml", "stripe", "sharepoint"];

const META: Record<
  ProviderKey,
  {
    title: string;
    icon: typeof Mail;
    href: string;
    manage: string;
    secondaryHref?: string;
    secondaryLabel?: string;
    blurb: string;
  }
> = {
  smtp: {
    title: "E-mail (SMTP)",
    icon: Mail,
    href: INTEGRATION_PATHS.smtp,
    manage: "Configure e-mail",
    blurb: "Delivers sign-in codes, invitations, receipts and order notices through your mail relay.",
  },
  graph: {
    title: "Microsoft Graph Mail",
    icon: Mail,
    href: "/admin/email-delivery",
    manage: "Configure Graph mail",
    secondaryHref: INTEGRATION_PATHS.graph,
    secondaryLabel: "Readiness & runbook",
    blurb: "Single-tenant Microsoft 365 application mail delivery and Graph cloud connectivity.",
  },
  clarity: {
    title: "Microsoft Clarity",
    icon: ScanEye,
    href: INTEGRATION_PATHS.analytics,
    manage: "Configure analytics",
    blurb: "Optional, consent-gated session analytics on public legal pages only.",
  },
  posthog: {
    title: "PostHog",
    icon: BarChart3,
    href: INTEGRATION_PATHS.analytics,
    manage: "Configure analytics",
    blurb: "Optional, consent-gated product analytics on public legal pages only.",
  },
  saml: {
    title: "SAML single sign-on",
    icon: KeyRound,
    href: "/admin/sso",
    manage: "Configure single sign-on",
    blurb: "Federated SAML 2.0 and Microsoft Entra ID sign-in with local multi-factor break-glass protection.",
  },
  stripe: {
    title: "Stripe",
    icon: CreditCard,
    href: "/admin/payments/setup",
    manage: "Payment setup",
    secondaryHref: INTEGRATION_PATHS.egress,
    secondaryLabel: "Egress preset",
    blurb: "Online card checkout and signed webhooks through Stripe, gated by the api.stripe.com:443 egress preset.",
  },
  sharepoint: {
    title: "SharePoint & OneDrive",
    icon: FileStack,
    href: "/admin/storage",
    manage: "Configure storage",
    secondaryHref: "/admin/storage/sharepoint-orders",
    secondaryLabel: "SharePoint folders",
    blurb: "Managed customer order folder sync with Microsoft 365 using Entra Sites.Selected least-privilege grants.",
  },
};

export default function IntegrationsOverviewPage() {
  const trpc = useTRPC();
  const providers = useQuery(trpc.integrations.admin.providers.queryOptions());
  const byKey = new Map((providers.data ?? []).map((row) => [row.key, row] as const));

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
                <ProviderCard providerKey={key} row={byKey.get(key)} loading={providers.isPending} />
              </li>
            ))}
            <li className="min-w-0">
              <Card
                as="article"
                className="h-full"
                title={<CardTitle icon={Send}>Production pipeline</CardTitle>}
                description="Phase-gated P101–P401 outbound production webhooks, optional HMAC signing and workflow auto-queue."
                footer={<Link href="/admin/integrations/production" className={buttonClasses("secondary", "sm")}>Manage production pipeline</Link>}
              >
                <p className="text-sm text-muted">Disabled by default; P201 requires delivered P101 and a locked Phase 1 intake.</p>
              </Card>
            </li>
            <li className="min-w-0">
              <Card
                as="article"
                className="h-full"
                title={<CardTitle icon={Webhook}>Webhooks</CardTitle>}
                description="Outbound event subscriptions, inbound webhook endpoints and the delivery log."
                footer={<Link href="/admin/integrations/webhooks" className={buttonClasses("secondary", "sm")}>Manage webhooks</Link>}
              >
                <p className="text-sm text-muted">Disabled by default; outbound destinations must match the egress allowlist over HTTPS port 443.</p>
              </Card>
            </li>
            <li className="min-w-0">
              <Card
                as="article"
                className="h-full"
                title={<CardTitle icon={Network}>Outbound connections</CardTitle>}
                description="Provider presets and the egress allowlist every integration must pass before the server opens a connection."
                footer={<Link href={INTEGRATION_PATHS.egress} className={buttonClasses("secondary", "sm")}>Review allowlist</Link>}
              >
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

function ProviderCard({ providerKey, row, loading }: {
  providerKey: ProviderKey;
  row: ProviderRow | undefined;
  loading: boolean;
}) {
  const meta = META[providerKey];
  const footer = (
    <div className="flex flex-wrap gap-2">
      <Link href={meta.href} className={buttonClasses("secondary", "sm")} aria-label={`${meta.manage} (${meta.title})`}>
        {meta.manage}
      </Link>
      {meta.secondaryHref && meta.secondaryLabel ? (
        <Link href={meta.secondaryHref} className={buttonClasses("ghost", "sm")} aria-label={`${meta.secondaryLabel} (${meta.title})`}>
          {meta.secondaryLabel}
        </Link>
      ) : null}
    </div>
  );
  return (
    <Card as="article" className="h-full" title={<CardTitle icon={meta.icon}>{row?.name ?? meta.title}</CardTitle>} description={meta.blurb} footer={footer}>
      {loading ? <Skeleton lines={2} /> : !row ? (
        <p className="text-sm text-muted">Status not reported by the server.</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div><ProviderStatusBadge state={row.state} verified={row.verified} scaffoldOnly={row.scaffoldOnly} /></div>
          {row.summary ? <p className="text-sm text-body">{row.summary}</p> : null}
          <p className="text-xs text-muted">
            {row.lastCheckedAt ? <>Last checked <DateTime value={row.lastCheckedAt} /></> : "Never checked"}
          </p>
        </div>
      )}
    </Card>
  );
}
