/**
 * Production pipeline webhooks (P101 / P201 / P301 / P401) — client contract types and presentation helpers.
 * Mirrors `trpc.integrations.production.*` (INCREMENT_02_CONTRACT.md §D, INCREMENT_04_PART_B.md §B4 & ADR 0023).
 */
import type { Tone } from "@/ui";

export type ProductionPhase = "P101" | "P201" | "P301" | "P401";
export type ProductionDispatchState =
  | "queued"
  | "sending"
  | "delivered"
  | "failed"
  | "dead"
  | "unknown";
export type ProductionSettingsState =
  | "disabled"
  | "not_configured"
  | "configured"
  | "degraded"
  | "failing";

export type ProductionDisabledCategory =
  | "pipeline_off"
  | "endpoint_missing"
  | "config_incomplete"
  | "in_progress"
  | "already_delivered"
  | "retry_or_resend_required"
  | "precondition";

export interface ProductionDisabledReason {
  code: string;
  category: ProductionDisabledCategory;
  message: string;
  /** True when an administrator can resolve this in `/admin/integrations/production`. */
  settingsActionable: boolean;
}

export interface ProductionUrlMask {
  host: string;
  last4: string;
}

export interface ProductionSettingsView {
  enabled: boolean;
  configured: boolean;
  state: ProductionSettingsState;
  summary: string;
  p101UrlConfigured: boolean;
  p101UrlMask: ProductionUrlMask | null;
  p201UrlConfigured: boolean;
  p201UrlMask: ProductionUrlMask | null;
  p301UrlConfigured: boolean;
  p301UrlMask: ProductionUrlMask | null;
  p401UrlConfigured: boolean;
  p401UrlMask: ProductionUrlMask | null;
  authHeaderName: string;
  authHeaderValueConfigured: boolean;
  canonVersion: string;
  runMode: string;
  timeoutMs: number;
}

export interface ProductionSettingsUpdateInput {
  enabled: boolean;
  p101Url?: string | null;
  p201Url?: string | null;
  p301Url?: string | null;
  p401Url?: string | null;
  authHeaderName?: string;
  authHeaderValue?: string | null;
  canonVersion: string;
  runMode?: string;
  timeoutMs?: number;
}

export interface ProductionDestinationTestResult {
  phase: ProductionPhase;
  allowed: boolean;
  reasonCode: string;
  safeMessage: string;
  host: string | null;
  resolvedAddresses: string[];
  matchedAllowlistRulePublicId: string | null;
  checkedAt: Date | string;
}

export interface P101Payload {
  customer_id: string;
  order_id: string;
  packet: string;
  tier: string;
  canon_version: string;
  run_mode: string;
  client_name: string;
  client_email: string;
  release_status: string;
  bundle_scope_manifest: string;
}

export interface P201Payload {
  customer_id: string;
  order_id: string;
  run_mode: string;
}

export interface ProductionDispatchItem {
  publicId: string;
  orderPublicId: string;
  orderReference: string;
  phase: ProductionPhase;
  state: ProductionDispatchState;
  attemptCount: number;
  maxAttempts: number;
  idempotencyKey: string;
  payloadSha256: string;
  identityTriple: { customerId: string; orderId: string; runMode: string };
  packet: string | null;
  tier: string | null;
  bundleScopeManifest: string | null;
  releaseStatus: string | null;
  httpStatus: number | null;
  responseSummary: string | null;
  lastReasonCode: string | null;
  resendReason: string | null;
  retryOf: string | null;
  redeliveryOf: string | null;
  requestedByPublicId: string | null;
  correlationId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  deliveredAt: Date | string | null;
  finalizedAt: Date | string | null;
}

export interface ProductionValidationError {
  code: string;
  message: string;
}

export interface ProductionLaterPhasePreview {
  configured: boolean;
  eligible: boolean;
  p101Delivered: boolean;
  prerequisiteDelivered: boolean;
  alreadyDelivered: boolean;
  activeState: ProductionDispatchState | null;
  validationErrors: ProductionValidationError[];
  disabledReasons: ProductionDisabledReason[];
  payload: P201Payload | null;
}

export interface ProductionOrderPreview {
  featureEnabled: boolean;
  featureConfigured: boolean;
  settingsHref: string;
  p101: {
    configured: boolean;
    eligible: boolean;
    alreadyDelivered: boolean;
    activeState: ProductionDispatchState | null;
    validationErrors: ProductionValidationError[];
    disabledReasons: ProductionDisabledReason[];
    payload: P101Payload | null;
    maskedForViewer: boolean;
  };
  p201: {
    configured: boolean;
    eligible: boolean;
    p101Delivered: boolean;
    alreadyDelivered: boolean;
    activeState: ProductionDispatchState | null;
    validationErrors: ProductionValidationError[];
    disabledReasons: ProductionDisabledReason[];
    payload: P201Payload | null;
  };
  p301: ProductionLaterPhasePreview;
  p401: ProductionLaterPhasePreview;
}

export interface ProductionListDispatchesInput {
  phase?: ProductionPhase;
  state?: ProductionDispatchState;
  orderReference?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
}

export const PRODUCTION_PIPELINE_PATH = "/admin/integrations/production";
export const REDELIVER_CONFIRM_PHRASE = "REDELIVER";

export const RUN_MODE_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const RELEASE_STATUS_RE = /^[A-Za-z0-9_.-]{0,120}$/;
export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

export const PHASE_LABELS: Record<ProductionPhase, string> = {
  P101: "Phase I intake (P101)",
  P201: "Phase II start (P201)",
  P301: "Phase III start (P301)",
  P401: "Phase IV start (P401)",
};

export const PHASE_START_LABELS: Record<ProductionPhase, string> = {
  P101: "Start Phase I",
  P201: "Start Phase II",
  P301: "Start Phase III",
  P401: "Start Phase IV",
};

export const DISPATCH_STATE_META: Record<ProductionDispatchState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "info" },
  sending: { label: "Sending", tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Failed (retrying)", tone: "warning" },
  dead: { label: "Dead-lettered", tone: "danger" },
  unknown: { label: "Outcome unknown", tone: "warning" },
};

export const SETTINGS_STATE_META: Record<ProductionSettingsState, { label: string; tone: Tone }> = {
  configured: { label: "Configured", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  failing: { label: "Failing", tone: "danger" },
  disabled: { label: "Disabled", tone: "neutral" },
  not_configured: { label: "Not configured", tone: "warning" },
};

export function formatMaskedUrl(mask: ProductionUrlMask | null): string {
  if (!mask) return "Not configured";
  return `https://${mask.host}/…${mask.last4}`;
}

export function auditCorrelationHref(correlationId: string): string {
  return `/admin/audit?${new URLSearchParams({ correlationId })}`;
}
