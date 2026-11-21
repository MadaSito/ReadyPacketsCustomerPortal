/**
 * Integrations module — public service surface and factory. Owner: integrations module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.integrations` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { HealthState, ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import {
  createAnalyticsService,
  type AdminAnalyticsConfig,
  type AnalyticsCspPolicy,
  type AnalyticsService,
  type PublicAnalyticsConfig,
  type UpdateAnalyticsConfigInput,
} from "./analytics.js";
import {
  createEgressPolicy,
  createPinnedLookup,
  EGRESS_PRESET_KEYS,
  EGRESS_PROTOCOLS,
  EGRESS_PURPOSES,
  type CreateEgressRuleInput,
  type EgressAllowlistRuleView,
  type EgressFetchOptions,
  type EgressFetchResponse,
  type EgressHttpMethod,
  type EgressMatchType,
  type EgressPolicy,
  type EgressPolicyOptions,
  type EgressPresetKey,
  type EgressPresetParams,
  type EgressPresetView,
  type EgressProtocol,
  type EgressPurpose,
  type EgressTargetInput,
  type PinnedEgressTarget,
  type ResolveEgressInput,
  type SetEgressPresetInput,
  type UpdateEgressRuleInput,
} from "./egress.js";
import { createProviderChecksStore } from "./providerChecks.js";
import {
  createScaffoldsService,
  SAML_RELEASE_BANNER,
  type SamlScaffoldView,
  type ScaffoldsService,
  type SharePointScaffoldView,
  type UpdateSamlScaffoldInput,
} from "./scaffolds.js";
import {
  createSmtpService,
  type ProviderState,
  type SmtpConfigView,
  type SmtpReadiness,
  type SmtpSendInput,
  type SmtpSendResult,
  type SmtpService,
  type SmtpTestResult,
  type SmtpTransportFactory,
  type UpdateSmtpConfigInput,
} from "./smtp.js";
import {
  createStripeService,
  STRIPE_LEDGER_MUTATION_ENABLED,
  STRIPE_RELEASE_BANNER,
  type StripeConfigView,
  type StripeService,
  type StripeWebhookResult,
  type UpdateStripeConfigInput,
} from "./stripe.js";
import {
  createProductionWebhookService,
  PRODUCTION_DELIVERY_JOB,
  PRODUCTION_DISPATCH_MAX_TTL_MS,
  PRODUCTION_MAX_ATTEMPTS,
  PRODUCTION_RECONCILE_JOB,
  PRODUCTION_SENDING_GRACE_MS,
  PRODUCTION_STALE_QUEUED_MS,
  type ControlledResendReason,
  type ListProductionDispatchesInput,
  type MaskedWebhookUrlView,
  type P101Payload,
  type P201Payload,
  type ProductionDispatchItem,
  type ProductionDispatchState,
  type ProductionDryRunResult,
  type ProductionOrderPreview,
  type ProductionPhase,
  type ProductionSettingsView,
  type ProductionWebhookService,
  type RequestP101Input,
  type RequestP201Input,
  type ResendProductionInput,
  type UpdateProductionSettingsInput,
} from "./production/index.js";

// Ensure all `integrations.*` settings/secrets/flags register on module import.
import "./settings.js";

export {
  createPinnedLookup,
  EGRESS_PRESET_KEYS,
  EGRESS_PROTOCOLS,
  EGRESS_PURPOSES,
  PRODUCTION_DELIVERY_JOB,
  PRODUCTION_DISPATCH_MAX_TTL_MS,
  PRODUCTION_MAX_ATTEMPTS,
  PRODUCTION_RECONCILE_JOB,
  PRODUCTION_SENDING_GRACE_MS,
  PRODUCTION_STALE_QUEUED_MS,
  SAML_RELEASE_BANNER,
  STRIPE_LEDGER_MUTATION_ENABLED,
  STRIPE_RELEASE_BANNER,
  type AdminAnalyticsConfig,
  type AnalyticsCspPolicy,
  type AnalyticsService,
  type ControlledResendReason,
  type CreateEgressRuleInput,
  type EgressAllowlistRuleView,
  type EgressFetchOptions,
  type EgressFetchResponse,
  type EgressHttpMethod,
  type EgressMatchType,
  type EgressPolicy,
  type EgressPolicyOptions,
  type EgressPresetKey,
  type EgressPresetParams,
  type EgressPresetView,
  type EgressProtocol,
  type EgressPurpose,
  type EgressTargetInput,
  type ListProductionDispatchesInput,
  type MaskedWebhookUrlView,
  type P101Payload,
  type P201Payload,
  type PinnedEgressTarget,
  type ProductionDispatchItem,
  type ProductionDispatchState,
  type ProductionDryRunResult,
  type ProductionOrderPreview,
  type ProductionPhase,
  type ProductionSettingsView,
  type ProductionWebhookService,
  type ProviderState,
  type PublicAnalyticsConfig,
  type RequestP101Input,
  type RequestP201Input,
  type ResendProductionInput,
  type ResolveEgressInput,
  type SamlScaffoldView,
  type ScaffoldsService,
  type SetEgressPresetInput,
  type SharePointScaffoldView,
  type SmtpConfigView,
  type SmtpReadiness,
  type SmtpSendInput,
  type SmtpSendResult,
  type SmtpService,
  type SmtpTestResult,
  type SmtpTransportFactory,
  type StripeConfigView,
  type StripeService,
  type StripeWebhookResult,
  type UpdateAnalyticsConfigInput,
  type UpdateEgressRuleInput,
  type UpdateProductionSettingsInput,
  type UpdateSamlScaffoldInput,
  type UpdateSmtpConfigInput,
  type UpdateStripeConfigInput,
};

export const PROVIDER_KEYS = ["smtp", "clarity", "posthog", "stripe", "saml", "sharepoint"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export interface ProviderStatus {
  key: ProviderKey;
  name: string;
  state: ProviderState;
  verified: boolean;
  scaffoldOnly: boolean;
  lastCheckedAt: Date | null;
  summary: string;
}

export interface ProviderRegistry {
  listStatuses(): Promise<ProviderStatus[]>;
  getStatus(key: ProviderKey): Promise<ProviderStatus>;
}

export interface IntegrationsModuleOptions {
  egress?: EgressPolicyOptions;
  smtpTransportFactory?: SmtpTransportFactory;
}

export interface IntegrationsModule extends Omit<ModuleLifecycle, "health"> {
  health(): Promise<ModuleHealth[]>;
  egress: EgressPolicy;
  providers: ProviderRegistry;
  smtp: SmtpService;
  analytics: AnalyticsService;
  stripe: StripeService;
  scaffolds: ScaffoldsService;
  production: ProductionWebhookService;
  /** Convenience hook consumed by `server/http` CSP middleware (`services.integrations.analyticsCsp(pathname)`). */
  analyticsCsp(pathname: string): Promise<AnalyticsCspPolicy | null>;
}

export function createIntegrationsModule(
  deps: ModuleDeps,
  options: IntegrationsModuleOptions = {},
): IntegrationsModule {
  const checks = createProviderChecksStore(deps);
  const egress = createEgressPolicy(deps, options.egress);
  const smtp = createSmtpService(deps, egress, checks, options.smtpTransportFactory);
  const analytics = createAnalyticsService(deps);
  const stripe = createStripeService(deps, checks);
  const scaffolds = createScaffoldsService(deps);
  const production = createProductionWebhookService(deps, egress, checks);

  async function buildAllStatuses(): Promise<ProviderStatus[]> {
    const [smtpView, analyticsView, stripeView, samlView, sharepointView] = await Promise.all([
      smtp.getConfig(),
      analytics.getAdminConfig(),
      stripe.getConfig(),
      scaffolds.getSamlScaffold(),
      scaffolds.getSharePointScaffold(),
    ]);

    const clarityState: ProviderState = !analyticsView.clarity.configured
      ? "not_configured"
      : !analyticsView.clarity.enabled
        ? "disabled"
        : "configured";
    const claritySummary = !analyticsView.clarity.configured
      ? "Microsoft Clarity project ID is not configured — off by default."
      : !analyticsView.clarity.enabled
        ? "Microsoft Clarity project ID saved, but analytics tag is disabled."
        : "Configured for /privacy and /terms after visitor consent (live vendor delivery not verified by server).";

    const posthogState: ProviderState = !analyticsView.posthog.configured
      ? "not_configured"
      : !analyticsView.posthog.enabled
        ? "disabled"
        : "configured";
    const posthogSummary = !analyticsView.posthog.configured
      ? "PostHog project token is not configured — off by default."
      : !analyticsView.posthog.enabled
        ? "PostHog project token saved, but event capture is disabled."
        : "Configured for /privacy and /terms after visitor consent (live vendor delivery not verified by server).";

    return [
      {
        key: "smtp",
        name: "Outbound SMTP Mail (TLS)",
        state: smtpView.state,
        verified: smtpView.verified,
        scaffoldOnly: false,
        lastCheckedAt: smtpView.lastCheckedAt,
        summary: smtpView.summary,
      },
      {
        key: "clarity",
        name: "Microsoft Clarity Analytics",
        state: clarityState,
        verified: false,
        scaffoldOnly: false,
        lastCheckedAt: null,
        summary: claritySummary,
      },
      {
        key: "posthog",
        name: "PostHog Analytics",
        state: posthogState,
        verified: false,
        scaffoldOnly: false,
        lastCheckedAt: null,
        summary: posthogSummary,
      },
      {
        key: "stripe",
        name: "Stripe Payment Webhooks",
        state: stripeView.state,
        verified: stripeView.verified,
        scaffoldOnly: true,
        lastCheckedAt: stripeView.lastCheckedAt,
        summary: stripeView.summary,
      },
      {
        key: "saml",
        name: "Enterprise SAML 2.0 SSO",
        state: samlView.state,
        verified: false,
        scaffoldOnly: true,
        lastCheckedAt: null,
        summary: samlView.releaseBanner,
      },
      {
        key: "sharepoint",
        name: "Microsoft 365 / SharePoint Sync",
        state: sharepointView.state,
        verified: false,
        scaffoldOnly: true,
        lastCheckedAt: null,
        summary: sharepointView.summary,
      },
    ];
  }

  function mapProviderToHealthState(p: ProviderStatus): HealthState {
    if (p.state === "disabled") return "disabled";
    if (p.state === "not_configured") return "not_configured";
    if (p.state === "failing") return "failing";
    if (p.state === "degraded") return "degraded";
    // `state === "configured"`: ONLY report `"ok"` when a real check succeeded (`verified === true`).
    return p.verified ? "ok" : "degraded";
  }

  const providers: ProviderRegistry = {
    listStatuses: buildAllStatuses,
    async getStatus(key: ProviderKey): Promise<ProviderStatus> {
      const list = await buildAllStatuses();
      const found = list.find((item) => item.key === key);
      if (!found) {
        throw new Error(`Unknown integration provider key: ${key}`);
      }
      return found;
    },
  };

  return {
    egress,
    providers,
    smtp,
    analytics,
    stripe,
    scaffolds,
    production,
    analyticsCsp: (pathname) => analytics.analyticsCsp(pathname),

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      const [statuses, prodView, prodCheck] = await Promise.all([
        buildAllStatuses(),
        production.getSettings(),
        checks.get("production"),
      ]);
      const base = statuses.map((p): ModuleHealth => {
        const component = p.key === "smtp" ? "mail.smtp" : `integrations.${p.key}`;
        return {
          component,
          state: mapProviderToHealthState(p),
          summary: p.summary,
          checkedAt,
        };
      });
      const prodVerified = Boolean(prodCheck?.verifiedAt && prodCheck.lastOutcome === "succeeded");
      const prodState: HealthState =
        prodView.state === "disabled"
          ? "disabled"
          : prodView.state === "not_configured"
            ? "not_configured"
            : prodView.state === "failing"
              ? "failing"
              : prodView.state === "degraded"
                ? "degraded"
                : prodVerified
                  ? "ok"
                  : "degraded";
      base.push({
        component: "integrations.production",
        state: prodState,
        summary: prodView.summary,
        checkedAt,
      });
      return base;
    },
  };
}
