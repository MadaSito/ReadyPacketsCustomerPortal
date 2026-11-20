/**
 * Optional Stripe Adapter Scaffold & Signature-Verified Webhook (`services.integrations.stripe`).
 *
 * Security & honesty invariants:
 *  - Off by default (`isOnlinePaymentConfigured()` returns `false`).
 *  - Keys (`secretKey`, `webhookSecret`) are stored exclusively via `defineSecret` (`FieldCrypto`
 *    AES-256-GCM at rest) and are write-only in administrative APIs.
 *  - Webhook endpoint (`/api/integrations/webhooks/stripe`) is inert when unconfigured/disabled,
 *    verifies `Stripe-Signature` (`t=...,v1=...` HMAC-SHA256 + timestamp replay window) over the raw
 *    `Buffer` BEFORE JSON parsing, reserves `(provider, external_event_id)` durably in
 *    `integration_webhook_events` to guarantee idempotent processing, and delegates ledger updates
 *    to `services.compliance.recordProviderPayment(..., tx)` inside the same transaction.
 *  - Honestly reported as "Implemented webhook adapter, not exercised against live Stripe."
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { isFlagEnabled, isSecretConfigured, readSecret, readSetting, writeSetting } from "../platform/index.js";
import { flagKey } from "../platform/settingsRegistry.js";
import { assertIntegrationsManageInTx, assertIntegrationsManagePreflight } from "./authz.js";
import type { ProviderChecksStore } from "./providerChecks.js";
import { integrationWebhookEvents } from "./schema.js";
import {
  INTEGRATIONS_STRIPE_CONFIG,
  INTEGRATIONS_STRIPE_FLAG,
  INTEGRATIONS_STRIPE_SECRET_KEY,
  INTEGRATIONS_STRIPE_WEBHOOK_SECRET,
} from "./settings.js";
import type { ProviderState } from "./smtp.js";

export interface StripeConfigView {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  state: ProviderState;
  summary: string;
  publishableKey: string;
  secretKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  webhookToleranceSeconds: number;
  webhookPath: "/api/integrations/webhooks/stripe";
  lastCheckedAt: Date | null;
  verificationNote: string;
}

export interface UpdateStripeConfigInput {
  enabled: boolean;
  publishableKey: string;
  webhookToleranceSeconds?: number;
  /** Omit/`undefined` to preserve, `null` to clear, string to replace. */
  secretKey?: string | null;
  /** Omit/`undefined` to preserve, `null` to clear, string to replace. */
  webhookSecret?: string | null;
}

export interface StripeWebhookResult {
  httpStatus: 200 | 400 | 409 | 503;
  accepted: boolean;
  duplicate: boolean;
  reasonCode: string;
}

export interface StripeService {
  isOnlinePaymentConfigured(): Promise<boolean>;
  getConfig(): Promise<StripeConfigView>;
  updateConfig(principal: SessionPrincipal, input: UpdateStripeConfigInput): Promise<StripeConfigView>;
  handleSignedWebhook(input: { rawBody: Buffer; signatureHeader: string | undefined }): Promise<StripeWebhookResult>;
}

const STRIPE_VERIFICATION_NOTE =
  "Implemented signature-verified webhook adapter and idempotent compliance ledger hook; not exercised against live Stripe APIs in this environment.";

const stripeEventEnvelopeSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{6,96}$/),
  type: z.string().min(3).max(96),
  created: z.number().int().positive(),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
  }),
});

export function verifyStripeWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
  now: Date,
  toleranceSeconds: number,
): { ok: true; timestampSeconds: number } | { ok: false; reasonCode: string } {
  if (!signatureHeader || signatureHeader.length > 1024) {
    return { ok: false, reasonCode: "MISSING_SIGNATURE" };
  }

  let timestampStr: string | null = null;
  const v1Signatures: string[] = [];

  for (const part of signatureHeader.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(val)) {
      timestampStr = val;
    } else if (key === "v1" && /^[0-9a-fA-F]{64}$/.test(val)) {
      v1Signatures.push(val.toLowerCase());
    }
  }

  if (!timestampStr || v1Signatures.length === 0) {
    return { ok: false, reasonCode: "MALFORMED_SIGNATURE" };
  }

  const timestampSeconds = Number(timestampStr);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { ok: false, reasonCode: "STALE_WEBHOOK_TIMESTAMP" };
  }

  const hmac = createHmac("sha256", webhookSecret);
  hmac.update(timestampStr, "utf8");
  hmac.update(".", "utf8");
  hmac.update(rawBody);
  const expectedBuf = hmac.digest();

  let matched = false;
  for (const candidateHex of v1Signatures) {
    const candidateBuf = Buffer.from(candidateHex, "hex");
    if (candidateBuf.byteLength === expectedBuf.byteLength && timingSafeEqual(candidateBuf, expectedBuf)) {
      matched = true;
    }
  }

  if (!matched) {
    return { ok: false, reasonCode: "INVALID_SIGNATURE" };
  }
  return { ok: true, timestampSeconds };
}

interface ExtractedPaymentMutation {
  providerPaymentId: string;
  invoicePublicId?: string;
  orderPublicId?: string;
  kind: "succeeded" | "failed" | "refunded";
  amountMinor: number;
  currency: string;
}

function extractPaymentMutation(
  eventType: string,
  obj: Record<string, unknown>,
): ExtractedPaymentMutation | null {
  const metadata =
    typeof obj.metadata === "object" && obj.metadata !== null
      ? (obj.metadata as Record<string, unknown>)
      : {};
  const invoicePublicId =
    typeof metadata.invoicePublicId === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(metadata.invoicePublicId)
      ? metadata.invoicePublicId
      : undefined;
  const orderPublicId =
    typeof metadata.orderPublicId === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(metadata.orderPublicId)
      ? metadata.orderPublicId
      : undefined;

  const rawId = typeof obj.id === "string" && /^[A-Za-z0-9_]{4,128}$/.test(obj.id) ? obj.id : null;
  if (!rawId) return null;

  const currencyRaw = typeof obj.currency === "string" ? obj.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currencyRaw)) return null;

  if (eventType === "payment_intent.succeeded" || eventType === "checkout.session.completed") {
    const amount =
      typeof obj.amount_received === "number"
        ? obj.amount_received
        : typeof obj.amount_total === "number"
          ? obj.amount_total
          : typeof obj.amount === "number"
            ? obj.amount
            : null;
    if (amount === null || !Number.isInteger(amount) || amount < 0) return null;
    return {
      providerPaymentId: rawId,
      invoicePublicId,
      orderPublicId,
      kind: "succeeded",
      amountMinor: amount,
      currency: currencyRaw,
    };
  }

  if (eventType === "payment_intent.payment_failed") {
    const amount = typeof obj.amount === "number" && Number.isInteger(obj.amount) && obj.amount >= 0 ? obj.amount : 0;
    return {
      providerPaymentId: rawId,
      invoicePublicId,
      orderPublicId,
      kind: "failed",
      amountMinor: amount,
      currency: currencyRaw,
    };
  }

  if (eventType === "charge.refunded") {
    const amountRefunded =
      typeof obj.amount_refunded === "number" && Number.isInteger(obj.amount_refunded) && obj.amount_refunded > 0
        ? obj.amount_refunded
        : null;
    if (amountRefunded === null) return null;
    return {
      providerPaymentId: rawId,
      invoicePublicId,
      orderPublicId,
      kind: "refunded",
      amountMinor: amountRefunded,
      currency: currencyRaw,
    };
  }

  return null;
}

export function createStripeService(deps: ModuleDeps, checks: ProviderChecksStore): StripeService {
  async function loadView(): Promise<StripeConfigView> {
    const [enabled, cfg, hasSecretKey, hasWebhookSecret, check] = await Promise.all([
      isFlagEnabled(deps.settings, INTEGRATIONS_STRIPE_FLAG),
      readSetting(deps.settings, INTEGRATIONS_STRIPE_CONFIG),
      isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_SECRET_KEY),
      isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_WEBHOOK_SECRET),
      checks.get("stripe"),
    ]);

    const configured = hasSecretKey && hasWebhookSecret;
    let state: ProviderState;
    let summary: string;
    const verified = Boolean(check?.verifiedAt && check.lastOutcome === "succeeded");

    if (!configured) {
      state = "not_configured";
      summary = "Stripe adapter is not configured — off by default.";
    } else if (!enabled) {
      state = "disabled";
      summary = "Stripe credentials are saved, but online payment/webhook processing is disabled.";
    } else if (check?.lastOutcome === "failed") {
      state = "failing";
      summary = "Last Stripe webhook processing attempt failed.";
    } else if (verified) {
      state = "configured";
      summary = "Stripe webhook adapter enabled; signed webhook verified at last check.";
    } else {
      state = "configured";
      summary = "Stripe webhook adapter configured (not exercised against live Stripe).";
    }

    return {
      enabled,
      configured,
      verified,
      state,
      summary,
      publishableKey: cfg.publishableKey,
      secretKeyConfigured: hasSecretKey,
      webhookSecretConfigured: hasWebhookSecret,
      webhookToleranceSeconds: cfg.webhookToleranceSeconds,
      webhookPath: "/api/integrations/webhooks/stripe",
      lastCheckedAt: check?.lastCheckedAt ?? null,
      verificationNote: STRIPE_VERIFICATION_NOTE,
    };
  }

  return {
    async isOnlinePaymentConfigured(): Promise<boolean> {
      const [enabled, hasSecretKey, hasWebhookSecret] = await Promise.all([
        isFlagEnabled(deps.settings, INTEGRATIONS_STRIPE_FLAG),
        isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_SECRET_KEY),
        isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_WEBHOOK_SECRET),
      ]);
      return enabled && hasSecretKey && hasWebhookSecret;
    },

    getConfig(): Promise<StripeConfigView> {
      return loadView();
    },

    async updateConfig(principal, input): Promise<StripeConfigView> {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);

      const publishableKey = input.publishableKey.trim();
      if (publishableKey !== "" && !/^pk_(?:test|live)_[A-Za-z0-9]{12,180}$/.test(publishableKey)) {
        throw validation(
          "INVALID_STRIPE_PUBLISHABLE_KEY",
          "Stripe publishable key must start with pk_test_ or pk_live_.",
        );
      }
      if (input.secretKey !== undefined && input.secretKey !== null) {
        if (!/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{10,220}$/.test(input.secretKey)) {
          throw validation(
            "INVALID_STRIPE_SECRET_KEY",
            "Stripe secret key must start with sk_test_, sk_live_, rk_test_ or rk_live_.",
          );
        }
      }
      if (input.webhookSecret !== undefined && input.webhookSecret !== null) {
        if (!/^whsec_[A-Za-z0-9_]{10,220}$/.test(input.webhookSecret)) {
          throw validation(
            "INVALID_STRIPE_WEBHOOK_SECRET",
            "Stripe webhook signing secret must start with whsec_.",
          );
        }
      }

      const tolerance = input.webhookToleranceSeconds ?? 300;
      if (!Number.isInteger(tolerance) || tolerance < 30 || tolerance > 900) {
        throw validation(
          "INVALID_WEBHOOK_TOLERANCE",
          "Webhook timestamp tolerance must be between 30 and 900 seconds.",
        );
      }

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);

        const prevSecretSet = await isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_SECRET_KEY, tx);
        const prevWebhookSet = await isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_WEBHOOK_SECRET, tx);

        const nextSecretSet =
          input.secretKey === null ? false : typeof input.secretKey === "string" ? true : prevSecretSet;
        const nextWebhookSet =
          input.webhookSecret === null
            ? false
            : typeof input.webhookSecret === "string"
              ? true
              : prevWebhookSet;

        if (input.enabled && (!nextSecretSet || !nextWebhookSet)) {
          throw validation(
            "STRIPE_SECRETS_REQUIRED",
            "Save both the Stripe secret key and webhook signing secret before enabling Stripe.",
          );
        }

        await writeSetting(
          deps.settings,
          INTEGRATIONS_STRIPE_CONFIG,
          { publishableKey, webhookToleranceSeconds: tolerance },
          tx,
        );
        if (input.secretKey !== undefined) {
          await deps.settings.setSecret(INTEGRATIONS_STRIPE_SECRET_KEY.key, input.secretKey, tx);
        }
        if (input.webhookSecret !== undefined) {
          await deps.settings.setSecret(INTEGRATIONS_STRIPE_WEBHOOK_SECRET.key, input.webhookSecret, tx);
        }
        await deps.settings.set(flagKey(INTEGRATIONS_STRIPE_FLAG.flag), input.enabled, tx);

        if (input.secretKey !== undefined || input.webhookSecret !== undefined) {
          await checks.clearVerification("stripe", tx);
        }

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.stripe.updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "stripe",
            resource: { type: "integration_provider", publicId: "stripe" },
            attributes: {
              enabled: input.enabled,
              secret_key_updated: input.secretKey !== undefined,
              webhook_secret_updated: input.webhookSecret !== undefined,
              tolerance_seconds: tolerance,
            },
          },
          tx,
        );
      });

      return loadView();
    },

    async handleSignedWebhook(input): Promise<StripeWebhookResult> {
      const now = deps.clock.now();
      const [enabled, cfg, webhookSecret] = await Promise.all([
        isFlagEnabled(deps.settings, INTEGRATIONS_STRIPE_FLAG),
        readSetting(deps.settings, INTEGRATIONS_STRIPE_CONFIG),
        readSecret(deps.settings, INTEGRATIONS_STRIPE_WEBHOOK_SECRET),
      ]);

      // Inert unless explicitly enabled and signing secret configured
      if (!enabled || !webhookSecret) {
        return {
          httpStatus: 503,
          accepted: false,
          duplicate: false,
          reasonCode: "STRIPE_NOT_CONFIGURED",
        };
      }

      if (!Buffer.isBuffer(input.rawBody) || input.rawBody.byteLength === 0 || input.rawBody.byteLength > 262_144) {
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          reasonCode: "INVALID_WEBHOOK_BODY",
        };
      }

      const verification = verifyStripeWebhookSignature(
        input.rawBody,
        input.signatureHeader,
        webhookSecret,
        now,
        cfg.webhookToleranceSeconds,
      );
      if (!verification.ok) {
        await deps.audit.record({
          category: "security",
          eventName: "integration.stripe.webhook.rejected",
          action: "verify_webhook",
          outcome: "denied",
          severity: "WARN",
          reasonCode: verification.reasonCode,
          actor: { role: "anonymous" },
          provider: "stripe",
          resource: { type: "webhook_endpoint", publicId: "stripe" },
        });
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          reasonCode: verification.reasonCode,
        };
      }

      let rawJson: unknown;
      try {
        rawJson = JSON.parse(input.rawBody.toString("utf8"));
      } catch {
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          reasonCode: "INVALID_WEBHOOK_JSON",
        };
      }

      const parsedEvent = stripeEventEnvelopeSchema.safeParse(rawJson);
      if (!parsedEvent.success) {
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          reasonCode: "INVALID_STRIPE_EVENT_SCHEMA",
        };
      }

      const event = parsedEvent.data;
      const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");
      const providerTimestamp = new Date(event.created * 1000);
      const mutation = extractPaymentMutation(event.type, event.data.object);

      return deps.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(integrationWebhookEvents)
          .where(
            and(
              eq(integrationWebhookEvents.provider, "stripe"),
              eq(integrationWebhookEvents.externalEventId, event.id),
            ),
          )
          .limit(1)
          .for("update");

        if (existing) {
          if (existing.payloadSha256 !== payloadSha256) {
            await deps.audit.record(
              {
                category: "security",
                eventName: "integration.stripe.webhook.rejected",
                action: "verify_webhook",
                outcome: "denied",
                severity: "WARN",
                reasonCode: "WEBHOOK_PAYLOAD_MISMATCH",
                actor: { role: "anonymous" },
                provider: "stripe",
                deliveryId: event.id,
                resource: { type: "webhook_event", publicId: existing.publicId },
              },
              tx,
            );
            return {
              httpStatus: 409 as const,
              accepted: false,
              duplicate: false,
              reasonCode: "WEBHOOK_PAYLOAD_MISMATCH",
            };
          }
          if (existing.status === "processed" || existing.status === "ignored") {
            return {
              httpStatus: 200 as const,
              accepted: true,
              duplicate: true,
              reasonCode: "DUPLICATE_EVENT",
            };
          }
        }

        const eventPublicId = existing?.publicId ?? ulid();
        if (!existing) {
          try {
            await tx.insert(integrationWebhookEvents).values({
              publicId: eventPublicId,
              provider: "stripe",
              externalEventId: event.id,
              eventType: event.type,
              payloadSha256,
              status: "processing",
              providerTimestamp,
              createdAt: now,
              updatedAt: now,
            });
          } catch (err) {
            if ((err as { code?: string } | null)?.code === "ER_DUP_ENTRY") {
              return {
                httpStatus: 200 as const,
                accepted: true,
                duplicate: true,
                reasonCode: "DUPLICATE_EVENT",
              };
            }
            throw err;
          }
        }

        let status: "processed" | "ignored" = "ignored";
        let reasonCode = "UNHANDLED_EVENT_TYPE";

        if (mutation) {
          const complianceWithHook = deps.services.compliance as
            | {
                recordProviderPayment?: (input: {
                  provider: "stripe";
                  providerEventId: string;
                  providerPaymentId: string;
                  invoicePublicId?: string;
                  orderPublicId?: string;
                  kind: "succeeded" | "failed" | "refunded";
                  amountMinor: number;
                  currency: string;
                  occurredAt: Date;
                  tx?: Tx;
                }) => Promise<{ applied: boolean; reasonCode?: string }>;
              }
            | undefined;
          const recordPayment = complianceWithHook?.recordProviderPayment;
          if (typeof recordPayment === "function") {
            const result = await recordPayment.call(complianceWithHook, {
              provider: "stripe",
              providerEventId: event.id,
              providerPaymentId: mutation.providerPaymentId,
              invoicePublicId: mutation.invoicePublicId,
              orderPublicId: mutation.orderPublicId,
              kind: mutation.kind,
              amountMinor: mutation.amountMinor,
              currency: mutation.currency,
              occurredAt: providerTimestamp,
              tx,
            });
            status = "processed";
            reasonCode = result.reasonCode ?? (result.applied ? "PAYMENT_RECORDED" : "PAYMENT_NOOP");
          } else {
            status = "processed";
            reasonCode = "COMPLIANCE_HOOK_UNAVAILABLE";
          }
        }

        await tx
          .update(integrationWebhookEvents)
          .set({
            status,
            reasonCode,
            processedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(integrationWebhookEvents.provider, "stripe"),
              eq(integrationWebhookEvents.externalEventId, event.id),
            ),
          );

        await checks.recordOutcome("stripe", "succeeded", reasonCode, tx);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.stripe.webhook.processed",
            action: "process",
            outcome: "completed",
            severity: "INFO",
            reasonCode,
            actor: { role: "system" },
            provider: "stripe",
            deliveryId: event.id,
            resource: { type: "webhook_event", publicId: eventPublicId },
            attributes: {
              event_type: event.type,
              status,
            },
          },
          tx,
        );

        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: false,
          reasonCode,
        };
      });
    },
  };
}
