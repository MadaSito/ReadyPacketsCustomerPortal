/**
 * Integrations console — shared helpers. Owner: identity engineer (console UI); server contract: integrations engineer.
 * Status wording is deliberately truthful: an integration is only "Configured" when the server says so, and a configured
 * provider that has not passed a check is labelled "not yet verified" — the UI never implies an unconfigured or
 * unverified integration works.
 */
import { ArrowLeft, CheckCircle2, CircleDashed, CircleSlash, AlertTriangle, XCircle } from "lucide-react";
import { Link } from "wouter";
import { errorMessage, type useTRPCClient } from "@/lib/trpc";
import { Badge, Breadcrumbs, StepUpCancelledError, useStepUp, useToast, type Tone } from "@/ui";

type Client = ReturnType<typeof useTRPCClient>;
export type ProviderRow = Awaited<ReturnType<Client["integrations"]["admin"]["providers"]["query"]>>[number];
export type ProviderState = ProviderRow["state"];
export type ProviderKey = ProviderRow["key"];

export interface ProviderStatusInput {
  state: ProviderState;
  verified?: boolean;
  scaffoldOnly?: boolean;
}

export interface ProviderStatus {
  label: string;
  tone: Tone;
  icon: typeof CheckCircle2;
}

/** Maps server state to the console label. Order matters: scaffold beats everything (not shippable in this release). */
export function providerStatus({ state, verified = false, scaffoldOnly = false }: ProviderStatusInput): ProviderStatus {
  if (scaffoldOnly) return { label: "Not available in this release", tone: "neutral", icon: CircleSlash };
  switch (state) {
    case "configured":
      return verified
        ? { label: "Configured", tone: "success", icon: CheckCircle2 }
        : { label: "Configured — not yet verified", tone: "info", icon: CircleDashed };
    case "degraded":
      return { label: "Configured — degraded", tone: "warning", icon: AlertTriangle };
    case "failing":
      return { label: "Configured — failing", tone: "danger", icon: XCircle };
    case "disabled":
      return { label: "Switched off", tone: "neutral", icon: CircleDashed };
    case "not_configured":
    default:
      return { label: "Not configured", tone: "neutral", icon: CircleDashed };
  }
}

export function ProviderStatusBadge(props: ProviderStatusInput) {
  const status = providerStatus(props);
  const Icon = status.icon;
  return <Badge tone={status.tone} icon={<Icon className="size-3.5" aria-hidden />}>{status.label}</Badge>;
}

/** Sub-page paths, linked from the overview. */
export const INTEGRATION_PATHS = {
  overview: "/admin/integrations",
  smtp: "/admin/integrations/smtp",
  graph: "/admin/integrations/graph",
  analytics: "/admin/integrations/analytics",
  egress: "/admin/integrations/egress",
} as const;

/** Sub-page header crumbs: an explicit back link (mobile-friendly) plus the breadcrumb trail. */
export function IntegrationsCrumbs({ current }: { current: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Link href={INTEGRATION_PATHS.overview} className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-action underline-offset-4 hover:underline focus-visible:underline">
        <ArrowLeft className="size-4" aria-hidden />Back to Integrations
      </Link>
      <Breadcrumbs items={[{ label: "Integrations", href: INTEGRATION_PATHS.overview }, { label: current }]} />
    </div>
  );
}

/**
 * Runs a privileged mutation through step-up and reports the outcome. Returns undefined if the person cancels
 * verification; rethrows other errors after showing a toast so callers can map field errors.
 */
export function usePrivilegedAction() {
  const stepUp = useStepUp();
  const toast = useToast();
  return async function run<T>(action: () => Promise<T>, success: string, reason?: string): Promise<T | undefined> {
    try {
      const result = await stepUp.run(action, reason ? { reason } : undefined);
      toast.show({ tone: "success", title: success });
      return result;
    } catch (err) {
      if (err instanceof StepUpCancelledError) return undefined;
      toast.show({ tone: "danger", title: "Change not saved", description: errorMessage(err) });
      throw err;
    }
  };
}

/** Client-side mirrors of the server's format rules (the server re-validates; these only give early feedback). */
export const CLARITY_PROJECT_ID = /^[A-Za-z0-9]{6,32}$/;
export const POSTHOG_PROJECT_KEY = /^phc_[A-Za-z0-9_]{12,176}$/;
