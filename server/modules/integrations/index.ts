/**
 * Integrations module — public service surface and factory. Owner: integrations module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.integrations` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { HealthState, ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import type { SsoStatusSummary } from "../identity/sso/service.js";
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
import {
  createGraphModuleRuntime,
  createGraphTokenCache,
  GraphApiError,
  type GraphAdminService,
  type GraphClient,
  type GraphConfigView,
  type GraphConnectionTestResult,
  type GraphCredentialsInput,
  type GraphHttpMethod,
  type GraphMailTestResult,
  type GraphReadiness,
  type GraphRequestInput,
  type GraphResponse,
  type GraphEntraRunbookView,
  type GraphSitesSelectedWriteCheckInput,
  type GraphSitesSelectedWriteCheckResult,
  type GraphUploadChunkInput,
  type GraphUploadChunkResult,
  type GraphUploadSessionControlInput,
  type UpdateGraphConfigInput,
} from "./graph/index.js";
import { createProviderChecksStore, type ProviderCheckRecord } from "./providerChecks.js";
import {
  createSmtpService,
  type ProviderState,
  type SmtpConfigView,
  type SmtpReadiness,
  type SmtpSenderIdentity,
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
  STRIPE_PAYMENTS_SETUP_NOTICE,
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
  PRODUCTION_PHASES,
  PRODUCTION_RECONCILE_JOB,
  PRODUCTION_SENDING_GRACE_MS,
  PRODUCTION_SETTINGS_HREF,
  PRODUCTION_STALE_QUEUED_MS,
  type ControlledResendReason,
  type LaterProductionPhase,
  type ListProductionDispatchesInput,
  type MaskedWebhookUrlView,
  type P101Payload,
  type P201Payload,
  type P301Payload,
  type P401Payload,
  type ProductionDisabledReason,
  type ProductionDisabledReasonCategory,
  type ProductionDispatchItem,
  type ProductionDispatchState,
  type ProductionDryRunResult,
  type ProductionLaterPhasePreview,
  type ProductionOrderPreview,
  type ProductionPhase,
  type ProductionSettingsView,
  type ProductionWebhookService,
  type RedeliverProductionDispatchInput,
  type RequestLaterPhaseInput,
  type RequestP101Input,
  type RequestP201Input,
  type ResendProductionInput,
  type RetryProductionDispatchInput,
  type StopProductionDispatchInput,
  type UpdateProductionSettingsInput,
  type WorkflowAutoQueueItemView,
} from "./production/index.js";
import {
  createInboundWebhooksHttpRouter,
  createWebhooksService,
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DIRECTIONS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PURGE_JOB,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  type CreateWebhookInboundEndpointInput,
  type CreateWebhookSubscriptionInput,
  type InboundHttpReceiveInput,
  type InboundHttpReceiveResult,
  type ListWebhookDeliveriesInput,
  type UpdateWebhookInboundEndpointInput,
  type UpdateWebhookSubscriptionInput,
  type UpdateWebhooksSettingsInput,
  type WebhookCatalogueEventView,
  type WebhookDeliveryAttemptView,
  type WebhookDeliveryDetailView,
  type WebhookDeliveryListItemView,
  type WebhookDeliveryStatus,
  type WebhookDirection,
  type WebhookInboundEndpointView,
  type WebhookPublishOptions,
  type WebhookSubscriptionStatus,
  type WebhookSubscriptionView,
  type WebhooksService,
  type WebhooksSettingsView,
} from "./webhooks/index.js";
import {
  createWorkflowWebhooksService,
  STAGE_WEBHOOK_TRIGGER_SOURCES,
  WORKFLOW_WEBHOOK_KINDS,
  type EnqueueStageWebhookInput,
  type EnqueueStageWebhookOutcome,
  type EnqueueStageWebhookResult,
  type ListWorkflowWebhookOptionsInput,
  type StageWebhookTriggerSource,
  type WorkflowLifecycleAutoQueuePolicy,
  type WorkflowWebhookOptionView,
  type WorkflowWebhooksService,
  type WorkflowWebhookTargetKind,
  type WorkflowWebhookValidationResult,
} from "./workflowWebhooks/index.js";

// Ensure all `integrations.*` settings/secrets/flags register on module import.
import "./settings.js";

export {
  createInboundWebhooksHttpRouter,
  createPinnedLookup,
  EGRESS_PRESET_KEYS,
  EGRESS_PROTOCOLS,
  EGRESS_PURPOSES,
  GraphApiError,
  PRODUCTION_DELIVERY_JOB,
  PRODUCTION_DISPATCH_MAX_TTL_MS,
  PRODUCTION_MAX_ATTEMPTS,
  PRODUCTION_PHASES,
  PRODUCTION_RECONCILE_JOB,
  PRODUCTION_SENDING_GRACE_MS,
  PRODUCTION_SETTINGS_HREF,
  PRODUCTION_STALE_QUEUED_MS,
  STRIPE_LEDGER_MUTATION_ENABLED,
  STRIPE_PAYMENTS_SETUP_NOTICE,
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DIRECTIONS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PURGE_JOB,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  WORKFLOW_WEBHOOK_KINDS,
  STAGE_WEBHOOK_TRIGGER_SOURCES,
  type AdminAnalyticsConfig,
  type EnqueueStageWebhookInput,
  type EnqueueStageWebhookOutcome,
  type EnqueueStageWebhookResult,
  type ListWorkflowWebhookOptionsInput,
  type StageWebhookTriggerSource,
  type WorkflowLifecycleAutoQueuePolicy,
  type WorkflowWebhookOptionView,
  type WorkflowWebhooksService,
  type WorkflowWebhookTargetKind,
  type WorkflowWebhookValidationResult,
  type AnalyticsCspPolicy,
  type AnalyticsService,
  type ControlledResendReason,
  type CreateEgressRuleInput,
  type CreateWebhookInboundEndpointInput,
  type CreateWebhookSubscriptionInput,
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
  type GraphAdminService,
  type GraphClient,
  type GraphConfigView,
  type GraphConnectionTestResult,
  type GraphCredentialsInput,
  type GraphHttpMethod,
  type GraphMailTestResult,
  type GraphReadiness,
  type GraphRequestInput,
  type GraphResponse,
  type GraphEntraRunbookView,
  type GraphSitesSelectedWriteCheckInput,
  type GraphSitesSelectedWriteCheckResult,
  type GraphUploadChunkInput,
  type GraphUploadChunkResult,
  type GraphUploadSessionControlInput,
  type InboundHttpReceiveInput,
  type InboundHttpReceiveResult,
  type LaterProductionPhase,
  type ListProductionDispatchesInput,
  type ListWebhookDeliveriesInput,
  type MaskedWebhookUrlView,
  type P101Payload,
  type P201Payload,
  type P301Payload,
  type P401Payload,
  type PinnedEgressTarget,
  type ProductionDisabledReason,
  type ProductionDisabledReasonCategory,
  type ProductionDispatchItem,
  type ProductionDispatchState,
  type ProductionDryRunResult,
  type ProductionLaterPhasePreview,
  type ProductionOrderPreview,
  type ProductionPhase,
  type ProductionSettingsView,
  type ProductionWebhookService,
  type ProviderState,
  type PublicAnalyticsConfig,
  type RedeliverProductionDispatchInput,
  type RequestLaterPhaseInput,
  type RequestP101Input,
  type RequestP201Input,
  type ResendProductionInput,
  type RetryProductionDispatchInput,
  type StopProductionDispatchInput,
  type ResolveEgressInput,
  type SetEgressPresetInput,
  type SmtpConfigView,
  type SmtpReadiness,
  type SmtpSenderIdentity,
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
  type UpdateGraphConfigInput,
  type UpdateProductionSettingsInput,
  type UpdateSmtpConfigInput,
  type UpdateStripeConfigInput,
  type UpdateWebhookInboundEndpointInput,
  type UpdateWebhookSubscriptionInput,
  type UpdateWebhooksSettingsInput,
  type WebhookCatalogueEventView,
  type WebhookDeliveryAttemptView,
  type WebhookDeliveryDetailView,
  type WebhookDeliveryListItemView,
  type WebhookDeliveryStatus,
  type WebhookDirection,
  type WebhookInboundEndpointView,
  type WebhookPublishOptions,
  type WebhookSubscriptionStatus,
  type WebhookSubscriptionView,
  type WebhooksService,
  type WebhooksSettingsView,
  type WorkflowAutoQueueItemView,
};

export const PROVIDER_KEYS = ["smtp", "graph", "clarity", "posthog", "stripe", "saml", "sharepoint"] as const;
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
  init(): void;
  stop(): void;
  health(): Promise<ModuleHealth[]>;
  egress: EgressPolicy;
  providers: ProviderRegistry;
  smtp: SmtpService;
  graph: GraphClient;
  graphAdmin: GraphAdminService;
  createScopedGraphClient(
    credentials?: GraphCredentialsInput | (() => Promise<GraphCredentialsInput | null>),
  ): GraphClient;
  analytics: AnalyticsService;
  stripe: StripeService;
  production: ProductionWebhookService;
  webhooks: WebhooksService;
  workflowWebhooks: WorkflowWebhooksService;
  /** Convenience hook consumed by `server/http` CSP middleware (`services.integrations.analyticsCsp(pathname)`). */
  analyticsCsp(pathname: string): Promise<AnalyticsCspPolicy | null>;
}

const SSO_CERT_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

interface DerivedCardFields {
  state: ProviderState;
  verified: boolean;
  lastCheckedAt: Date | null;
  summary: string;
}

interface FileSyncStatusSummarySnapshot {
  totalConnections: number;
  enabledConnections: number;
  approvedConnections: number;
  writeTestedConnections: number;
  readyConnections: number;
  failingConnections: number;
  blockedTransfers: number;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
}

interface PaymentsHealthSnapshot {
  provider: "none" | "stripe" | "square";
  onlineEnabled: boolean;
  redirectedAttempts: number;
  retryPendingWebhooks: number;
}

interface PaymentsConfigSnapshot {
  provider?: string;
  mode?: string;
  stripeSecretKeyLast4?: string | null;
  stripeWebhookSecretLast4?: string | null;
  stripeLastApiVerifiedAt?: string | null;
  stripeLastSelfTestAt?: string | null;
}

function latestValidDate(...candidates: (Date | null | undefined)[]): Date | null {
  let latest: Date | null = null;
  for (const candidate of candidates) {
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
      if (!latest || candidate.getTime() > latest.getTime()) {
        latest = candidate;
      }
    }
  }
  return latest;
}

function parseOptionalIsoDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatSsoProtocolLabel(protocol: SsoStatusSummary["protocol"]): string {
  return protocol === "saml" ? "SAML 2.0" : "OpenID Connect (Entra ID)";
}

function formatSsoMfaModeWords(mode: SsoStatusSummary["entraMfaMode"]): string {
  switch (mode) {
    case "portal":
      return "Portal MFA always";
    case "claim":
      return "MFA claim required";
    case "entra":
      return "Entra manages MFA";
  }
}

function deriveSamlCardStatus(ssoSummary: SsoStatusSummary | null, now: Date): DerivedCardFields {
  if (!ssoSummary) {
    return {
      state: "not_configured",
      verified: false,
      lastCheckedAt: null,
      summary: "Single sign-on is not configured — set up SAML 2.0 or Microsoft Entra ID in Single Sign-On settings.",
    };
  }

  const modeHeadline = `${formatSsoProtocolLabel(ssoSummary.protocol)} · ${formatSsoMfaModeWords(ssoSummary.entraMfaMode)}`;
  const lastCheckedAt = latestValidDate(ssoSummary.lastSignInAt, ssoSummary.metadataCheckedAt);
  const verificationSucceeded =
    ssoSummary.lastSignInAt !== null ||
    (ssoSummary.metadataCheckedAt !== null && ssoSummary.metadataStatus === "OK");
  const metadataFailed =
    ssoSummary.protocol === "saml" &&
    ssoSummary.metadataStatus !== null &&
    ssoSummary.metadataStatus !== "OK";
  const certExpiringSoon =
    ssoSummary.protocol === "saml" &&
    ssoSummary.nearestCertificateExpiry !== null &&
    ssoSummary.nearestCertificateExpiry.getTime() - now.getTime() <= SSO_CERT_EXPIRY_WARNING_MS;
  const hadPriorSamlCheck = ssoSummary.metadataCheckedAt !== null || ssoSummary.lastSignInAt !== null;

  if (
    ssoSummary.protocol === "saml" &&
    ssoSummary.trustedCertificates === 0 &&
    (ssoSummary.enabled || (ssoSummary.configured && hadPriorSamlCheck))
  ) {
    return {
      state: "failing",
      verified: false,
      lastCheckedAt,
      summary: `${modeHeadline} — no valid active signing certificate; upload or refresh the IdP certificate in Single Sign-On settings.`,
    };
  }

  if (ssoSummary.enabled && (!ssoSummary.complete || !ssoSummary.availableInThisDeployment)) {
    return {
      state: "failing",
      verified: false,
      lastCheckedAt,
      summary: !ssoSummary.availableInThisDeployment
        ? `${modeHeadline} — HTTPS callback origin is required in this deployment.`
        : `${modeHeadline} — enabled with incomplete provider configuration.`,
    };
  }

  if (!ssoSummary.configured || (!ssoSummary.enabled && !ssoSummary.complete)) {
    return {
      state: "not_configured",
      verified: false,
      lastCheckedAt,
      summary: !ssoSummary.configured
        ? `${modeHeadline} — no directory tenant or signing certificate configured.`
        : ssoSummary.protocol === "saml"
          ? `${modeHeadline} — add SAML entity/SSO URLs and an active signing certificate to complete setup.`
          : `${modeHeadline} — add client credentials in Single Sign-On settings to complete setup.`,
    };
  }

  if (!ssoSummary.enabled) {
    return {
      state: "disabled",
      verified: false,
      lastCheckedAt,
      summary: `${modeHeadline} — configured and switched off.`,
    };
  }

  if (!verificationSucceeded) {
    return {
      state: "degraded",
      verified: false,
      lastCheckedAt,
      summary: `${modeHeadline} — enabled, awaiting first verified sign-in or certificate check.`,
    };
  }

  if (certExpiringSoon && ssoSummary.nearestCertificateExpiry) {
    const daysRemaining = Math.max(
      0,
      Math.ceil((ssoSummary.nearestCertificateExpiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    );
    return {
      state: "degraded",
      verified: false,
      lastCheckedAt,
      summary: `${modeHeadline} — active signing certificate expires within 30 days (${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining).`,
    };
  }

  if (metadataFailed) {
    return {
      state: "degraded",
      verified: false,
      lastCheckedAt,
      summary: `${modeHeadline} — last metadata refresh reported ${ssoSummary.metadataStatus}; active certificate remains valid.`,
    };
  }

  return {
    state: "configured",
    verified: true,
    lastCheckedAt,
    summary:
      ssoSummary.protocol === "saml"
        ? `${modeHeadline} — enabled and verified (${ssoSummary.trustedCertificates} active signing certificate${ssoSummary.trustedCertificates === 1 ? "" : "s"}).`
        : `${modeHeadline} — enabled and verified.`,
  };
}

function deriveSharePointCardStatus(
  fileSyncSummary: FileSyncStatusSummarySnapshot | null,
  graphPresetEnabled: boolean,
  graphUploadPresetEnabled: boolean,
  sharepointCheck: ProviderCheckRecord | null,
): DerivedCardFields {
  const bothPresetsEnabled = graphPresetEnabled && graphUploadPresetEnabled;

  if (!fileSyncSummary) {
    const verified = bothPresetsEnabled && sharepointCheck?.lastOutcome === "succeeded";
    const state: ProviderState =
      !graphPresetEnabled && !graphUploadPresetEnabled
        ? "disabled"
        : sharepointCheck?.lastOutcome === "failed"
          ? "failing"
          : bothPresetsEnabled
            ? "configured"
            : "degraded";
    const summary =
      !graphPresetEnabled && !graphUploadPresetEnabled
        ? "Microsoft 365 SharePoint & OneDrive sync is switched off until both Graph egress presets and an Entra Sites.Selected connection are configured."
        : !bothPresetsEnabled
          ? `Enable both Microsoft Graph (${graphPresetEnabled ? "on" : "off"}) and SharePoint Upload Session (${graphUploadPresetEnabled ? "on" : "off"}) egress presets before syncing files.`
          : verified
            ? "Graph + upload egress presets enabled and Entra Sites.Selected write check passed."
            : sharepointCheck?.lastOutcome === "failed"
              ? "The most recent Entra Sites.Selected check failed — verify site grant and re-test in Storage."
              : "Graph + upload egress presets enabled — run the Entra Sites.Selected write check in Storage.";
    return {
      state,
      verified,
      lastCheckedAt: sharepointCheck?.lastCheckedAt ?? null,
      summary,
    };
  }

  const lastCheckedAt = latestValidDate(
    fileSyncSummary.lastCheckedAt,
    fileSyncSummary.lastSuccessAt,
    sharepointCheck?.lastCheckedAt,
  );

  if (fileSyncSummary.totalConnections === 0) {
    if (sharepointCheck?.lastOutcome === "failed") {
      return {
        state: "failing",
        verified: false,
        lastCheckedAt,
        summary:
          "The most recent Entra Sites.Selected probe failed and no SharePoint or OneDrive connection is configured in Storage.",
      };
    }
    if (bothPresetsEnabled && sharepointCheck?.lastOutcome === "succeeded") {
      return {
        state: "degraded",
        verified: false,
        lastCheckedAt,
        summary:
          "Graph egress presets and Entra Sites.Selected probe passed — add and approve a SharePoint or OneDrive connection in Storage.",
      };
    }
    return {
      state: "not_configured",
      verified: false,
      lastCheckedAt,
      summary:
        "No SharePoint or OneDrive storage connection is configured — add a connection in Storage and approve a destination in File sync.",
    };
  }

  if (fileSyncSummary.enabledConnections === 0) {
    return {
      state: "disabled",
      verified: false,
      lastCheckedAt,
      summary: `${fileSyncSummary.totalConnections} Microsoft 365 connection${fileSyncSummary.totalConnections === 1 ? "" : "s"} configured in Storage, currently switched off${fileSyncSummary.blockedTransfers > 0 ? ` (${fileSyncSummary.blockedTransfers} retained transfer${fileSyncSummary.blockedTransfers === 1 ? "" : "s"} awaiting review)` : ""}.`,
    };
  }

  if (fileSyncSummary.failingConnections > 0) {
    return {
      state: "failing",
      verified: false,
      lastCheckedAt,
      summary: `${fileSyncSummary.failingConnections} enabled Microsoft 365 connection${fileSyncSummary.failingConnections === 1 ? " requires" : "s require"} attention in File sync${fileSyncSummary.blockedTransfers > 0 ? ` (${fileSyncSummary.blockedTransfers} blocked or failed transfer${fileSyncSummary.blockedTransfers === 1 ? "" : "s"})` : ""}.`,
    };
  }

  if (!bothPresetsEnabled) {
    return {
      state: "degraded",
      verified: false,
      lastCheckedAt,
      summary: `Microsoft 365 connection enabled, but outbound presets require both Microsoft Graph (${graphPresetEnabled ? "on" : "off"}) and SharePoint Upload Session (${graphUploadPresetEnabled ? "on" : "off"}).`,
    };
  }

  if (fileSyncSummary.readyConnections === 0) {
    return {
      state: "degraded",
      verified: false,
      lastCheckedAt,
      summary:
        fileSyncSummary.approvedConnections === 0
          ? "Microsoft 365 connection enabled in Storage — run the write test and approve a destination in File sync."
          : "Microsoft 365 file-sync destination needs a current write test in File sync.",
    };
  }

  if (fileSyncSummary.blockedTransfers > 0) {
    return {
      state: "degraded",
      verified: false,
      lastCheckedAt,
      summary: `${fileSyncSummary.readyConnections} Microsoft 365 file-sync destination${fileSyncSummary.readyConnections === 1 ? "" : "s"} ready, with ${fileSyncSummary.blockedTransfers} transfer${fileSyncSummary.blockedTransfers === 1 ? "" : "s"} awaiting review in File sync.`,
    };
  }

  return {
    state: "configured",
    verified: true,
    lastCheckedAt,
    summary: `${fileSyncSummary.readyConnections} Microsoft 365 file-sync destination${fileSyncSummary.readyConnections === 1 ? "" : "s"} enabled, approved, and write-tested${fileSyncSummary.lastSuccessAt ? " (managed copies verified)" : ""}.`,
  };
}

function deriveStripeCardStatus(
  paymentsHealth: PaymentsHealthSnapshot | null,
  paymentsCfg: PaymentsConfigSnapshot | null,
  stripePresetEnabled: boolean,
  stripeView: StripeConfigView,
): DerivedCardFields {
  const modeLabel = paymentsCfg?.mode === "live" ? "live" : "test";
  const paymentsCheckedAt = latestValidDate(
    parseOptionalIsoDate(paymentsCfg?.stripeLastApiVerifiedAt),
    parseOptionalIsoDate(paymentsCfg?.stripeLastSelfTestAt),
    stripeView.lastCheckedAt,
  );

  if (paymentsHealth?.provider === "stripe" && paymentsHealth.onlineEnabled) {
    if (paymentsHealth.retryPendingWebhooks > 0) {
      return {
        state: "degraded",
        verified: false,
        lastCheckedAt: paymentsCheckedAt,
        summary: `Stripe (${modeLabel} mode) online checkout is active with ${paymentsHealth.retryPendingWebhooks} webhook retr${paymentsHealth.retryPendingWebhooks === 1 ? "y" : "ies"} pending.`,
      };
    }
    return {
      state: "configured",
      verified: true,
      lastCheckedAt: paymentsCheckedAt,
      summary: `Stripe (${modeLabel} mode) online checkout and signed webhooks are active and verified.`,
    };
  }

  if (paymentsCfg?.provider === "stripe") {
    return {
      state: !stripePresetEnabled ? "failing" : "degraded",
      verified: false,
      lastCheckedAt: paymentsCheckedAt,
      summary: !stripePresetEnabled
        ? "Stripe is selected in Payment Setup, but the api.stripe.com:443 outbound preset is switched off."
        : "Stripe is selected in Payment Setup — complete API and webhook verification in Payment Setup.",
    };
  }

  if (paymentsCfg?.stripeSecretKeyLast4 || paymentsCfg?.stripeWebhookSecretLast4) {
    return {
      state: "disabled",
      verified: false,
      lastCheckedAt: paymentsCheckedAt,
      summary:
        paymentsHealth?.provider === "square"
          ? "Stripe credentials are staged in Payment Setup, while Square is the active payment provider."
          : "Stripe credentials are staged in Payment Setup, with Stripe online checkout switched off.",
    };
  }

  return {
    state:
      stripeView.state !== "disabled"
        ? stripeView.state
        : stripePresetEnabled
          ? "configured"
          : "disabled",
    verified: stripeView.verified,
    lastCheckedAt: stripeView.lastCheckedAt,
    summary: stripePresetEnabled
      ? "Outbound api.stripe.com:443 preset is enabled — manage keys, webhooks and readiness in Payment Setup."
      : "Outbound api.stripe.com:443 preset is switched off — open Payment Setup or Outbound connections to enable Stripe.",
  };
}

export function createIntegrationsModule(
  deps: ModuleDeps,
  options: IntegrationsModuleOptions = {},
): IntegrationsModule {
  const checks = createProviderChecksStore(deps);
  const egress = createEgressPolicy(deps, options.egress);
  const smtp = createSmtpService(deps, egress, checks, options.smtpTransportFactory);
  const graphTokenCache = createGraphTokenCache(egress, deps.clock);
  const graphRuntime = createGraphModuleRuntime(deps, egress, checks, graphTokenCache);
  const analytics = createAnalyticsService(deps);
  const stripe = createStripeService(deps, checks);
  const production = createProductionWebhookService(deps, egress, checks);
  const webhooks = createWebhooksService(deps, egress);
  const workflowWebhooks = createWorkflowWebhooksService(deps, { production, webhooks });

  async function buildAllStatuses(): Promise<ProviderStatus[]> {
    const now = deps.clock.now();
    const ssoStatusSummaryFn = deps.services.identity?.sso?.statusSummary;
    const fileSyncStatusSummaryFn = deps.services.storageConnections?.fileSync?.statusSummary;
    const paymentsHealthCountsFn = deps.services.payments?.healthCounts;

    const [
      smtpView,
      graphView,
      analyticsView,
      stripeView,
      ssoSummary,
      fileSyncSummary,
      paymentsHealth,
      paymentsCfg,
      stripePresetEnabled,
      graphPresetEnabled,
      graphUploadPresetEnabled,
      sharepointCheck,
    ] = await Promise.all([
      smtp.getConfig(),
      graphRuntime.admin.getConfig(),
      analytics.getAdminConfig(),
      stripe.getConfig(),
      ssoStatusSummaryFn ? ssoStatusSummaryFn() : Promise.resolve(null),
      fileSyncStatusSummaryFn ? fileSyncStatusSummaryFn() : Promise.resolve(null),
      paymentsHealthCountsFn ? paymentsHealthCountsFn() : Promise.resolve(null),
      deps.settings.get<PaymentsConfigSnapshot | null>(
        "payments.config",
        (raw) => (raw && typeof raw === "object" ? (raw as PaymentsConfigSnapshot) : null),
        null,
      ),
      egress.isPresetEnabled("stripe"),
      egress.isPresetEnabled("microsoft_graph"),
      egress.isPresetEnabled("microsoft_graph_upload"),
      checks.get("sharepoint"),
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

    const stripeCard = deriveStripeCardStatus(paymentsHealth, paymentsCfg, stripePresetEnabled, stripeView);
    const samlCard = deriveSamlCardStatus(ssoSummary, now);
    const sharepointCard = deriveSharePointCardStatus(
      fileSyncSummary,
      graphPresetEnabled,
      graphUploadPresetEnabled,
      sharepointCheck,
    );

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
        key: "graph",
        name: "Microsoft Graph Mail & Cloud",
        state: graphView.state,
        verified: graphView.verified,
        scaffoldOnly: false,
        lastCheckedAt: graphView.lastCheckedAt,
        summary: graphView.summary,
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
        name: "Stripe Payments",
        state: stripeCard.state,
        verified: stripeCard.verified,
        scaffoldOnly: false,
        lastCheckedAt: stripeCard.lastCheckedAt,
        summary: stripeCard.summary,
      },
      {
        key: "saml",
        name: "Enterprise SAML 2.0 SSO",
        state: samlCard.state,
        verified: samlCard.verified,
        scaffoldOnly: false,
        lastCheckedAt: samlCard.lastCheckedAt,
        summary: samlCard.summary,
      },
      {
        key: "sharepoint",
        name: "Microsoft 365 / SharePoint Sync",
        state: sharepointCard.state,
        verified: sharepointCard.verified,
        scaffoldOnly: false,
        lastCheckedAt: sharepointCard.lastCheckedAt,
        summary: sharepointCard.summary,
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
    graph: graphRuntime.client,
    graphAdmin: graphRuntime.admin,
    createScopedGraphClient: graphRuntime.createScopedClient,
    analytics,
    stripe,
    production,
    webhooks,
    workflowWebhooks,
    analyticsCsp: (pathname) => analytics.analyticsCsp(pathname),

    init(): void {
      deps.services.jobAdmin?.registerMailTransport?.(graphRuntime.mailTransport);
      webhooks.init();
      workflowWebhooks.init();
    },

    stop(): void {
      graphTokenCache.clear();
    },

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      const [statuses, prodView, prodCheck, webhooksHealth] = await Promise.all([
        buildAllStatuses(),
        production.getSettings(),
        checks.get("production"),
        webhooks.health(),
      ]);
      const base = statuses.map((p): ModuleHealth => {
        const component =
          p.key === "smtp" ? "mail.smtp" : p.key === "graph" ? "mail.graph" : `integrations.${p.key}`;
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
      base.push(webhooksHealth);
      return base;
    },
  };
}
