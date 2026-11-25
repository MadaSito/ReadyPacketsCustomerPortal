/**
 * Inert Signature-Verified Stripe Diagnostic Webhook (`services.integrations.stripe`).
 *
 * Security invariants:
 *  - Live Stripe Checkout and signed payment webhooks live in the `payments` module (`/admin/payments/setup`
 *    and `POST /api/payments/webhooks/stripe`).
 *  - This integrations receiver (`/api/integrations/webhooks/stripe`) is strictly an inert diagnostic
 *    signature-verification endpoint (`STRIPE_LEDGER_MUTATION_ENABLED === false`): `isOnlinePaymentConfigured()`
 *    on this diagnostic adapter always returns `false`, `updateConfig({ enabled: true, ... })` directs callers
 *    to Payment Setup (`STRIPE_MANAGED_IN_PAYMENTS`), and no event on `/api/integrations/webhooks/stripe`
 *    can ever book, complete, or refund a payment in the compliance ledger.
 *  - Keys (`secretKey`, `webhookSecret`) are stored exclusively via `defineSecret` (`FieldCrypto`
 *    AES-256-GCM at rest, non-exportable) and are write-only in administrative APIs.
 *  - `/api/integrations/webhooks/stripe` remains inert (`503`) when no diagnostic signing secret is configured;
 *    when a signing secret is configured for integration testing, it verifies `Stripe-Signature`
 *    (`t=...,v1=...` HMAC-SHA256 + replay window) over the raw `Buffer`, durably records the received
 *    event row (`status: "ignored"`) + audit note, and acknowledges with zero ledger effect.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../platform/index.js";
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

/** Compile-time constant: the legacy integrations diagnostic receiver never mutates the compliance ledger. */
export const STRIPE_LEDGER_MUTATION_ENABLED = false as const;

export const STRIPE_PAYMENTS_SETUP_NOTICE =
  "Live Stripe Checkout and webhook processing are configured in Payment Setup (/admin/payments/setup); /api/integrations/webhooks/stripe is an inert signature-verification diagnostic receiver.";

const STRIPE_VERIFICATION_NOTE =
  "Inert signature-verification diagnostic receiver (/api/integrations/webhooks/stripe); never mutates the compliance ledger. Configure live Stripe Checkout and webhooks in Payment Setup (/admin/payments/setup).";

export interface StripeConfigView {
  enabled: false;
  configured: boolean;
  verified: boolean;
  state: ProviderState;
  summary: string;
  publishableKey: string;
  secretKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  webhookToleranceSeconds: number;
  webhookPath: "/api/integrations/webhooks/stripe";
  paymentsSetupPath: "/admin/payments/setup";
  lastCheckedAt: Date | null;
  verificationNote: string;
}

export interface UpdateStripeConfigInput {
  /** Must not be `true`; live Stripe activation lives in Payment Setup (`NOT_CONFIGURED / STRIPE_MANAGED_IN_PAYMENTS`). */
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
  ledgerMutated: false;
  reasonCode: string;
}

export interface StripeService {
  isOnlinePaymentConfigured(): Promise<boolean>;
  getConfig(): Promise<StripeConfigView>;
  updateConfig(principal: SessionPrincipal, input: UpdateStripeConfigInput): Promise<StripeConfigView>;
  handleSignedWebhook(input: { rawBody: Buffer; signatureHeader: string | undefined }): Promise<StripeWebhookResult>;
}

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
    return { ok: false, reasonCode: "MISSING_OR_OVERSIZED_SIGNATURE" };
  }

  let timestampRaw: string | null = null;
  const v1HexCandidates: string[] = [];

  for (const part of signatureHeader.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === "t" && timestampRaw === null) {
      timestampRaw = val;
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(val)) {
      v1HexCandidates.push(val.toLowerCase());
    }
  }

  if (!timestampRaw || !/^\d{9,12}$/.test(timestampRaw) || v1HexCandidates.length === 0) {
    return { ok: false, reasonCode: "MALFORMED_SIGNATURE_HEADER" };
  }

  const timestampSeconds = Number.parseInt(timestampRaw, 10);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    return { ok: false, reasonCode: "INVALID_SIGNATURE_TIMESTAMP" };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const skewSeconds = Math.abs(nowSeconds - timestampSeconds);
  if (skewSeconds > toleranceSeconds) {
    return { ok: false, reasonCode: "STALE_WEBHOOK_TIMESTAMP" };
  }

  const expectedMac = createHmac("sha256", webhookSecret)
    .update(`${timestampSeconds}.`, "utf8")
    .update(rawBody)
    .digest();

  let matched = false;
  for (const candidateHex of v1HexCandidates.slice(0, 8)) {
    const candidateBuf = Buffer.from(candidateHex, "hex");
    if (candidateBuf.byteLength === expectedMac.byteLength && timingSafeEqual(candidateBuf, expectedMac)) {
      matched = true;
    }
  }

  if (!matched) {
    return { ok: false, reasonCode: "INVALID_SIGNATURE" };
  }

  return { ok: true, timestampSeconds };
}

export function createStripeService(deps: ModuleDeps, checks: ProviderChecksStore): StripeService {
  async function loadView(): Promise<StripeConfigView> {
    const [cfg, hasSecretKey, hasWebhookSecret, check] = await Promise.all([
      readSetting(deps.settings, INTEGRATIONS_STRIPE_CONFIG),
      isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_SECRET_KEY),
      isSecretConfigured(deps.settings, INTEGRATIONS_STRIPE_WEBHOOK_SECRET),
      checks.get("stripe"),
    ]);

    const configured = hasSecretKey && hasWebhookSecret;
    const verified = Boolean(check?.verifiedAt && check.lastOutcome === "succeeded");

    return {
      enabled: false,
      configured,
      verified,
      state: "disabled",
      summary: STRIPE_PAYMENTS_SETUP_NOTICE,
      publishableKey: cfg.publishableKey,
      secretKeyConfigured: hasSecretKey,
      webhookSecretConfigured: hasWebhookSecret,
      webhookToleranceSeconds: cfg.webhookToleranceSeconds,
      webhookPath: "/api/integrations/webhooks/stripe",
      paymentsSetupPath: "/admin/payments/setup",
      lastCheckedAt: check?.lastCheckedAt ?? null,
      verificationNote: STRIPE_VERIFICATION_NOTE,
    };
  }

  return {
    async isOnlinePaymentConfigured(): Promise<boolean> {
      // Diagnostic integrations receiver never books payments; live Stripe Checkout lives in `payments`.
      return STRIPE_LEDGER_MUTATION_ENABLED;
    },

    getConfig(): Promise<StripeConfigView> {
      return loadView();
    },

    async updateConfig(principal, input): Promise<StripeConfigView> {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);

      if (input.enabled) {
        throw new DomainError(
          "NOT_CONFIGURED",
          "STRIPE_MANAGED_IN_PAYMENTS",
          STRIPE_PAYMENTS_SETUP_NOTICE,
        );
      }

      const publishableKey = input.publishableKey.trim();
      if (publishableKey !== "" && !/^pk_(?:test|live)_[A-Za-z0-9]{10,200}$/.test(publishableKey)) {
        throw validation(
          "INVALID_STRIPE_PUBLISHABLE_KEY",
          "Publishable key must start with pk_test_ or pk_live_.",
        );
      }

      if (
        typeof input.secretKey === "string" &&
        !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{10,220}$/.test(input.secretKey.trim())
      ) {
        throw validation(
          "INVALID_STRIPE_SECRET_KEY",
          "Stripe secret key must start with sk_test_, sk_live_, rk_test_, or rk_live_.",
        );
      }

      if (
        typeof input.webhookSecret === "string" &&
        !/^whsec_[A-Za-z0-9_]{10,220}$/.test(input.webhookSecret.trim())
      ) {
        throw validation(
          "INVALID_STRIPE_WEBHOOK_SECRET",
          "Stripe webhook signing secret must start with whsec_.",
        );
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

        await writeSetting(
          deps.settings,
          INTEGRATIONS_STRIPE_CONFIG,
          { publishableKey, webhookToleranceSeconds: tolerance },
          tx,
        );
        if (input.secretKey !== undefined) {
          await deps.settings.setSecret(
            INTEGRATIONS_STRIPE_SECRET_KEY.key,
            input.secretKey === null ? null : input.secretKey.trim(),
            tx,
          );
        }
        if (input.webhookSecret !== undefined) {
          await deps.settings.setSecret(
            INTEGRATIONS_STRIPE_WEBHOOK_SECRET.key,
            input.webhookSecret === null ? null : input.webhookSecret.trim(),
            tx,
          );
          await checks.clearVerification("stripe", tx);
        }
        // Always force the runtime flag off so no setting export/import can ever mark Stripe active.
        await deps.settings.set(flagKey(INTEGRATIONS_STRIPE_FLAG.flag), false, tx);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.stripe.diagnostic_updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "stripe",
            resource: { type: "integration_provider", publicId: "stripe" },
            attributes: {
              enabled: false,
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
      const [cfg, webhookSecret] = await Promise.all([
        readSetting(deps.settings, INTEGRATIONS_STRIPE_CONFIG),
        readSecret(deps.settings, INTEGRATIONS_STRIPE_WEBHOOK_SECRET),
      ]);

      // Inert (`503`) unless an administrator stored a signing secret for webhook verification testing.
      if (!webhookSecret) {
        return {
          httpStatus: 503,
          accepted: false,
          duplicate: false,
          ledgerMutated: false,
          reasonCode: "STRIPE_NOT_CONFIGURED",
        };
      }

      if (!Buffer.isBuffer(input.rawBody) || input.rawBody.byteLength === 0 || input.rawBody.byteLength > 262_144) {
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          ledgerMutated: false,
          reasonCode: "INVALID_WEBHOOK_BODY",
        };
      }

      const sigVerdict = verifyStripeWebhookSignature(
        input.rawBody,
        input.signatureHeader,
        webhookSecret,
        now,
        cfg.webhookToleranceSeconds,
      );
      if (!sigVerdict.ok) {
        await checks.recordOutcome("stripe", "failed", sigVerdict.reasonCode);
        deps.audit.note({
          category: "integration",
          eventName: "integration.stripe.webhook_rejected",
          action: "verify",
          outcome: "denied",
          severity: "WARN",
          reasonCode: sigVerdict.reasonCode,
          provider: "stripe",
          actor: { role: "system" },
          resource: { type: "integration_webhook" },
        });
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          ledgerMutated: false,
          reasonCode: sigVerdict.reasonCode,
        };
      }

      let rawJson: unknown;
      try {
        rawJson = JSON.parse(input.rawBody.toString("utf8"));
      } catch {
        await checks.recordOutcome("stripe", "failed", "MALFORMED_WEBHOOK_JSON");
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          ledgerMutated: false,
          reasonCode: "MALFORMED_WEBHOOK_JSON",
        };
      }

      const parsedEnvelope = stripeEventEnvelopeSchema.safeParse(rawJson);
      if (!parsedEnvelope.success) {
        await checks.recordOutcome("stripe", "failed", "INVALID_WEBHOOK_ENVELOPE");
        return {
          httpStatus: 400,
          accepted: false,
          duplicate: false,
          ledgerMutated: false,
          reasonCode: "INVALID_WEBHOOK_ENVELOPE",
        };
      }

      const event = parsedEnvelope.data;
      const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");
      const providerTimestamp = new Date(event.created * 1000);
      const eventPublicId = ulid();

      // Durable idempotency + audit only — ZERO compliance ledger mutations (`STRIPE_LEDGER_MUTATION_ENABLED === false`).
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
            deps.audit.note({
              category: "security",
              eventName: "integration.stripe.webhook_payload_mismatch",
              action: "verify",
              outcome: "denied",
              severity: "ERROR",
              reasonCode: "EVENT_PAYLOAD_MISMATCH",
              provider: "stripe",
              actor: { role: "system" },
              resource: { type: "integration_webhook", publicId: existing.publicId },
            });
            return {
              httpStatus: 409 as const,
              accepted: false,
              duplicate: false,
              ledgerMutated: false as const,
              reasonCode: "EVENT_PAYLOAD_MISMATCH",
            };
          }
          return {
            httpStatus: 200 as const,
            accepted: true,
            duplicate: true,
            ledgerMutated: false as const,
            reasonCode: "DUPLICATE_EVENT",
          };
        }

        try {
          await tx.insert(integrationWebhookEvents).values({
            publicId: eventPublicId,
            provider: "stripe",
            externalEventId: event.id,
            eventType: event.type,
            payloadSha256,
            status: "ignored",
            reasonCode: "STRIPE_INERT_DIAGNOSTIC_RECEIVER",
            providerTimestamp,
            processedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        } catch (err) {
          if ((err as { code?: string } | null)?.code === "ER_DUP_ENTRY") {
            return {
              httpStatus: 200 as const,
              accepted: true,
              duplicate: true,
              ledgerMutated: false as const,
              reasonCode: "DUPLICATE_EVENT",
            };
          }
          throw err;
        }

        await checks.recordOutcome("stripe", "succeeded", "STRIPE_INERT_DIAGNOSTIC_RECEIVER", tx);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.stripe.webhook_received_inert",
            action: "receive",
            outcome: "completed",
            severity: "INFO",
            reasonCode: "STRIPE_INERT_DIAGNOSTIC_RECEIVER",
            provider: "stripe",
            actor: { role: "system" },
            resource: { type: "integration_webhook", publicId: eventPublicId },
            attributes: {
              event_type: event.type,
              ledger_mutated: false,
            },
          },
          tx,
        );
        deps.audit.note({
          category: "integration",
          eventName: "integration.stripe.webhook_acknowledged_no_ledger_effect",
          action: "receive",
          outcome: "completed",
          severity: "INFO",
          reasonCode: "STRIPE_INERT_DIAGNOSTIC_RECEIVER",
          provider: "stripe",
          actor: { role: "system" },
          resource: { type: "integration_webhook", publicId: eventPublicId },
        });

        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: false,
          ledgerMutated: false as const,
          reasonCode: "STRIPE_INERT_DIAGNOSTIC_RECEIVER",
        };
      });
    },
  };
}
