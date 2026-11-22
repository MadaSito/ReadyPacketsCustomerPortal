/**
 * Payments module — Core domain service (Increment 04, Package K).
 * Owner: compliance_engineer.
 *
 * Enforces ADR 0035 & Contract Decision 12:
 *  - Off by default (`provider = "none"` -> `{ mode: "invoice" }`, zero network activity).
 *  - Hosted Stripe Checkout & Square Payment Links over `integrations.egress.fetchPinned`.
 *  - Attempt state machine (`created -> redirected -> paid | failed | expired | cancelled`) guarded by CAS `version`.
 *  - Double-verification invariant: an invoice is booked as paid ONLY when BOTH:
 *      (a) a valid signed, fresh (`<= 300s`), deduplicated webhook is recorded (`verifiedWebhookEventId`), AND
 *      (b) `adapter.fetchPayment` matches `provider`, `mode`/`livemode`, `providerRef`, `amountMinor`, `currency`,
 *          and `invoicePublicId` / `attemptPublicId`.
 *  - Inert return route (`GET /api/payments/return/...`) performs zero DB reads/writes and redirects only to
 *    hardcoded reviewed same-origin paths.
 */
import { createHash } from "node:crypto";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { assertLiveActorInTx, runComplianceTx } from "../compliance/actorAuth.js";
import { decodeIdCursor, encodeIdCursor } from "../compliance/domain.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../platform/index.js";
import { createSquareProviderAdapter } from "./providers/square.js";
import { createStripeProviderAdapter } from "./providers/stripe.js";
import type { PaymentProviderAdapter, ProviderCredentials, ProviderFetchedPayment } from "./providers/types.js";
import {
  type ActivePaymentProvider,
  paymentAttempts,
  type PaymentAttemptRow,
  type PaymentAttemptStatus,
  type PaymentEnvironmentMode,
  type PaymentProviderChoice,
  paymentWebhookEvents,
  type PaymentWebhookEventRow,
  type PaymentWebhookStatus,
} from "./schema.js";
import {
  isSafePortalReturnPath,
  maskLast4,
  PAYMENTS_CONFIG_SETTING,
  type PaymentsConfigValue,
  PAYMENTS_SQUARE_ACCESS_TOKEN,
  PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY,
  PAYMENTS_STRIPE_SECRET_KEY,
  PAYMENTS_STRIPE_WEBHOOK_SECRET,
} from "./settings.js";

export interface CheckoutReturnPaths {
  successPath?: string | undefined;
  cancelPath?: string | undefined;
}

export interface StartCheckoutOptions {
  principal?: SessionPrincipal | undefined;
  cartPublicId?: string | undefined;
  idempotencyKey?: string | undefined;
}

export type StartCheckoutResult =
  | {
      mode: "invoice";
      invoicePublicId: string;
    }
  | {
      mode: "redirect";
      attemptPublicId: string;
      invoicePublicId: string;
      provider: ActivePaymentProvider;
      environment: PaymentEnvironmentMode;
      redirectUrl: string;
      expiresAt: Date | null;
    };

export interface PaymentsPublicConfigView {
  provider: PaymentProviderChoice;
  mode: PaymentEnvironmentMode;
  currency: string;
  onlineEnabled: boolean;
}

export interface CheckoutStatusView {
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  amountMinor: number;
  balanceDueMinor: number;
  currency: string;
  providerConfigured: PaymentProviderChoice;
  environment: PaymentEnvironmentMode;
  attempt: {
    attemptPublicId: string;
    provider: ActivePaymentProvider;
    environment: PaymentEnvironmentMode;
    status: PaymentAttemptStatus;
    cartPublicId: string | null;
    amountMinor: number;
    currency: string;
    createdAt: Date;
    redirectedAt: Date | null;
    paidAt: Date | null;
    expiresAt: Date | null;
    failureReasonCode: string | null;
  } | null;
}

export interface CancelAttemptResult {
  cancelled: boolean;
  attemptPublicId: string | null;
  status: PaymentAttemptStatus | null;
}

export interface PaymentWebhookResult {
  httpStatus: 200 | 400 | 409 | 503;
  accepted: boolean;
  duplicate: boolean;
  booked: boolean;
  reasonCode: string;
}

export interface ReconcilePaymentsResult {
  scanned: number;
  booked: number;
  expired: number;
  failed: number;
  stillPending: number;
}

export interface PaymentsAdminSettingsView
  extends Pick<
    PaymentsConfigValue,
    "provider" | "mode" | "currency" | "successPath" | "cancelPath" | "webhookToleranceSeconds"
  > {
  onlineEnabled: boolean;
  stripe: {
    secretKeyConfigured: boolean;
    secretKeyLast4: string | null;
    webhookSecretConfigured: boolean;
    webhookSecretLast4: string | null;
    webhookUrl: string;
    returnUrlPattern: string;
    egressHost: "api.stripe.com";
    egressAllowlisted: boolean;
  };
  square: {
    locationId: string | null;
    accessTokenConfigured: boolean;
    accessTokenLast4: string | null;
    webhookSignatureKeyConfigured: boolean;
    webhookSignatureKeyLast4: string | null;
    webhookUrl: string;
    returnUrlPattern: string;
    egressHost: "connect.squareup.com" | "connect.squareupsandbox.com";
    egressAllowlisted: boolean;
  };
}

export interface UpdatePaymentsSettingsInput {
  provider: PaymentProviderChoice;
  mode: PaymentEnvironmentMode;
  currency: string;
  successPath?: string | undefined;
  cancelPath?: string | undefined;
  webhookToleranceSeconds?: number | undefined;
  stripeSecretKey?: string | undefined;
  clearStripeSecretKey?: boolean | undefined;
  stripeWebhookSecret?: string | undefined;
  clearStripeWebhookSecret?: boolean | undefined;
  squareLocationId?: string | null | undefined;
  squareAccessToken?: string | undefined;
  clearSquareAccessToken?: boolean | undefined;
  squareWebhookSignatureKey?: string | undefined;
  clearSquareWebhookSignatureKey?: boolean | undefined;
}

export interface AdminPaymentAttemptSummary {
  publicId: string;
  attemptPublicId: string;
  invoicePublicId: string;
  orderPublicId: string;
  cartPublicId: string | null;
  provider: ActivePaymentProvider;
  environment: PaymentEnvironmentMode;
  status: PaymentAttemptStatus;
  amountMinor: number;
  currency: string;
  providerRef: string | null;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  verifiedWebhookEventId: string | null;
  compliancePaymentPublicId: string | null;
  reconciliationNote: string | null;
  failureReasonCode: string | null;
  redirectedAt: Date | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  lastReconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminPaymentWebhookSummary {
  publicId: string;
  webhookPublicId: string;
  provider: ActivePaymentProvider;
  environment: PaymentEnvironmentMode;
  externalEventId: string;
  eventType: string;
  attemptPublicId: string | null;
  providerRef: string | null;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  status: PaymentWebhookStatus;
  reasonCode: string | null;
  occurredAt: Date;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface AdminPaymentAttemptDetail {
  attempt: AdminPaymentAttemptSummary;
  webhooks: AdminPaymentWebhookSummary[];
}

export interface PaymentsServiceOptions {
  stripeAdapter?: PaymentProviderAdapter;
  squareAdapter?: PaymentProviderAdapter;
}

const DEFAULT_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;

function toAdminAttemptSummary(row: PaymentAttemptRow): AdminPaymentAttemptSummary {
  return {
    publicId: row.publicId,
    attemptPublicId: row.publicId,
    invoicePublicId: row.invoicePublicId,
    orderPublicId: row.orderPublicId,
    cartPublicId: row.cartPublicId,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerRef: row.providerRef,
    providerOrderRef: row.providerOrderRef,
    providerPaymentRef: row.providerPaymentRef,
    verifiedWebhookEventId: row.verifiedWebhookEventId,
    compliancePaymentPublicId: row.compliancePaymentPublicId,
    reconciliationNote: row.reconciliationNote,
    failureReasonCode: row.failureReasonCode,
    redirectedAt: row.redirectedAt,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    cancelledAt: row.cancelledAt,
    lastReconciledAt: row.lastReconciledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAdminWebhookSummary(row: PaymentWebhookEventRow): AdminPaymentWebhookSummary {
  return {
    publicId: row.publicId,
    webhookPublicId: row.publicId,
    provider: row.provider,
    environment: row.environment,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    attemptPublicId: row.attemptPublicId,
    providerRef: row.providerRef,
    providerOrderRef: row.providerOrderRef,
    providerPaymentRef: row.providerPaymentRef,
    status: row.status,
    reasonCode: row.reasonCode,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

export function createPaymentsService(deps: ModuleDeps, options?: PaymentsServiceOptions) {
  const adapters: Record<ActivePaymentProvider, PaymentProviderAdapter> = {
    stripe: options?.stripeAdapter ?? createStripeProviderAdapter(deps),
    square: options?.squareAdapter ?? createSquareProviderAdapter(deps),
  };

  function requireComplianceService() {
    const complianceSvc = (deps.services as Partial<typeof deps.services>).compliance;
    if (!complianceSvc) {
      throw new DomainError("UNAVAILABLE", "COMPLIANCE_UNAVAILABLE", "Invoice service is temporarily unavailable.");
    }
    return complianceSvc;
  }

  async function assertAdminPaymentsRead(principal: SessionPrincipal): Promise<void> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "REMEDIATION_SESSION",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "payments_settings" },
      });
      throw forbidden("REMEDIATION_SESSION");
    }
    if (!roleHasCapability(principal.role, "payments.manage")) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "CAPABILITY_NOT_GRANTED",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "payments_settings" },
      });
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
  }

  async function loadConfig(tx?: Tx): Promise<PaymentsConfigValue> {
    return readSetting(deps.settings, PAYMENTS_CONFIG_SETTING, tx);
  }

  async function isProviderCredentialsReady(
    config: PaymentsConfigValue,
    tx?: Tx,
  ): Promise<boolean> {
    if (config.provider === "none") return false;
    if (config.provider === "stripe") {
      const [hasKey, hasWh] = await Promise.all([
        isSecretConfigured(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
        isSecretConfigured(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      ]);
      return hasKey && hasWh;
    }
    const [hasToken, hasSig] = await Promise.all([
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);
    return Boolean(config.squareLocationId && hasToken && hasSig);
  }

  async function isOnlineCheckoutEnabled(tx?: DbOrTx): Promise<boolean> {
    const config = await loadConfig(tx as Tx | undefined);
    return isProviderCredentialsReady(config, tx as Tx | undefined);
  }

  async function getPublicCheckoutConfig(tx?: DbOrTx): Promise<PaymentsPublicConfigView> {
    const config = await loadConfig(tx as Tx | undefined);
    const onlineEnabled = await isProviderCredentialsReady(config, tx as Tx | undefined);
    return {
      provider: onlineEnabled ? config.provider : "none",
      mode: config.mode,
      currency: config.currency,
      onlineEnabled,
    };
  }

  async function loadProviderCredentials(
    provider: ActivePaymentProvider,
    config: PaymentsConfigValue,
    tx?: Tx,
  ): Promise<{ credentials: ProviderCredentials; webhookSecret: string }> {
    if (provider === "stripe") {
      const [secretKey, webhookSecret] = await Promise.all([
        readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
        readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      ]);
      if (!secretKey || !webhookSecret) {
        throw new DomainError(
          "UNAVAILABLE",
          "PAYMENT_PROVIDER_NOT_CONFIGURED",
          "Stripe credentials are not configured.",
        );
      }
      return {
        credentials: { mode: config.mode, secretKey },
        webhookSecret,
      };
    }

    const [accessToken, webhookSignatureKey] = await Promise.all([
      readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      readSecret(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);
    if (!accessToken || !webhookSignatureKey || !config.squareLocationId) {
      throw new DomainError(
        "UNAVAILABLE",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Square credentials or location ID are not configured.",
      );
    }
    return {
      credentials: {
        mode: config.mode,
        secretKey: accessToken,
        squareLocationId: config.squareLocationId,
      },
      webhookSecret: webhookSignatureKey,
    };
  }

  function buildCanonicalReturnUrls(
    provider: ActivePaymentProvider,
    attemptPublicId: string,
    successPath: string,
  ): { returnUrl: string; cancelUrl: string } {
    const flow = successPath.startsWith("/checkout") ? "checkout" : "invoices";
    const base = new URL(
      `/api/payments/return/${provider}/${attemptPublicId}`,
      deps.config.canonicalOrigin,
    );
    const returnUrl = new URL(base.href);
    returnUrl.searchParams.set("flow", flow);

    const cancelUrl = new URL(base.href);
    cancelUrl.searchParams.set("flow", flow);
    cancelUrl.searchParams.set("outcome", "cancelled");

    return {
      returnUrl: returnUrl.href,
      cancelUrl: cancelUrl.href,
    };
  }

  async function startCheckout(
    invoicePublicId: string,
    returnPaths?: CheckoutReturnPaths,
    opts?: StartCheckoutOptions,
  ): Promise<StartCheckoutResult> {
    const complianceSvc = requireComplianceService();
    const config = await loadConfig();

    const invoice = await complianceSvc.getInvoiceForCheckout(invoicePublicId, {
      ...(opts?.principal ? { principal: opts.principal } : {}),
    });

    if (opts?.principal && opts.principal.role === "customer" && invoice.ownerUserId !== opts.principal.userId) {
      throw notFound("INVOICE_NOT_FOUND");
    }
    if (invoice.origin !== "portal") {
      throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported historical invoices cannot be paid online.");
    }
    if (invoice.voidedAt !== null || invoice.status === "void") {
      throw conflict("INVOICE_VOIDED", "Voided invoices cannot be paid.");
    }
    if (invoice.issuedAt === null || invoice.status === "draft") {
      throw conflict("INVOICE_NOT_ISSUED", "Draft invoices must be issued before starting checkout.");
    }
    if (invoice.status === "paid" || invoice.balanceDueMinor <= 0) {
      throw conflict("INVOICE_ALREADY_PAID", "This invoice is already paid in full.");
    }

    if (config.provider === "none") {
      return {
        mode: "invoice",
        invoicePublicId: invoice.invoicePublicId,
      };
    }

    const activeProvider: ActivePaymentProvider = config.provider;
    const { credentials } = await loadProviderCredentials(activeProvider, config);

    if (invoice.currency.toUpperCase() !== config.currency.toUpperCase()) {
      throw validation(
        "CURRENCY_MISMATCH",
        `Invoice currency (${invoice.currency}) does not match configured payment currency (${config.currency}).`,
      );
    }

    const successPath = returnPaths?.successPath ?? config.successPath;
    const cancelPath = returnPaths?.cancelPath ?? config.cancelPath;
    if (!isSafePortalReturnPath(successPath) || !isSafePortalReturnPath(cancelPath)) {
      throw validation("INVALID_RETURN_PATH", "Checkout return path must be an allowlisted internal portal path.");
    }

    const now = deps.clock.now();
    const rawIdem = opts?.idempotencyKey?.trim();
    const idempotencyKey =
      rawIdem && rawIdem.length >= 4 && rawIdem.length <= 128
        ? rawIdem
        : `att:${invoice.invoicePublicId}:${activeProvider}:${config.mode}:${invoice.balanceDueMinor}`;

    const preAttempt = await deps.db.transaction(async (tx) => {
      if (opts?.principal) {
        await assertLiveActorInTx(deps, opts.principal, tx);
      }

      const [existing] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.invoiceId, invoice.invoiceId),
            eq(paymentAttempts.idempotencyKey, idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        const stillUnexpired = !existing.expiresAt || existing.expiresAt.getTime() > now.getTime();
        if (
          existing.status === "redirected" &&
          stillUnexpired &&
          existing.provider === activeProvider &&
          existing.environment === config.mode &&
          existing.amountMinor === invoice.balanceDueMinor &&
          existing.redirectUrlEnc
        ) {
          const redirectUrl = deps.crypto.decrypt(
            existing.redirectUrlEnc,
            `payment_attempts.redirect_url:${existing.publicId}`,
          );
          return {
            reused: true as const,
            attemptPublicId: existing.publicId,
            redirectUrl,
            expiresAt: existing.expiresAt,
          };
        }
        if (existing.status === "paid") {
          throw conflict("INVOICE_ALREADY_PAID", "This payment attempt has already been completed.");
        }
      }

      const effectiveIdem = existing ? `${idempotencyKey}:${ulid(now.getTime()).slice(-10)}`.slice(0, 128) : idempotencyKey;
      const attemptPublicId = ulid(now.getTime());
      const [ins] = await tx.insert(paymentAttempts).values({
        publicId: attemptPublicId,
        invoiceId: invoice.invoiceId,
        invoicePublicId: invoice.invoicePublicId,
        orderPublicId: invoice.orderPublicId,
        cartPublicId: opts?.cartPublicId ?? null,
        customerUserId: invoice.ownerUserId,
        provider: activeProvider,
        environment: config.mode,
        status: "created",
        amountMinor: invoice.balanceDueMinor,
        currency: invoice.currency.toUpperCase(),
        idempotencyKey: effectiveIdem,
        successPath,
        cancelPath,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "business",
          eventName: "payments.attempt.created",
          action: "create",
          outcome: "attempted",
          actor: opts?.principal
            ? { userId: opts.principal.userId, role: opts.principal.role }
            : { role: "system" },
          resource: { type: "payment_attempt", publicId: attemptPublicId },
          attributes: {
            invoice_public_id: invoice.invoicePublicId,
            order_public_id: invoice.orderPublicId,
            provider: activeProvider,
            environment: config.mode,
            amount_minor: invoice.balanceDueMinor,
            currency: invoice.currency.toUpperCase(),
          },
        },
        tx,
      );

      return {
        reused: false as const,
        attemptId: ins.insertId,
        attemptPublicId,
      };
    });

    if (preAttempt.reused) {
      return {
        mode: "redirect",
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        provider: activeProvider,
        environment: config.mode,
        redirectUrl: preAttempt.redirectUrl,
        expiresAt: preAttempt.expiresAt,
      };
    }

    const { returnUrl, cancelUrl } = buildCanonicalReturnUrls(
      activeProvider,
      preAttempt.attemptPublicId,
      successPath,
    );
    const adapter = adapters[activeProvider];

    try {
      const createdSession = await adapter.createCheckout({
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        invoiceNumber: invoice.invoiceNumber ?? invoice.invoicePublicId,
        orderPublicId: invoice.orderPublicId,
        orderReference: invoice.orderReference,
        amountMinor: invoice.balanceDueMinor,
        currency: invoice.currency.toUpperCase(),
        idempotencyKey,
        returnUrl,
        cancelUrl,
        credentials,
      });

      const completedAt = deps.clock.now();
      const expiresAt = createdSession.expiresAt ?? new Date(completedAt.getTime() + DEFAULT_ATTEMPT_TTL_MS);
      const redirectUrlEnc = deps.crypto.encrypt(
        createdSession.redirectUrl,
        `payment_attempts.redirect_url:${preAttempt.attemptPublicId}`,
      );

      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: "redirected",
            providerRef: createdSession.providerRef,
            providerOrderRef: createdSession.providerOrderRef ?? null,
            providerPaymentRef: createdSession.providerPaymentRef ?? null,
            redirectUrlEnc,
            redirectedAt: completedAt,
            expiresAt,
            version: 2,
            updatedAt: completedAt,
          })
          .where(and(eq(paymentAttempts.id, preAttempt.attemptId), eq(paymentAttempts.version, 1)));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payments.attempt.redirected",
            action: "transition",
            outcome: "completed",
            actor: opts?.principal
              ? { userId: opts.principal.userId, role: opts.principal.role }
              : { role: "system" },
            resource: { type: "payment_attempt", publicId: preAttempt.attemptPublicId },
            attributes: {
              invoice_public_id: invoice.invoicePublicId,
              order_public_id: invoice.orderPublicId,
              provider: activeProvider,
              environment: config.mode,
              provider_ref: createdSession.providerRef,
              amount_minor: invoice.balanceDueMinor,
              currency: invoice.currency.toUpperCase(),
            },
          },
          tx,
        );
      });

      return {
        mode: "redirect",
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        provider: activeProvider,
        environment: config.mode,
        redirectUrl: createdSession.redirectUrl,
        expiresAt,
      };
    } catch (err) {
      const failedAt = deps.clock.now();
      const reasonCode = err instanceof DomainError ? err.reasonCode : "PROVIDER_CREATE_ERROR";
      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: "failed",
            failureReasonCode: reasonCode.slice(0, 64),
            version: 2,
            updatedAt: failedAt,
          })
          .where(and(eq(paymentAttempts.id, preAttempt.attemptId), eq(paymentAttempts.status, "created")));

        await deps.audit.record(
          {
            category: "integration",
            eventName: "payments.attempt.failed",
            action: "create",
            outcome: "failed",
            severity: "WARN",
            reasonCode,
            actor: { role: "system" },
            resource: { type: "payment_attempt", publicId: preAttempt.attemptPublicId },
            attributes: {
              invoice_public_id: invoice.invoicePublicId,
              provider: activeProvider,
              environment: config.mode,
            },
          },
          tx,
        );
      });
      throw err;
    }
  }

  async function getCheckoutStatus(
    principal: SessionPrincipal,
    query: { invoicePublicId?: string | undefined; attemptPublicId?: string | undefined },
  ): Promise<CheckoutStatusView> {
    if (!query.invoicePublicId && !query.attemptPublicId) {
      throw validation("MISSING_CHECKOUT_QUERY", "Provide either invoicePublicId or attemptPublicId.");
    }

    const complianceSvc = requireComplianceService();
    const config = await loadConfig();
    let attemptRow: PaymentAttemptRow | null = null;

    if (query.attemptPublicId) {
      const [found] = await deps.db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.publicId, query.attemptPublicId))
        .limit(1);
      if (!found) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      attemptRow = found;
      if (query.invoicePublicId && found.invoicePublicId !== query.invoicePublicId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
    }

    const targetInvoicePublicId = query.invoicePublicId ?? attemptRow!.invoicePublicId;
    // Enforces resource-level read authorization (throws NOT_FOUND for other customers; no existence oracle).
    const invoice = await complianceSvc.getInvoiceForCheckout(targetInvoicePublicId, { principal });

    if (!attemptRow) {
      const [latest] = await deps.db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.invoiceId, invoice.invoiceId))
        .orderBy(desc(paymentAttempts.id))
        .limit(1);
      attemptRow = latest ?? null;
    }

    const onlineReady = await isProviderCredentialsReady(config);

    return {
      invoicePublicId: invoice.invoicePublicId,
      invoiceNumber: invoice.invoiceNumber,
      invoiceStatus: invoice.status,
      amountMinor: invoice.totalMinor,
      balanceDueMinor: invoice.balanceDueMinor,
      currency: invoice.currency,
      providerConfigured: onlineReady ? config.provider : "none",
      environment: config.mode,
      attempt: attemptRow
        ? {
            attemptPublicId: attemptRow.publicId,
            provider: attemptRow.provider,
            environment: attemptRow.environment,
            status: attemptRow.status,
            cartPublicId: attemptRow.cartPublicId,
            amountMinor: attemptRow.amountMinor,
            currency: attemptRow.currency,
            createdAt: attemptRow.createdAt,
            redirectedAt: attemptRow.redirectedAt,
            paidAt: attemptRow.paidAt,
            expiresAt: attemptRow.expiresAt,
            failureReasonCode: attemptRow.failureReasonCode,
          }
        : null,
    };
  }

  async function cancelAttemptIfUnpaid(
    principal: SessionPrincipal,
    target: { invoicePublicId?: string | undefined; attemptPublicId?: string | undefined },
    callerTx?: Tx,
  ): Promise<CancelAttemptResult> {
    if (!target.invoicePublicId && !target.attemptPublicId) {
      throw validation("MISSING_CANCEL_TARGET", "Provide either invoicePublicId or attemptPublicId.");
    }

    const run = async (tx: Tx): Promise<CancelAttemptResult> => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx);
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
      const complianceSvc = requireComplianceService();

      let attemptRow: PaymentAttemptRow | undefined;
      if (target.attemptPublicId) {
        const [found] = await tx
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.publicId, target.attemptPublicId))
          .for("update")
          .limit(1);
        if (!found) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
        attemptRow = found;
      } else if (target.invoicePublicId) {
        const [found] = await tx
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.invoicePublicId, target.invoicePublicId))
          .orderBy(desc(paymentAttempts.id))
          .for("update")
          .limit(1);
        attemptRow = found;
      }

      const invoiceIdToCheck = target.invoicePublicId ?? attemptRow?.invoicePublicId;
      if (!invoiceIdToCheck) {
        return { cancelled: false, attemptPublicId: null, status: null };
      }

      const invoice = await complianceSvc.getInvoiceForCheckout(invoiceIdToCheck, {
        principal: livePrincipal,
        tx,
      });
      if (livePrincipal.role === "customer" && invoice.ownerUserId !== liveActor.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }

      if (!attemptRow) {
        return { cancelled: false, attemptPublicId: null, status: null };
      }
      if (attemptRow.status === "paid" || invoice.status === "paid") {
        return { cancelled: false, attemptPublicId: attemptRow.publicId, status: "paid" };
      }
      if (attemptRow.status === "cancelled") {
        return { cancelled: true, attemptPublicId: attemptRow.publicId, status: "cancelled" };
      }
      if (attemptRow.status !== "created" && attemptRow.status !== "redirected") {
        return { cancelled: false, attemptPublicId: attemptRow.publicId, status: attemptRow.status };
      }

      const now = deps.clock.now();
      await tx
        .update(paymentAttempts)
        .set({
          status: "cancelled",
          cancelledAt: now,
          version: attemptRow.version + 1,
          updatedAt: now,
        })
        .where(and(eq(paymentAttempts.id, attemptRow.id), eq(paymentAttempts.version, attemptRow.version)));

      await deps.audit.record(
        {
          category: "business",
          eventName: "payments.attempt.cancelled",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payment_attempt", publicId: attemptRow.publicId },
          attributes: {
            invoice_public_id: attemptRow.invoicePublicId,
            provider: attemptRow.provider,
            environment: attemptRow.environment,
          },
        },
        tx,
      );

      return {
        cancelled: true,
        attemptPublicId: attemptRow.publicId,
        status: "cancelled",
      };
    };

    if (callerTx) return run(callerTx);
    return runComplianceTx(deps, principal, { type: "payment_attempt" }, run);
  }

  function checkFetchedMatchesAttempt(
    attempt: PaymentAttemptRow,
    fetched: ProviderFetchedPayment,
  ): { matches: true } | { matches: false; reasonCode: string } {
    const expectedLive = attempt.environment === "live";
    if (fetched.livemode !== expectedLive) {
      return { matches: false, reasonCode: "MODE_MISMATCH" };
    }
    if (attempt.providerRef && fetched.providerRef && fetched.providerRef !== attempt.providerRef) {
      return { matches: false, reasonCode: "PROVIDER_REF_MISMATCH" };
    }
    if (fetched.amountMinor !== attempt.amountMinor) {
      return { matches: false, reasonCode: "AMOUNT_MISMATCH" };
    }
    if (fetched.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
      return { matches: false, reasonCode: "CURRENCY_MISMATCH" };
    }
    if (fetched.invoicePublicId !== attempt.invoicePublicId) {
      return { matches: false, reasonCode: "INVOICE_METADATA_MISMATCH" };
    }
    if (fetched.attemptPublicId !== attempt.publicId) {
      return { matches: false, reasonCode: "ATTEMPT_METADATA_MISMATCH" };
    }
    return { matches: true };
  }

  /**
   * Decision 12 booking critical section:
   * Marks attempt `paid` and books `compliance.bookVerifiedProviderPayment` ONLY when the locked attempt
   * row carries a non-null `verifiedWebhookEventId`, a matching locked `payment_webhook_events` receipt row
   * exists, AND `fetched` passed `checkFetchedMatchesAttempt`.
   */
  async function finalizeVerifiedPaidAttemptInTx(
    tx: Tx,
    input: {
      attemptId: number;
      webhookRowId: number;
      fetched: ProviderFetchedPayment;
    },
  ): Promise<{ booked: boolean; reasonCode: string }> {
    const complianceSvc = requireComplianceService();
    const now = deps.clock.now();

    const [locked] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, input.attemptId))
      .for("update")
      .limit(1);

    if (!locked) {
      return { booked: false, reasonCode: "ATTEMPT_NOT_FOUND" };
    }
    // Enforce Decision 12 invariant at the storage boundary: NEVER book without a verified webhook receipt!
    if (!locked.verifiedWebhookEventId) {
      return { booked: false, reasonCode: "WEBHOOK_VERIFICATION_REQUIRED" };
    }

    const [whRow] = await tx
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.id, input.webhookRowId))
      .for("update")
      .limit(1);

    if (
      !whRow ||
      whRow.attemptId !== locked.id ||
      whRow.provider !== locked.provider ||
      whRow.environment !== locked.environment ||
      whRow.externalEventId !== locked.verifiedWebhookEventId ||
      (whRow.providerPaymentRef &&
        input.fetched.providerPaymentRef &&
        whRow.providerPaymentRef !== input.fetched.providerPaymentRef)
    ) {
      return { booked: false, reasonCode: "WEBHOOK_RECEIPT_MISMATCH" };
    }

    if (locked.status === "paid") {
      await tx
        .update(paymentWebhookEvents)
        .set({ status: "processed", reasonCode: "ALREADY_PAID", processedAt: now })
        .where(eq(paymentWebhookEvents.id, whRow.id));
      return { booked: true, reasonCode: "ALREADY_PAID" };
    }

    const matchCheck = checkFetchedMatchesAttempt(locked, input.fetched);
    if (!matchCheck.matches) {
      await tx
        .update(paymentAttempts)
        .set({
          status: "failed",
          failureReasonCode: matchCheck.reasonCode,
          lastReconciledAt: now,
          version: locked.version + 1,
          updatedAt: now,
        })
        .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

      await tx
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: matchCheck.reasonCode,
          processedAt: now,
        })
        .where(eq(paymentWebhookEvents.id, whRow.id));

      await deps.audit.record(
        {
          category: "security",
          eventName: "payments.verification.mismatch",
          action: "verify",
          outcome: "refused",
          severity: "ERROR",
          reasonCode: matchCheck.reasonCode,
          actor: { role: "system" },
          resource: { type: "payment_attempt", publicId: locked.publicId },
          attributes: {
            invoice_public_id: locked.invoicePublicId,
            provider: locked.provider,
            expected_amount_minor: locked.amountMinor,
            fetched_amount_minor: input.fetched.amountMinor,
            expected_currency: locked.currency,
            fetched_currency: input.fetched.currency,
          },
        },
        tx,
      );
      return { booked: false, reasonCode: matchCheck.reasonCode };
    }

    const paidAt = input.fetched.paidAt ?? now;
    const providerPaymentRef =
      input.fetched.providerPaymentRef ?? input.fetched.providerRef ?? locked.providerRef ?? locked.publicId;

    const booking = await complianceSvc.bookVerifiedProviderPayment(
      {
        invoicePublicId: locked.invoicePublicId,
        provider: locked.provider,
        environment: locked.environment,
        attemptPublicId: locked.publicId,
        providerPaymentRef,
        amountMinor: locked.amountMinor,
        currency: locked.currency,
        paidAt,
        idempotencyKey: `pmt-attempt:${locked.publicId}`,
      },
      tx,
    );

    await tx
      .update(paymentAttempts)
      .set({
        status: "paid",
        providerPaymentRef,
        compliancePaymentPublicId: booking.paymentPublicId,
        reconciliationNote: null,
        failureReasonCode: null,
        paidAt,
        lastReconciledAt: now,
        version: locked.version + 1,
        updatedAt: now,
      })
      .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

    await tx
      .update(paymentWebhookEvents)
      .set({
        status: "processed",
        providerPaymentRef,
        reasonCode: "BOOKED",
        processedAt: now,
      })
      .where(eq(paymentWebhookEvents.id, whRow.id));

    await deps.audit.record(
      {
        category: "business",
        eventName: "payments.attempt.paid",
        action: "transition",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "payment_attempt", publicId: locked.publicId },
        attributes: {
          invoice_public_id: locked.invoicePublicId,
          order_public_id: locked.orderPublicId,
          compliance_payment_public_id: booking.paymentPublicId,
          provider: locked.provider,
          environment: locked.environment,
          amount_minor: locked.amountMinor,
          currency: locked.currency,
          verified_webhook_event_id: locked.verifiedWebhookEventId,
        },
      },
      tx,
    );

    return { booked: true, reasonCode: "BOOKED" };
  }

  async function findAttemptForWebhookInTx(
    tx: Tx,
    provider: ActivePaymentProvider,
    environment: PaymentEnvironmentMode,
    refs: {
      attemptPublicId: string | null;
      providerRef: string | null;
      providerOrderRef: string | null;
    },
  ): Promise<PaymentAttemptRow | null> {
    if (refs.attemptPublicId) {
      const [byAttempt] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.publicId, refs.attemptPublicId),
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
          ),
        )
        .for("update")
        .limit(1);
      if (byAttempt) return byAttempt;
    }
    if (refs.providerRef) {
      const [byRef] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
            eq(paymentAttempts.providerRef, refs.providerRef),
          ),
        )
        .for("update")
        .limit(1);
      if (byRef) return byRef;
    }
    if (refs.providerOrderRef) {
      const [byOrder] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
            eq(paymentAttempts.providerOrderRef, refs.providerOrderRef),
          ),
        )
        .for("update")
        .limit(1);
      if (byOrder) return byOrder;
    }
    return null;
  }

  async function handleSignedWebhook(input: {
    provider: ActivePaymentProvider;
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    notificationUrl: string;
  }): Promise<PaymentWebhookResult> {
    const now = deps.clock.now();
    const config = await loadConfig();

    let credentials: ProviderCredentials;
    let webhookSecret: string;
    try {
      const loaded = await loadProviderCredentials(input.provider, config);
      credentials = loaded.credentials;
      webhookSecret = loaded.webhookSecret;
    } catch {
      await deps.audit.record({
        category: "integration",
        eventName: "payments.webhook.rejected",
        action: "receive",
        outcome: "refused",
        severity: "WARN",
        reasonCode: "WEBHOOK_NOT_CONFIGURED",
        actor: { role: "system" },
        attributes: { provider: input.provider },
      });
      return {
        httpStatus: 503,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: "WEBHOOK_NOT_CONFIGURED",
      };
    }

    const adapter = adapters[input.provider];
    const verified = adapter.verifyWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      webhookSecret,
      notificationUrl: input.notificationUrl,
      now,
      toleranceSeconds: config.webhookToleranceSeconds,
    });

    if (!verified.ok) {
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "WARN",
        reasonCode: verified.reasonCode,
        actor: { role: "system" },
        attributes: { provider: input.provider },
      });
      return {
        httpStatus: 400,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: verified.reasonCode,
      };
    }

    const eventEnv: PaymentEnvironmentMode = verified.livemode ? "live" : "test";
    if (eventEnv !== config.mode) {
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "WEBHOOK_MODE_MISMATCH",
        actor: { role: "system" },
        attributes: {
          provider: input.provider,
          webhook_mode: eventEnv,
          configured_mode: config.mode,
        },
      });
      return {
        httpStatus: 400,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: "WEBHOOK_MODE_MISMATCH",
      };
    }

    const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");

    const staged = await deps.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, input.provider),
            eq(paymentWebhookEvents.externalEventId, verified.externalEventId),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        if (existing.payloadSha256 !== payloadSha256) {
          return { kind: "tamper_conflict" as const };
        }
        if (existing.status !== "retry_pending") {
          return {
            kind: "duplicate_done" as const,
            booked: existing.status === "processed" && existing.reasonCode === "BOOKED",
          };
        }
      }

      const attempt = await findAttemptForWebhookInTx(tx, input.provider, config.mode, {
        attemptPublicId: verified.attemptPublicId,
        providerRef: verified.providerRef,
        providerOrderRef: verified.providerOrderRef,
      });

      const webhookPublicId = existing?.publicId ?? ulid(now.getTime());

      if (!attempt || verified.outcomeHint === "ignored") {
        if (existing) {
          await tx
            .update(paymentWebhookEvents)
            .set({
              status: "ignored",
              reasonCode: attempt ? "UNHANDLED_EVENT_TYPE" : "ATTEMPT_NOT_FOUND",
              processedAt: now,
            })
            .where(eq(paymentWebhookEvents.id, existing.id));
        } else {
          await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: attempt?.id ?? null,
            attemptPublicId: attempt?.publicId ?? verified.attemptPublicId,
            providerRef: verified.providerRef,
            providerOrderRef: verified.providerOrderRef,
            providerPaymentRef: verified.providerPaymentRef,
            status: "ignored",
            reasonCode: attempt ? "UNHANDLED_EVENT_TYPE" : "ATTEMPT_NOT_FOUND",
            occurredAt: verified.occurredAt,
            receivedAt: now,
            processedAt: now,
          });
        }
        return { kind: "ignored" as const };
      }

      if (verified.outcomeHint === "expired" || verified.outcomeHint === "failed") {
        const nextStatus: PaymentAttemptStatus = verified.outcomeHint === "expired" ? "expired" : "failed";
        if (attempt.status === "created" || attempt.status === "redirected") {
          await tx
            .update(paymentAttempts)
            .set({
              status: nextStatus,
              failureReasonCode: verified.eventType.slice(0, 64),
              version: attempt.version + 1,
              updatedAt: now,
            })
            .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));
        }

        if (existing) {
          await tx
            .update(paymentWebhookEvents)
            .set({ status: "processed", reasonCode: nextStatus.toUpperCase(), processedAt: now })
            .where(eq(paymentWebhookEvents.id, existing.id));
        } else {
          await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: attempt.id,
            attemptPublicId: attempt.publicId,
            providerRef: attempt.providerRef ?? verified.providerRef,
            providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
            providerPaymentRef: verified.providerPaymentRef,
            status: "processed",
            reasonCode: nextStatus.toUpperCase(),
            occurredAt: verified.occurredAt,
            receivedAt: now,
            processedAt: now,
          });
        }

        await deps.audit.record(
          {
            category: "business",
            eventName: `payments.attempt.${nextStatus}`,
            action: "transition",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "payment_attempt", publicId: attempt.publicId },
            attributes: {
              invoice_public_id: attempt.invoicePublicId,
              provider: input.provider,
              external_event_id: verified.externalEventId,
            },
          },
          tx,
        );
        return { kind: "terminal_non_paid" as const, status: nextStatus };
      }

      // outcomeHint === "paid": record verified webhook receipt BEFORE calling provider fetchPayment outside tx!
      await tx
        .update(paymentAttempts)
        .set({
          verifiedWebhookEventId: verified.externalEventId,
          providerPaymentRef: verified.providerPaymentRef ?? attempt.providerPaymentRef,
          updatedAt: now,
        })
        .where(eq(paymentAttempts.id, attempt.id));

      let webhookRowId: number;
      if (existing) {
        webhookRowId = existing.id;
      } else {
        const [ins] = await tx.insert(paymentWebhookEvents).values({
          publicId: webhookPublicId,
          provider: input.provider,
          environment: eventEnv,
          externalEventId: verified.externalEventId,
          eventType: verified.eventType,
          payloadSha256,
          attemptId: attempt.id,
          attemptPublicId: attempt.publicId,
          providerRef: attempt.providerRef ?? verified.providerRef,
          providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
          providerPaymentRef: verified.providerPaymentRef,
          status: "retry_pending",
          reasonCode: "AWAITING_FETCH_VERIFICATION",
          occurredAt: verified.occurredAt,
          receivedAt: now,
        });
        webhookRowId = ins.insertId;
      }

      return {
        kind: "verify_paid" as const,
        webhookRowId,
        attempt,
        duplicate: Boolean(existing),
      };
    });

    if (staged.kind === "tamper_conflict") {
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "ERROR",
        reasonCode: "PAYLOAD_TAMPER_CONFLICT",
        actor: { role: "system" },
        attributes: {
          provider: input.provider,
          external_event_id: verified.externalEventId,
        },
      });
      return {
        httpStatus: 409,
        accepted: false,
        duplicate: true,
        booked: false,
        reasonCode: "PAYLOAD_TAMPER_CONFLICT",
      };
    }

    if (staged.kind === "duplicate_done") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: true,
        booked: staged.booked,
        reasonCode: "DUPLICATE_EVENT",
      };
    }

    if (staged.kind === "ignored") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: false,
        booked: false,
        reasonCode: "IGNORED",
      };
    }

    if (staged.kind === "terminal_non_paid") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: false,
        booked: false,
        reasonCode: staged.status.toUpperCase(),
      };
    }

    const { attempt, webhookRowId } = staged;
    if (!attempt.providerRef) {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "MISSING_PROVIDER_REF",
      };
    }

    let fetched: ProviderFetchedPayment;
    try {
      fetched = await adapter.fetchPayment({
        providerRef: attempt.providerRef,
        providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
        providerPaymentRef: verified.providerPaymentRef ?? attempt.providerPaymentRef,
        credentials,
      });
    } catch (err) {
      const reasonCode = err instanceof DomainError ? err.reasonCode : "PROVIDER_FETCH_FAILED";
      await deps.audit.record({
        category: "integration",
        eventName: "payments.verification.retry_scheduled",
        action: "verify",
        outcome: "failed",
        severity: "WARN",
        reasonCode,
        actor: { role: "system" },
        resource: { type: "payment_attempt", publicId: attempt.publicId },
        attributes: {
          provider: input.provider,
          external_event_id: verified.externalEventId,
        },
      });
      return {
        httpStatus: 503,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "UPSTREAM_FETCH_RETRYABLE",
      };
    }

    if (fetched.status === "open") {
      return {
        httpStatus: 503,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "PAYMENT_NOT_SETTLED_YET",
      };
    }

    if (fetched.status === "failed" || fetched.status === "expired") {
      const termStatus: PaymentAttemptStatus = fetched.status === "expired" ? "expired" : "failed";
      const termAt = deps.clock.now();
      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: termStatus,
            failureReasonCode: `FETCH_${termStatus.toUpperCase()}`,
            lastReconciledAt: termAt,
            version: attempt.version + 1,
            updatedAt: termAt,
          })
          .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));

        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "processed",
            reasonCode: `FETCH_${termStatus.toUpperCase()}`,
            processedAt: termAt,
          })
          .where(eq(paymentWebhookEvents.id, webhookRowId));
      });
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: `FETCH_${termStatus.toUpperCase()}`,
      };
    }

    const bookedResult = await deps.db.transaction((tx) =>
      finalizeVerifiedPaidAttemptInTx(tx, {
        attemptId: attempt.id,
        webhookRowId,
        fetched,
      }),
    );

    return {
      httpStatus: 200,
      accepted: true,
      duplicate: staged.duplicate,
      booked: bookedResult.booked,
      reasonCode: bookedResult.reasonCode,
    };
  }

  async function reconcilePendingAttempts(opts?: {
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
    beforeSend?: (() => Promise<void>) | undefined;
  }): Promise<ReconcilePaymentsResult> {
    const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
    const config = await loadConfig();
    // Enforce zero outbound network activity when payments are off (`provider === "none"`).
    if (config.provider === "none") {
      return { scanned: 0, booked: 0, expired: 0, failed: 0, stillPending: 0 };
    }
    const activeProvider: ActivePaymentProvider = config.provider;
    const candidates = await deps.db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, activeProvider),
          eq(paymentAttempts.environment, config.mode),
          or(
            eq(paymentAttempts.status, "redirected"),
            eq(paymentAttempts.status, "cancelled"),
          ),
        ),
      )
      .orderBy(desc(paymentAttempts.id))
      .limit(limit);

    let scanned = 0;
    let booked = 0;
    let expired = 0;
    let failed = 0;
    let stillPending = 0;

    for (const attempt of candidates) {
      if (opts?.signal?.aborted) break;
      if (attempt.status === "cancelled" && !attempt.verifiedWebhookEventId) {
        continue;
      }
      if (!attempt.providerRef) {
        continue;
      }
      scanned += 1;
      const now = deps.clock.now();

      let credentials: ProviderCredentials;
      try {
        const loaded = await loadProviderCredentials(attempt.provider, {
          ...config,
          mode: attempt.environment,
        });
        credentials = loaded.credentials;
      } catch {
        stillPending += 1;
        continue;
      }

      let fetched: ProviderFetchedPayment;
      try {
        fetched = await adapters[attempt.provider].fetchPayment({
          providerRef: attempt.providerRef,
          providerOrderRef: attempt.providerOrderRef,
          providerPaymentRef: attempt.providerPaymentRef,
          credentials,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.beforeSend ? { beforeSend: opts.beforeSend } : {}),
        });
      } catch {
        stillPending += 1;
        continue;
      }

      if (fetched.status === "paid") {
        if (attempt.verifiedWebhookEventId) {
          const [pendingWh] = await deps.db
            .select()
            .from(paymentWebhookEvents)
            .where(
              and(
                eq(paymentWebhookEvents.provider, attempt.provider),
                eq(paymentWebhookEvents.externalEventId, attempt.verifiedWebhookEventId),
              ),
            )
            .limit(1);

          if (!pendingWh) {
            stillPending += 1;
            continue;
          }

          const res = await deps.db.transaction((tx) =>
            finalizeVerifiedPaidAttemptInTx(tx, {
              attemptId: attempt.id,
              webhookRowId: pendingWh.id,
              fetched,
            }),
          );
          if (res.booked) {
            booked += 1;
          } else {
            failed += 1;
          }
        } else {
          // Decision 12: NEVER mark invoice paid without a verified signed webhook receipt.
          await deps.db
            .update(paymentAttempts)
            .set({
              reconciliationNote: "awaiting_webhook",
              lastReconciledAt: now,
              updatedAt: now,
            })
            .where(eq(paymentAttempts.id, attempt.id));
          stillPending += 1;
        }
        continue;
      }

      const isPastExpiry = Boolean(attempt.expiresAt && attempt.expiresAt.getTime() <= now.getTime());
      if (fetched.status === "expired" || (fetched.status === "open" && isPastExpiry && !attempt.verifiedWebhookEventId)) {
        await deps.db
          .update(paymentAttempts)
          .set({
            status: "expired",
            lastReconciledAt: now,
            version: attempt.version + 1,
            updatedAt: now,
          })
          .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));
        expired += 1;
        continue;
      }

      if (fetched.status === "failed") {
        await deps.db
          .update(paymentAttempts)
          .set({
            status: "failed",
            failureReasonCode: "RECONCILE_PROVIDER_FAILED",
            lastReconciledAt: now,
            version: attempt.version + 1,
            updatedAt: now,
          })
          .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.version, attempt.version)));
        failed += 1;
        continue;
      }

      await deps.db
        .update(paymentAttempts)
        .set({ lastReconciledAt: now, updatedAt: now })
        .where(eq(paymentAttempts.id, attempt.id));
      stillPending += 1;
    }

    return { scanned, booked, expired, failed, stillPending };
  }

  /* ------------------------------------------------------------- admin console */

  async function buildAdminSettingsView(tx?: Tx): Promise<PaymentsAdminSettingsView> {
    const config = await loadConfig(tx);
    const [stripeKeySet, stripeWhSet, squareTokenSet, squareSigSet] = await Promise.all([
      isSecretConfigured(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
      isSecretConfigured(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);

    const squareHost =
      config.mode === "live" ? ("connect.squareup.com" as const) : ("connect.squareupsandbox.com" as const);

    let stripeAllowlisted = false;
    let squareAllowlisted = false;
    const egressSvc = (deps.services as Partial<typeof deps.services>).integrations?.egress;
    if (!tx && egressSvc && typeof egressSvc.listPresets === "function") {
      try {
        const presets = await egressSvc.listPresets();
        stripeAllowlisted = presets.some((p) => p.key === "stripe" && p.enabled);
        const sqPresetKey = config.mode === "live" ? "square" : "square_sandbox";
        squareAllowlisted = presets.some((p) => p.key === sqPresetKey && p.enabled);
      } catch {
        stripeAllowlisted = false;
        squareAllowlisted = false;
      }
    }

    const onlineEnabled =
      config.provider === "stripe"
        ? stripeKeySet && stripeWhSet
        : config.provider === "square"
          ? Boolean(config.squareLocationId && squareTokenSet && squareSigSet)
          : false;

    const stripeWebhookUrl = new URL("/api/payments/webhooks/stripe", deps.config.canonicalOrigin).href;
    const squareWebhookUrl = new URL("/api/payments/webhooks/square", deps.config.canonicalOrigin).href;
    const stripeReturnPattern = new URL("/api/payments/return/stripe/<attemptId>", deps.config.canonicalOrigin).href;
    const squareReturnPattern = new URL("/api/payments/return/square/<attemptId>", deps.config.canonicalOrigin).href;

    return {
      provider: config.provider,
      mode: config.mode,
      currency: config.currency,
      successPath: config.successPath,
      cancelPath: config.cancelPath,
      webhookToleranceSeconds: config.webhookToleranceSeconds,
      onlineEnabled,
      stripe: {
        secretKeyConfigured: stripeKeySet,
        secretKeyLast4: stripeKeySet ? config.stripeSecretKeyLast4 : null,
        webhookSecretConfigured: stripeWhSet,
        webhookSecretLast4: stripeWhSet ? config.stripeWebhookSecretLast4 : null,
        webhookUrl: stripeWebhookUrl,
        returnUrlPattern: stripeReturnPattern,
        egressHost: "api.stripe.com",
        egressAllowlisted: stripeAllowlisted,
      },
      square: {
        locationId: config.squareLocationId,
        accessTokenConfigured: squareTokenSet,
        accessTokenLast4: squareTokenSet ? config.squareAccessTokenLast4 : null,
        webhookSignatureKeyConfigured: squareSigSet,
        webhookSignatureKeyLast4: squareSigSet ? config.squareWebhookSignatureKeyLast4 : null,
        webhookUrl: squareWebhookUrl,
        returnUrlPattern: squareReturnPattern,
        egressHost: squareHost,
        egressAllowlisted: squareAllowlisted,
      },
    };
  }

  async function adminGetSettings(principal: SessionPrincipal): Promise<PaymentsAdminSettingsView> {
    await assertAdminPaymentsRead(principal);
    return buildAdminSettingsView();
  }

  async function adminUpdateSettings(
    principal: SessionPrincipal,
    input: UpdatePaymentsSettingsInput,
  ): Promise<PaymentsAdminSettingsView> {
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter uppercase ISO 4217 code.");
    }

    await runComplianceTx(deps, principal, { type: "payments_settings" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
      const prev = await loadConfig(tx);

      const nextConfig: PaymentsConfigValue = {
        provider: input.provider,
        mode: input.mode,
        currency,
        successPath: input.successPath ?? prev.successPath,
        cancelPath: input.cancelPath ?? prev.cancelPath,
        webhookToleranceSeconds: input.webhookToleranceSeconds ?? prev.webhookToleranceSeconds,
        stripeSecretKeyLast4: prev.stripeSecretKeyLast4,
        stripeWebhookSecretLast4: prev.stripeWebhookSecretLast4,
        squareLocationId:
          input.squareLocationId !== undefined
            ? input.squareLocationId && input.squareLocationId.trim() !== ""
              ? input.squareLocationId.trim()
              : null
            : prev.squareLocationId,
        squareAccessTokenLast4: prev.squareAccessTokenLast4,
        squareWebhookSignatureKeyLast4: prev.squareWebhookSignatureKeyLast4,
      };

      const rotatedSecrets: string[] = [];

      function parseCredential(schema: { safeParse: (v: unknown) => { success: true; data: string } | { success: false } }, raw: string, label: string): string {
        const res = schema.safeParse(raw);
        if (!res.success) {
          throw validation("INVALID_CREDENTIAL_FORMAT", `${label} is not in the expected format.`);
        }
        return res.data;
      }

      if (input.clearStripeSecretKey) {
        await deps.settings.setSecret(PAYMENTS_STRIPE_SECRET_KEY.key, null, tx);
        nextConfig.stripeSecretKeyLast4 = null;
        rotatedSecrets.push("stripe_secret_key_cleared");
      } else if (input.stripeSecretKey !== undefined && input.stripeSecretKey.trim() !== "") {
        const parsed = parseCredential(PAYMENTS_STRIPE_SECRET_KEY.schema, input.stripeSecretKey.trim(), "Stripe secret key");
        await deps.settings.setSecret(PAYMENTS_STRIPE_SECRET_KEY.key, parsed, tx);
        nextConfig.stripeSecretKeyLast4 = maskLast4(parsed);
        rotatedSecrets.push("stripe_secret_key");
      }

      if (input.clearStripeWebhookSecret) {
        await deps.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET.key, null, tx);
        nextConfig.stripeWebhookSecretLast4 = null;
        rotatedSecrets.push("stripe_webhook_secret_cleared");
      } else if (input.stripeWebhookSecret !== undefined && input.stripeWebhookSecret.trim() !== "") {
        const parsed = parseCredential(PAYMENTS_STRIPE_WEBHOOK_SECRET.schema, input.stripeWebhookSecret.trim(), "Stripe webhook signing secret");
        await deps.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET.key, parsed, tx);
        nextConfig.stripeWebhookSecretLast4 = maskLast4(parsed);
        rotatedSecrets.push("stripe_webhook_secret");
      }

      if (input.clearSquareAccessToken) {
        await deps.settings.setSecret(PAYMENTS_SQUARE_ACCESS_TOKEN.key, null, tx);
        nextConfig.squareAccessTokenLast4 = null;
        rotatedSecrets.push("square_access_token_cleared");
      } else if (input.squareAccessToken !== undefined && input.squareAccessToken.trim() !== "") {
        const parsed = parseCredential(PAYMENTS_SQUARE_ACCESS_TOKEN.schema, input.squareAccessToken.trim(), "Square access token");
        await deps.settings.setSecret(PAYMENTS_SQUARE_ACCESS_TOKEN.key, parsed, tx);
        nextConfig.squareAccessTokenLast4 = maskLast4(parsed);
        rotatedSecrets.push("square_access_token");
      }

      if (input.clearSquareWebhookSignatureKey) {
        await deps.settings.setSecret(PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.key, null, tx);
        nextConfig.squareWebhookSignatureKeyLast4 = null;
        rotatedSecrets.push("square_webhook_signature_key_cleared");
      } else if (
        input.squareWebhookSignatureKey !== undefined &&
        input.squareWebhookSignatureKey.trim() !== ""
      ) {
        const parsed = parseCredential(
          PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.schema,
          input.squareWebhookSignatureKey.trim(),
          "Square webhook signature key",
        );
        await deps.settings.setSecret(PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.key, parsed, tx);
        nextConfig.squareWebhookSignatureKeyLast4 = maskLast4(parsed);
        rotatedSecrets.push("square_webhook_signature_key");
      }

      const requiresFreshPair =
        nextConfig.provider !== "none" &&
        (prev.provider !== nextConfig.provider || prev.mode !== nextConfig.mode);

      if (nextConfig.provider === "stripe") {
        if (
          requiresFreshPair &&
          (!input.stripeSecretKey?.trim() || !input.stripeWebhookSecret?.trim())
        ) {
          throw validation(
            "FRESH_CREDENTIALS_REQUIRED",
            "Enter both a fresh Stripe secret key and webhook signing secret when switching provider or environment.",
          );
        }
        const [stripeKey, stripeWh] = await Promise.all([
          readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
          readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
        ]);
        if (!stripeKey || !stripeWh) {
          throw validation(
            "STRIPE_CREDENTIALS_REQUIRED",
            "Configure both the Stripe secret key and webhook signing secret before enabling Stripe.",
          );
        }
        const expectedPrefix = nextConfig.mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
        if (!expectedPrefix.test(stripeKey)) {
          throw validation(
            "STRIPE_KEY_MODE_MISMATCH",
            `Stripe secret key must match ${nextConfig.mode} mode.`,
          );
        }
      } else if (nextConfig.provider === "square") {
        if (
          requiresFreshPair &&
          (!input.squareAccessToken?.trim() || !input.squareWebhookSignatureKey?.trim())
        ) {
          throw validation(
            "FRESH_CREDENTIALS_REQUIRED",
            "Enter both a fresh Square access token and webhook signature key when switching provider or environment.",
          );
        }
        const [sqToken, sqSig] = await Promise.all([
          readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
          readSecret(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
        ]);
        if (!nextConfig.squareLocationId || !sqToken || !sqSig) {
          throw validation(
            "SQUARE_CREDENTIALS_REQUIRED",
            "Configure the Square location ID, access token, and webhook signature key before enabling Square.",
          );
        }
      }

      await writeSetting(deps.settings, PAYMENTS_CONFIG_SETTING, nextConfig, tx);

      await deps.audit.record(
        {
          category: "admin",
          eventName: "payments.settings.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payments_settings" },
          attributes: {
            previous_provider: prev.provider,
            provider: nextConfig.provider,
            previous_mode: prev.mode,
            mode: nextConfig.mode,
            currency: nextConfig.currency,
            webhook_tolerance_seconds: nextConfig.webhookToleranceSeconds,
            rotated_secret_count: rotatedSecrets.length,
          },
        },
        tx,
      );
    });

    return buildAdminSettingsView();
  }

  async function adminListAttempts(
    principal: SessionPrincipal,
    input: {
      status?: PaymentAttemptStatus | undefined;
      provider?: ActivePaymentProvider | undefined;
      invoicePublicId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: AdminPaymentAttemptSummary[]; nextCursor: string | null }> {
    await assertAdminPaymentsRead(principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conds = [];
    if (afterId !== null) conds.push(lt(paymentAttempts.id, afterId));
    if (input.status) conds.push(eq(paymentAttempts.status, input.status));
    if (input.provider) conds.push(eq(paymentAttempts.provider, input.provider));
    if (input.invoicePublicId) conds.push(eq(paymentAttempts.invoicePublicId, input.invoicePublicId));

    const rows = await deps.db
      .select()
      .from(paymentAttempts)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(paymentAttempts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toAdminAttemptSummary),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminGetAttempt(
    principal: SessionPrincipal,
    attemptPublicId: string,
  ): Promise<AdminPaymentAttemptDetail> {
    await assertAdminPaymentsRead(principal);
    const [attempt] = await deps.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, attemptPublicId))
      .limit(1);
    if (!attempt) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");

    const webhooks = await deps.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.attemptId, attempt.id))
      .orderBy(desc(paymentWebhookEvents.id))
      .limit(50);

    return {
      attempt: toAdminAttemptSummary(attempt),
      webhooks: webhooks.map(toAdminWebhookSummary),
    };
  }

  async function adminListWebhooks(
    principal: SessionPrincipal,
    input: {
      provider?: ActivePaymentProvider | undefined;
      status?: PaymentWebhookStatus | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: AdminPaymentWebhookSummary[]; nextCursor: string | null }> {
    await assertAdminPaymentsRead(principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conds = [];
    if (afterId !== null) conds.push(lt(paymentWebhookEvents.id, afterId));
    if (input.provider) conds.push(eq(paymentWebhookEvents.provider, input.provider));
    if (input.status) conds.push(eq(paymentWebhookEvents.status, input.status));

    const rows = await deps.db
      .select()
      .from(paymentWebhookEvents)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(paymentWebhookEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toAdminWebhookSummary),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminReconcileNow(
    principal: SessionPrincipal,
    input?: { limit?: number | undefined },
  ): Promise<ReconcilePaymentsResult> {
    await runComplianceTx(deps, principal, { type: "payment_attempt" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
      await deps.audit.record(
        {
          category: "admin",
          eventName: "payments.reconcile.triggered",
          action: "execute",
          outcome: "attempted",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payment_attempt" },
        },
        tx,
      );
    });

    const result = await reconcilePendingAttempts({ limit: input?.limit ?? 25 });

    await deps.audit.record({
      category: "admin",
      eventName: "payments.reconcile.completed",
      action: "execute",
      outcome: "completed",
      actor: { userId: principal.userId, role: principal.role },
      resource: { type: "payment_attempt" },
      safeCounts: {
        scanned: result.scanned,
        booked: result.booked,
        expired: result.expired,
        failed: result.failed,
        still_pending: result.stillPending,
      },
    });

    return result;
  }

  async function healthCounts(): Promise<{
    provider: PaymentProviderChoice;
    onlineEnabled: boolean;
    redirectedAttempts: number;
    retryPendingWebhooks: number;
  }> {
    const config = await loadConfig();
    const [onlineEnabled, [attRow], [whRow]] = await Promise.all([
      isProviderCredentialsReady(config),
      deps.db
        .select({ total: count() })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.status, "redirected")),
      deps.db
        .select({ total: count() })
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.status, "retry_pending")),
    ]);

    return {
      provider: config.provider,
      onlineEnabled,
      redirectedAttempts: attRow?.total ?? 0,
      retryPendingWebhooks: whRow?.total ?? 0,
    };
  }

  return {
    isOnlineCheckoutEnabled,
    getPublicCheckoutConfig,
    startCheckout,
    getCheckoutStatus,
    cancelAttemptIfUnpaid,
    handleSignedWebhook,
    reconcilePendingAttempts,
    admin: {
      getSettings: adminGetSettings,
      updateSettings: adminUpdateSettings,
      listAttempts: adminListAttempts,
      getAttempt: adminGetAttempt,
      listWebhooks: adminListWebhooks,
      reconcileNow: adminReconcileNow,
    },
    healthCounts,
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
