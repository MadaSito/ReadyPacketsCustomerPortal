import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { StaffOrderHandoff } from "@/app/portal";
import {
  BillingFields,
  billingFieldDomId,
  EMPTY_BILLING_DETAILS,
  extractBillingFieldErrors,
  formatBillingSummaryLines,
  validateBillingFields,
  type BillingDetails,
  type BillingFieldErrors,
} from "@/features/billingProfile/BillingFields";
import {
  InvoiceOnlinePayAction,
  invoiceCheckoutNavigation,
  isHostedCheckoutUrl,
} from "@/features/compliance/customer/InvoicePages";
import { PromoCodeField } from "@/features/promotions/PromoCodeField";
import {
  AgreementDialog,
  parseAgreementRequiredDetails,
  SafePolicyText,
  type AgreementRequiredDetails,
} from "@/lib/agreementGate";
import { errorMessage, safeError, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Money,
  PageHeader,
  Skeleton,
  Textarea,
} from "@/ui";
import { canCheckout, type CartViewData } from "./CartPage";
import { useCartViewerGate } from "./viewerGate";

export { isHostedCheckoutUrl };

export interface SavedBillingProfileSnapshot {
  publicId: string;
  details: BillingDetails;
  version: number;
  updatedAt: Date | string;
}

type Policy = CartViewData["pendingPolicies"][number];
type PolicyDraft = { accepted: boolean; signerName: string };
const emptyPolicy: PolicyDraft = { accepted: false, signerName: "" };
const policyKey = (policy: Policy) => `${policy.versionPublicId}:${policy.contentHash}`;

type PlacedPaymentHandoff = {
  kind: "untrusted_redirect_url" | "payment_unavailable";
  cartPublicId: string;
  orderPublicId: string;
  orderReference: string;
  invoicePublicId: string;
  invoiceNumber: string;
  currency: string;
  totalMinor: number;
  onlinePaymentAvailable?: boolean | undefined;
  safeMessage: string;
};

function PlacedOrderPaymentHandoff({ handoff }: { handoff: PlacedPaymentHandoff }) {
  const [, navigate] = useLocation();
  const alertRef = useRef<HTMLDivElement | null>(null);
  const retryErrorRef = useRef<HTMLDivElement | null>(null);
  const [payRetryError, setPayRetryError] = useState<string | null>(null);
  const showPayNow = handoff.onlinePaymentAvailable !== false;

  useEffect(() => {
    alertRef.current?.focus();
  }, []);

  return (
    <div className="grid gap-4">
      <div
        ref={alertRef}
        tabIndex={-1}
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-action"
      >
        <Callout
          tone="warning"
          live="assertive"
          title={`Your order ${handoff.orderReference} is placed, but we could not open the secure payment page`}
        >
          <p>{handoff.safeMessage}</p>
          <p className="mt-1">
            Your cart has already been converted into order <strong>{handoff.orderReference}</strong> — do not submit
            this cart again.
          </p>
        </Callout>
      </div>

      {payRetryError ? (
        <div
          ref={retryErrorRef}
          tabIndex={-1}
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-action"
        >
          <Callout tone="danger" live="assertive" title="Could not open online payment">
            <p>{payRetryError}</p>
          </Callout>
        </div>
      ) : null}

      <Card title="Order and invoice">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-semibold">Order reference</dt>
            <dd className="break-all">{handoff.orderReference}</dd>
          </div>
          <div>
            <dt className="font-semibold">Invoice number</dt>
            <dd className="break-all">{handoff.invoiceNumber}</dd>
          </div>
          <div>
            <dt className="font-semibold">Invoice balance</dt>
            <dd>
              <Money value={{ amountMinor: handoff.totalMinor, currency: handoff.currency }} />
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {showPayNow ? (
            <>
              <InvoiceOnlinePayAction
                invoicePublicId={handoff.invoicePublicId}
                label="Pay now"
                variant="primary"
                successPath="/checkout/return"
                cancelPath="/checkout/cancel"
                onCheckoutError={(message) => {
                  setPayRetryError(message);
                  if (message) requestAnimationFrame(() => retryErrorRef.current?.focus());
                }}
                onSettled={() => {
                  navigate(`/checkout/return?cart=${encodeURIComponent(handoff.cartPublicId)}`, { replace: true });
                }}
              />
              <Button asChild variant="secondary">
                <Link href={`/invoices/${encodeURIComponent(handoff.invoicePublicId)}`}>View invoice</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href={`/orders/${encodeURIComponent(handoff.orderPublicId)}`}>View order</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href={`/checkout/return?cart=${encodeURIComponent(handoff.cartPublicId)}`}>View payment status</Link>
              </Button>
            </>
          ) : (
            <>
              <Button asChild variant="primary">
                <Link href={`/invoices/${encodeURIComponent(handoff.invoicePublicId)}`}>View invoice</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href={`/orders/${encodeURIComponent(handoff.orderPublicId)}`}>View order</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href={`/checkout/return?cart=${encodeURIComponent(handoff.cartPublicId)}`}>View payment status</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href="/support">Contact support</Link>
              </Button>
            </>
          )}
        </div>

        {!showPayNow ? (
          <p className="mt-3 text-sm text-muted">
            No online payment was collected. Open your invoice for the balance due and payment instructions, or contact
            support if you need assistance completing payment.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

function CheckoutSummary({
  cart,
  submitting,
  onApplyPromo,
  onRemovePromo,
}: {
  cart: CartViewData;
  submitting: boolean;
  onApplyPromo: (code: string) => Promise<void>;
  onRemovePromo: () => Promise<void>;
}) {
  const currency = cart.totals.currency!;
  const showPromo = cart.promotionsEnabled || cart.totals.promo !== null || cart.promoNotice !== null;
  const appliedPromo = cart.totals.promo
    ? {
        label: cart.totals.promo.label,
        discountMinor: cart.totals.promo.promoDiscountMinor,
        currency,
      }
    : null;
  const addToOrder = cart.addToOrder ?? null;

  return (
    <Card title="Order summary">
      {addToOrder && addToOrder.projectName && addToOrder.rootReference ? (
        <div
          data-testid="checkout-adding-to-project"
          className="mb-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm font-medium text-ink break-words"
        >
          Adding to project {addToOrder.projectName} ({addToOrder.rootReference})
        </div>
      ) : null}
      <ul className="divide-y divide-line">
        {cart.items.map((item) => (
          <li key={item.itemPublicId} className="flex justify-between gap-3 py-3 text-sm">
            <span className="min-w-0 break-words">
              {item.name} <span className="text-muted">× {item.quantity}</span>
            </span>
            <span className="shrink-0">
              <Money value={{ amountMinor: item.lineTotalMinor, currency }} />
            </span>
          </li>
        ))}
      </ul>
      <dl className="mt-3 grid gap-2 border-t border-line pt-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="min-w-0 break-words">Subtotal</dt>
          <dd>
            <Money value={{ amountMinor: cart.totals.subtotalMinor, currency }} />
          </dd>
        </div>
        {cart.totals.discountMinor > 0 ? (
          <div className="flex justify-between gap-3">
            <dt className="min-w-0 break-words">{cart.totals.discountLabel ?? "Discount"}</dt>
            <dd>
              <Money value={{ amountMinor: -cart.totals.discountMinor, currency }} />
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt>Tax</dt>
          <dd>
            <Money value={{ amountMinor: cart.totals.taxMinor, currency }} />
          </dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-line pt-3 text-base font-semibold">
          <dt>Total</dt>
          <dd>
            <Money value={{ amountMinor: cart.totals.totalMinor, currency }} />
          </dd>
        </div>
      </dl>
      {showPromo ? (
        <div className="mt-4 border-t border-line pt-4">
          <PromoCodeField
            applied={appliedPromo}
            onApply={onApplyPromo}
            onRemove={onRemovePromo}
            disabled={submitting}
          />
          {cart.totals.promo &&
          cart.totals.promo.promoDiscountMinor === 0 &&
          cart.totals.promo.bundleDiscountMinor > 0 ? (
            <p className="mt-2 text-xs text-muted">
              Your bundle discount saves more and is applied automatically.
            </p>
          ) : null}
          {cart.promoNotice ? (
            <Callout tone="warning" className="mt-3" title="Discount code not currently applied">
              <p>{cart.promoNotice.message}</p>
            </Callout>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function CheckoutForm({
  cart,
  savedProfile,
  reload,
  reloadBillingProfile,
  onPaymentHandoff,
}: {
  cart: CartViewData & { cartPublicId: string };
  savedProfile: SavedBillingProfileSnapshot | null;
  reload: () => Promise<unknown>;
  reloadBillingProfile: () => Promise<{ data?: SavedBillingProfileSnapshot | null } | unknown>;
  onPaymentHandoff: (handoff: PlacedPaymentHandoff) => void;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const checkoutFormId = useId();
  const billingIdPrefix = `${checkoutFormId}-billing`;
  const saveBillingCheckboxId = `${checkoutFormId}-save-billing`;
  const [, navigate] = useLocation();

  const hasSavedProfile = savedProfile !== null;
  const isAddingToOrder = Boolean(
    cart.addToOrder && cart.addToOrder.targetAvailable && cart.addToOrder.projectName,
  );

  const [projectName, setProjectName] = useState(cart.projectName);
  const [projectNameError, setProjectNameError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState(cart.note);
  const [billingMode, setBillingMode] = useState<"saved" | "custom">(hasSavedProfile ? "saved" : "custom");
  const [billing, setBilling] = useState<BillingDetails>(cart.billing ?? EMPTY_BILLING_DETAILS);
  const [billingErrors, setBillingErrors] = useState<BillingFieldErrors>({});
  const [saveAsBillingProfile, setSaveAsBillingProfile] = useState<boolean>(!hasSavedProfile);

  const [policies, setPolicies] = useState<Record<string, PolicyDraft>>({});
  const [policyErrors, setPolicyErrors] = useState<Record<string, { message: string; expectedName: string | null }>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; checkStatus: boolean }>();
  const [reconfirmNotice, setReconfirmNotice] = useState<string | null>(null);
  const [agreementPrompt, setAgreementPrompt] = useState<AgreementRequiredDetails | null>(null);
  const [acceptedAgreementPolicyIds, setAcceptedAgreementPolicyIds] = useState<string[]>([]);
  const reconfirmRef = useRef<HTMLDivElement>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const signerInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const request = useRef<{ version: number; key: string } | null>(null);
  const inFlight = useRef(false);
  const statusHref = `/checkout/return?cart=${encodeURIComponent(cart.cartPublicId)}`;

  // Sync billing mode if saved profile disappears (e.g. cleared in another tab and refetched after SAVED_BILLING_NOT_FOUND).
  const prevSavedPublicIdRef = useRef<string | null>(savedProfile?.publicId ?? null);
  useEffect(() => {
    const nextPublicId = savedProfile?.publicId ?? null;
    if (prevSavedPublicIdRef.current !== null && nextPublicId === null) {
      setBillingMode("custom");
      setSaveAsBillingProfile(false);
    } else if (prevSavedPublicIdRef.current === null && nextPublicId !== null) {
      setBillingMode("saved");
      setSaveAsBillingProfile(false);
    }
    prevSavedPublicIdRef.current = nextPublicId;
  }, [savedProfile?.publicId]);

  const effectiveBillingMode: "saved" | "custom" = hasSavedProfile ? billingMode : "custom";

  const currency = cart.totals.currency!;
  const noPaymentDue = cart.totals.totalMinor === 0;
  const smallEval = cart.smallTotalEvaluation;
  const waivedSmallTotal = !noPaymentDue && smallEval?.smallTotalAction === "waive";
  const blockedSmallTotal = !noPaymentDue && smallEval?.smallTotalAction === "block";
  const online =
    !noPaymentDue &&
    !waivedSmallTotal &&
    !blockedSmallTotal &&
    cart.onlinePaymentEnabled &&
    cart.paymentProvider !== "none";

  // Decision D14: compute effective typed-signature requirement from both `policy.requiresTypedSignature`
  // and `cart.placeOrderAgreement` (`signatureMode === "typed_name"`).
  function policyNeedsTypedSignature(policy: Policy): boolean {
    if (policy.requiresTypedSignature) return true;
    const gate = cart.placeOrderAgreement;
    return Boolean(
      gate?.required &&
        gate.signatureMode === "typed_name" &&
        gate.policyPublicId === policy.documentPublicId,
    );
  }

  function getInlinePendingPolicies(extraAcceptedPolicyId?: string): Policy[] {
    const acceptedSet = new Set(acceptedAgreementPolicyIds);
    if (extraAcceptedPolicyId) acceptedSet.add(extraAcceptedPolicyId);
    return cart.pendingPolicies.filter((policy) => !acceptedSet.has(policy.documentPublicId));
  }
  const inlinePendingPolicies = getInlinePendingPolicies();

  function updatePolicy(policy: Policy, update: Partial<PolicyDraft>) {
    const key = policyKey(policy);
    setPolicies((previous) => ({ ...previous, [key]: { ...(previous[key] ?? emptyPolicy), ...update } }));
    if (update.signerName !== undefined) {
      setPolicyErrors((previous) => {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  }

  async function handleApplyPromo(code: string) {
    const next = await client.cart.applyCode.mutate({
      code,
      idempotencyKey: `checkout-promo:${crypto.randomUUID()}`,
    });
    queryClient.setQueryData(trpc.cart.get.queryKey(), next);
    setReconfirmNotice(null);
    setFailure(undefined);
  }

  async function handleRemovePromo() {
    const next = await client.cart.removeCode.mutate({ expectedVersion: cart.version });
    queryClient.setQueryData(trpc.cart.get.queryKey(), next);
    setReconfirmNotice(null);
    setFailure(undefined);
  }

  function invalidateBillingProfileCache() {
    const bp = (
      trpc as unknown as {
        billingProfile?: { get?: { queryKey?: () => readonly unknown[] } };
      }
    ).billingProfile?.get;
    if (bp?.queryKey) {
      void queryClient.invalidateQueries({ queryKey: bp.queryKey() });
    }
  }

  async function performCheckout(justAcceptedPolicyPublicId?: string) {
    if (inFlight.current) return;

    const effectiveProjectName = isAddingToOrder
      ? (cart.addToOrder?.projectName ?? projectName).trim()
      : projectName.trim();

    if (!isAddingToOrder && !effectiveProjectName) {
      setProjectNameError("Enter a project name.");
      setFailure({ message: "Complete the required project name field before placing your order.", checkStatus: false });
      requestAnimationFrame(() => projectNameInputRef.current?.focus());
      return;
    }

    let validatedCustomBilling: BillingDetails | undefined;
    if (effectiveBillingMode === "custom") {
      const billingCheck = validateBillingFields(billing);
      if (!billingCheck.ok) {
        setBillingErrors(billingCheck.errors);
        setFailure({
          message: "Complete the required billing fields. Use a two-letter country code.",
          checkStatus: false,
        });
        requestAnimationFrame(() => {
          document.getElementById(billingFieldDomId(billingIdPrefix, billingCheck.firstKey))?.focus();
        });
        return;
      }
      validatedCustomBilling = billingCheck.data;
    }

    const pending = getInlinePendingPolicies(justAcceptedPolicyPublicId);
    if (
      pending.some((policy) => {
        const draft = policies[policyKey(policy)];
        return !draft?.accepted || (policyNeedsTypedSignature(policy) && !draft.signerName.trim());
      })
    ) {
      setFailure({
        message: "Review and accept each required policy, and sign where indicated.",
        checkStatus: false,
      });
      return;
    }

    if (request.current?.version !== cart.version) {
      request.current = { version: cart.version, key: `checkout:${crypto.randomUUID()}` };
    }
    inFlight.current = true;
    setSubmitting(true);
    setFailure(undefined);
    setProjectNameError(undefined);
    setBillingErrors({});
    setPolicyErrors({});
    setReconfirmNotice(null);

    try {
      const checkoutPayload =
        effectiveBillingMode === "saved" && savedProfile
          ? {
              cartPublicId: cart.cartPublicId,
              expectedVersion: cart.version,
              projectName: effectiveProjectName,
              note: note.trim(),
              billingSource: "saved" as const,
              savedBillingPublicId: savedProfile.publicId,
              savedBillingVersion: savedProfile.version,
              policyAcceptances: pending.map((policy) => ({
                versionPublicId: policy.versionPublicId,
                contentHash: policy.contentHash,
                ...(policyNeedsTypedSignature(policy)
                  ? { signerName: policies[policyKey(policy)]!.signerName.trim() }
                  : {}),
              })),
              idempotencyKey: request.current.key,
            }
          : {
              cartPublicId: cart.cartPublicId,
              expectedVersion: cart.version,
              projectName: effectiveProjectName,
              note: note.trim(),
              billingSource: "custom" as const,
              billing: validatedCustomBilling!,
              saveAsBillingProfile,
              ...(saveAsBillingProfile
                ? savedProfile
                  ? {
                      savedBillingPublicId: savedProfile.publicId,
                      savedBillingVersion: savedProfile.version,
                    }
                  : {
                      savedBillingVersion: 0,
                    }
                : {}),
              policyAcceptances: pending.map((policy) => ({
                versionPublicId: policy.versionPublicId,
                contentHash: policy.contentHash,
                ...(policyNeedsTypedSignature(policy)
                  ? { signerName: policies[policyKey(policy)]!.signerName.trim() }
                  : {}),
              })),
              idempotencyKey: request.current.key,
            };

      const result = await client.cart.checkout.mutate(checkoutPayload);
      void queryClient.invalidateQueries({ queryKey: trpc.cart.badgeCount.queryKey() });
      void queryClient.invalidateQueries({ queryKey: trpc.cart.get.queryKey(), refetchType: "none" });
      if (effectiveBillingMode === "custom" && saveAsBillingProfile) {
        invalidateBillingProfileCache();
      }
      if (result.mode === "redirect") {
        if (isHostedCheckoutUrl(result.redirectUrl, result.provider, result.environment)) {
          invoiceCheckoutNavigation.redirectToHostedCheckout(result.redirectUrl);
          return;
        }
        onPaymentHandoff({
          kind: "untrusted_redirect_url",
          cartPublicId: result.cartPublicId,
          orderPublicId: result.orderPublicId,
          orderReference: result.orderReference,
          invoicePublicId: result.invoicePublicId,
          invoiceNumber: result.invoiceNumber,
          currency: result.currency,
          totalMinor: result.totalMinor,
          onlinePaymentAvailable: true,
          safeMessage:
            "For your security, we stopped an unexpected payment redirect link. Select Pay now to open a fresh hosted payment session, or open your invoice.",
        });
        return;
      }
      if (result.mode === "payment_unavailable") {
        onPaymentHandoff({
          kind: "payment_unavailable",
          cartPublicId: result.cartPublicId,
          orderPublicId: result.orderPublicId,
          orderReference: result.orderReference,
          invoicePublicId: result.invoicePublicId,
          invoiceNumber: result.invoiceNumber,
          currency: result.currency,
          totalMinor: result.totalMinor,
          onlinePaymentAvailable: result.onlinePaymentAvailable,
          safeMessage: result.safeMessage,
        });
        return;
      }
      navigate(`/checkout/return?cart=${encodeURIComponent(result.cartPublicId)}`, { replace: true });
    } catch (error) {
      const agreementDetails = parseAgreementRequiredDetails(error);
      if (agreementDetails) {
        request.current = null;
        setAgreementPrompt(agreementDetails);
        return;
      }
      const code = safeError(error);
      if (code?.reasonCode === "SIGNER_NAME_MISMATCH") {
        request.current = null;
        const details =
          code.details && typeof code.details === "object"
            ? (code.details as { expectedName?: unknown; versionPublicId?: unknown; documentPublicId?: unknown })
            : null;
        const expectedName =
          typeof details?.expectedName === "string" && details.expectedName.length > 0 ? details.expectedName : null;
        const targetVersionId = typeof details?.versionPublicId === "string" ? details.versionPublicId : null;
        const targetDocId = typeof details?.documentPublicId === "string" ? details.documentPublicId : null;
        const baseMsg = errorMessage(error, "The typed signature must match your account profile name.");
        const matching = pending.filter((policy) => {
          if (!policyNeedsTypedSignature(policy)) return false;
          if (targetVersionId) return policy.versionPublicId === targetVersionId;
          if (targetDocId) return policy.documentPublicId === targetDocId;
          return true;
        });
        const targets = matching.length > 0 ? matching : pending.filter((policy) => policyNeedsTypedSignature(policy));
        if (targets.length > 0) {
          const nextErrors: Record<string, { message: string; expectedName: string | null }> = {};
          for (const policy of targets) {
            nextErrors[policyKey(policy)] = { message: baseMsg, expectedName };
          }
          setPolicyErrors(nextErrors);
          const firstKey = policyKey(targets[0]!);
          requestAnimationFrame(() => signerInputRefs.current.get(firstKey)?.focus());
          return;
        }
      }
      if (code?.reasonCode === "SAVED_BILLING_NOT_FOUND" || code?.reasonCode === "SAVED_BILLING_CHANGED") {
        request.current = null;
        await Promise.all([reload(), reloadBillingProfile()]);
        setFailure({
          message: errorMessage(
            error,
            "Your saved billing information changed in another window. Review your billing details and confirm again.",
          ),
          checkStatus: false,
        });
        return;
      }
      if (code?.reasonCode === "ADD_ON_TARGET_UNAVAILABLE" || code?.reasonCode === "PACKET_ALREADY_IN_PROJECT") {
        request.current = null;
        await reload();
        setFailure({
          message: errorMessage(
            error,
            "Packets can no longer be added to the selected project. Return to your cart to review your items.",
          ),
          checkStatus: false,
        });
        return;
      }
      if (code?.fieldErrors) {
        const mappedBillingErrors = extractBillingFieldErrors(code.fieldErrors, "billing");
        if (Object.keys(mappedBillingErrors).length > 0) {
          setBillingErrors(mappedBillingErrors);
        }
      }
      if (code?.reasonCode === "PROMO_RECONFIRM_TOTAL" || code?.reasonCode === "TOTAL_CHANGED_RECONFIRM") {
        request.current = null;
        await reload();
        const message =
          code.reasonCode === "PROMO_RECONFIRM_TOTAL"
            ? "Your discount code is no longer valid, so your order was not placed. Review the updated total in your order summary and confirm again below."
            : "Your order total changed, so your order was not placed. Review the updated total in your order summary and confirm again below.";
        setReconfirmNotice(message);
        requestAnimationFrame(() => reconfirmRef.current?.focus());
      } else if (code?.reasonCode === "STALE_VERSION") {
        request.current = null;
        await reload();
        setFailure({
          message: "Your cart changed. Review the refreshed details and totals before placing your order.",
          checkStatus: false,
        });
      } else if (
        code?.reasonCode &&
        [
          "POLICY_VERSION_NOT_FOUND",
          "POLICY_VERSION_SUPERSEDED",
          "POLICY_HASH_MISMATCH",
          "POLICY_ACCEPTANCE_REQUIRED",
          "TYPED_SIGNATURE_REQUIRED",
        ].includes(code.reasonCode)
      ) {
        request.current = null;
        await reload();
        setFailure({
          message:
            "The required policies changed. Review the refreshed versions and accept them before placing your order.",
          checkStatus: false,
        });
      } else {
        setFailure({
          message: errorMessage(error, "We couldn't confirm checkout. Check the order status before trying again."),
          checkStatus: !code || code.domainCode === "UNAVAILABLE" || code.domainCode === "INTERNAL",
        });
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await performCheckout();
  }

  const noCardCharge = noPaymentDue || waivedSmallTotal;
  const submitLabel = reconfirmNotice
    ? noCardCharge
      ? "Confirm new total and place order"
      : online
        ? "Confirm new total and continue to payment"
        : "Confirm new total and receive invoice"
    : noCardCharge
      ? "Place order"
      : online
        ? "Place order and continue to payment"
        : "Place order and receive invoice";

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
      <form
        id={checkoutFormId}
        aria-label="Checkout details"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="grid min-w-0 gap-6"
      >
        <Card title="Project details">
          <div className="grid gap-4">
            {isAddingToOrder && cart.addToOrder ? (
              <div
                data-testid="checkout-target-project-lock"
                className="rounded-lg border border-line bg-surface-sunken px-3.5 py-2.5 text-sm"
              >
                <p className="font-medium text-ink break-words">
                  Adding to project {cart.addToOrder.projectName}
                  {cart.addToOrder.rootReference ? ` (${cart.addToOrder.rootReference})` : ""}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  These packets will be added to your existing project.
                </p>
              </div>
            ) : (
              <Field label="Project name" required error={projectNameError}>
                <Input
                  ref={projectNameInputRef}
                  value={projectName}
                  onChange={(e) => {
                    setProjectName(e.target.value);
                    setProjectNameError(undefined);
                  }}
                  maxLength={160}
                  required
                  disabled={submitting}
                />
              </Field>
            )}
            <Field label="Project notes">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={4000}
                rows={3}
                disabled={submitting}
              />
            </Field>
          </div>
        </Card>

        <Card title="Billing information" description="These details appear on your invoice.">
          <div
            data-testid="checkout-billing-section"
            data-has-saved-profile={hasSavedProfile ? "true" : "false"}
            data-billing-mode={effectiveBillingMode}
            className="grid gap-4"
          >
            {hasSavedProfile && savedProfile ? (
              <div
                role="radiogroup"
                aria-label="Billing information choice"
                data-testid="checkout-billing-choice"
                className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3"
              >
                <div className="rounded-lg border border-line p-3 sm:p-4">
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-ink">
                    <input
                      type="radio"
                      name={`${checkoutFormId}-billing-choice`}
                      data-testid="checkout-billing-choice-saved"
                      checked={effectiveBillingMode === "saved"}
                      onChange={() => {
                        setBillingMode("saved");
                        setBillingErrors({});
                        setFailure(undefined);
                      }}
                      disabled={submitting}
                      className="size-4 shrink-0 accent-action focus-visible:ring-2 focus-visible:ring-action"
                    />
                    <span>Use my saved billing information</span>
                  </label>
                  <div
                    data-testid="checkout-saved-billing-summary"
                    className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5 pl-7 text-sm text-muted [overflow-wrap:anywhere]"
                  >
                    {formatBillingSummaryLines(savedProfile.details).map((line, idx) => (
                      <p key={idx}>{line}</p>
                    ))}
                    <p className="mt-1 text-xs">
                      <Link href="/account/billing" className="text-action underline">
                        Manage saved billing information
                      </Link>
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-line p-3 sm:p-4">
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-ink">
                    <input
                      type="radio"
                      name={`${checkoutFormId}-billing-choice`}
                      data-testid="checkout-billing-choice-custom"
                      checked={effectiveBillingMode === "custom"}
                      onChange={() => {
                        setBillingMode("custom");
                        setFailure(undefined);
                      }}
                      disabled={submitting}
                      className="size-4 shrink-0 accent-action focus-visible:ring-2 focus-visible:ring-action"
                    />
                    <span>Enter different billing information</span>
                  </label>
                </div>
              </div>
            ) : null}

            {effectiveBillingMode === "custom" ? (
              <div data-testid="checkout-custom-billing-fields" className="grid gap-4">
                <BillingFields
                  idPrefix={billingIdPrefix}
                  value={billing}
                  onChange={(next) => {
                    setBilling(next);
                    setBillingErrors({});
                  }}
                  errors={billingErrors}
                  disabled={submitting}
                />
                <div className="flex items-center gap-3">
                  <span className="inline-flex min-h-11 min-w-11 items-center justify-center -m-2.5">
                    <input
                      id={saveBillingCheckboxId}
                      type="checkbox"
                      data-testid="checkout-save-billing-checkbox"
                      checked={saveAsBillingProfile}
                      onChange={(e) => setSaveAsBillingProfile(e.target.checked)}
                      disabled={submitting}
                      className="size-5 cursor-pointer rounded border-2 border-control-border accent-action focus-visible:ring-2 focus-visible:ring-action disabled:opacity-60"
                    />
                  </span>
                  <label htmlFor={saveBillingCheckboxId} className="cursor-pointer text-sm font-medium text-ink">
                    Save as my billing information
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        {inlinePendingPolicies.length ? (
          <Card title="Required policies" description="Read and accept the current versions before placing your order.">
            <div className="grid gap-5">
              {inlinePendingPolicies.map((policy) => {
                const pKey = policyKey(policy);
                const draft = policies[pKey] ?? emptyPolicy;
                const needsTyped = policyNeedsTypedSignature(policy);
                const fieldErr = policyErrors[pKey];
                return (
                  <div key={pKey} className="grid gap-3 rounded-lg border border-line p-3 sm:p-4">
                    <details>
                      <summary className="cursor-pointer break-words font-semibold text-action">
                        {policy.title} · Version {policy.versionNumber}
                      </summary>
                      <div className="mt-3">
                        <SafePolicyText bodyText={policy.bodyText} format={policy.contentFormat} />
                      </div>
                    </details>
                    <Checkbox
                      label={`I have read and agree to ${policy.title} (version ${policy.versionNumber}).`}
                      checked={draft.accepted}
                      onCheckedChange={(accepted) => updatePolicy(policy, { accepted })}
                      disabled={submitting}
                    />
                    {needsTyped ? (
                      <Field
                        label={`Type your full name to sign ${policy.title}`}
                        hint={
                          <span>
                            {fieldErr?.expectedName ? (
                              <>
                                Expected account name: <strong>{fieldErr.expectedName}</strong>.{" "}
                              </>
                            ) : (
                              <>Use the name on your ReadyPackets profile </>
                            )}
                            (<Link href="/account" className="text-action underline">update name in profile</Link>).
                          </span>
                        }
                        error={
                          fieldErr
                            ? fieldErr.expectedName
                              ? `${fieldErr.message} Expected account name: ${fieldErr.expectedName}.`
                              : fieldErr.message
                            : undefined
                        }
                        required
                      >
                        <Input
                          ref={(el) => {
                            if (el) signerInputRefs.current.set(pKey, el);
                            else signerInputRefs.current.delete(pKey);
                          }}
                          value={draft.signerName}
                          onChange={(e) => updatePolicy(policy, { signerName: e.target.value })}
                          maxLength={160}
                          autoComplete="name"
                          required
                          disabled={submitting}
                        />
                      </Field>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>
        ) : null}
      </form>

      <div className="grid min-w-0 gap-4">
        <CheckoutSummary
          cart={cart}
          submitting={submitting}
          onApplyPromo={handleApplyPromo}
          onRemovePromo={handleRemovePromo}
        />
        {noPaymentDue ? (
          <Callout tone="success" title="Nothing to pay — your discount covers this order.">
            We’ll place your order and issue a settled zero-balance invoice. No payment is collected.
          </Callout>
        ) : waivedSmallTotal && smallEval ? (
          <Callout tone="success" title="Remaining balance will be waived">
            Your remaining balance (<Money value={{ amountMinor: cart.totals.totalMinor, currency }} />) is below the
            online payment minimum (<Money value={{ amountMinor: smallEval.minimumMinor, currency }} />) and will be
            waived automatically. No card payment is collected.
          </Callout>
        ) : blockedSmallTotal && smallEval ? (
          <Callout tone="warning" title="Total below online payment minimum">
            Online card payments require at least <Money value={{ amountMinor: smallEval.minimumMinor, currency }} />.
            Add another item in your cart or remove the discount code before placing your order.
          </Callout>
        ) : online ? (
          <Callout
            tone={cart.paymentEnvironment === "test" ? "warning" : "info"}
            title={cart.paymentEnvironment === "test" ? "Test checkout" : "Secure hosted payment"}
          >
            {cart.paymentEnvironment === "test"
              ? "This checkout uses a test environment. No real money is collected."
              : "You’ll continue to the payment provider. ReadyPackets never collects your card details."}
          </Callout>
        ) : (
          <Callout tone="info" title="Pay by invoice">
            We’ll issue an invoice when you place the order. No online payment is collected now.
          </Callout>
        )}
        {reconfirmNotice ? (
          <div
            ref={reconfirmRef}
            tabIndex={-1}
            className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-action"
          >
            <Callout tone="warning" live="assertive" title="Order not placed — confirm new total">
              <p>{reconfirmNotice}</p>
            </Callout>
          </div>
        ) : null}
        {failure ? (
          <Callout tone="danger" live="assertive" title="Checkout not confirmed">
            <p>{failure.message}</p>
            {failure.checkStatus ? (
              <Link className="mt-2 inline-block text-action underline" href={statusHref}>
                Check order status
              </Link>
            ) : null}
          </Callout>
        ) : null}
        <Button type="submit" form={checkoutFormId} size="lg" loading={submitting} disabled={submitting}>
          {submitLabel}
        </Button>
      </div>

      <AgreementDialog
        open={agreementPrompt !== null}
        policyPublicId={agreementPrompt?.policyPublicId ?? ""}
        signatureMode={agreementPrompt?.signatureMode ?? "typed_name"}
        onClose={() => setAgreementPrompt(null)}
        onAccepted={async () => {
          const acceptedPolicyId = agreementPrompt?.policyPublicId;
          if (acceptedPolicyId) {
            setAcceptedAgreementPolicyIds((prev) =>
              prev.includes(acceptedPolicyId) ? prev : [...prev, acceptedPolicyId],
            );
          }
          setAgreementPrompt(null);
          request.current = null;
          await performCheckout(acceptedPolicyId);
        }}
      />
    </div>
  );
}

export function CheckoutPage() {
  const { pending, staffViewer } = useCartViewerGate();
  if (pending) {
    return (
      <div role="status" aria-label="Loading checkout">
        <Skeleton lines={5} />
      </div>
    );
  }
  if (staffViewer) {
    return <StaffOrderHandoff title="Checkout belongs to customer accounts" />;
  }
  return <CustomerCheckoutPage />;
}

function CustomerCheckoutPage() {
  const trpc = useTRPC();
  const [placedHandoff, setPlacedHandoff] = useState<PlacedPaymentHandoff | null>(null);
  const cart = useQuery(
    trpc.cart.get.queryOptions(undefined, {
      refetchOnMount: "always",
      enabled: placedHandoff === null,
    }),
  );

  const billingProfileGetProc = (
    trpc as unknown as {
      billingProfile?: {
        get?: {
          queryOptions: (
            input?: undefined,
            opts?: { refetchOnMount?: "always"; enabled?: boolean },
          ) => {
            queryKey: readonly unknown[];
            queryFn: () => Promise<SavedBillingProfileSnapshot | null>;
            refetchOnMount?: "always";
            enabled?: boolean;
          };
        };
      };
    }
  ).billingProfile?.get;

  const billingProfileQuery = useQuery(
    billingProfileGetProc
      ? billingProfileGetProc.queryOptions(undefined, {
          refetchOnMount: "always",
          enabled: placedHandoff === null,
        })
      : {
          queryKey: ["billingProfile.fallback"],
          queryFn: async () => null,
          enabled: placedHandoff === null,
        },
  );

  const data = cart.data;
  const savedProfile = billingProfileQuery.data ?? null;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Checkout"
        description="Review your order, billing information and payment options."
        actions={
          <Button asChild variant="secondary">
            <Link href="/cart">Back to cart</Link>
          </Button>
        }
      />
      {placedHandoff ? (
        <PlacedOrderPaymentHandoff handoff={placedHandoff} />
      ) : cart.isPending || billingProfileQuery.isPending ? (
        <div role="status" aria-label="Loading checkout">
          <Skeleton lines={5} />
        </div>
      ) : cart.isError || !data ? (
        <ErrorState
          title="Checkout could not be loaded"
          error={cart.error}
          onRetry={() => {
            void cart.refetch();
            void billingProfileQuery.refetch();
          }}
        />
      ) : !data.cartPublicId || !canCheckout(data) || !data.totals.currency ? (
        <EmptyState
          title="Review your cart before checking out"
          description="Checkout needs available items priced in the same currency without duplicate project packets."
          action={
            <Button asChild>
              <Link href="/cart">Review cart</Link>
            </Button>
          }
        />
      ) : (
        <CheckoutForm
          key={data.cartPublicId}
          cart={{ ...data, cartPublicId: data.cartPublicId }}
          savedProfile={savedProfile}
          reload={cart.refetch}
          reloadBillingProfile={billingProfileQuery.refetch}
          onPaymentHandoff={setPlacedHandoff}
        />
      )}
    </div>
  );
}

export default CheckoutPage;
