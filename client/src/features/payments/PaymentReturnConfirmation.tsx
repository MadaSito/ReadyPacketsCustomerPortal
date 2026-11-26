import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Link } from "wouter";
import type { ConfirmCheckoutPaymentResult } from "@server/modules/payments/service";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, Skeleton } from "@/ui";

export const CONFIRM_BACKOFF_DELAYS_MS = [2_500, 5_000, 10_000, 20_000, 30_000] as const;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export interface PaymentReturnPaidInfo {
  orderPublicId: string;
  orderReference?: string | null;
  invoicePublicId: string;
  invoiceNumber?: string | null;
  receiptPublicId: string | null;
  continueHref: string;
}

export interface PaymentReturnConfirmationProps {
  attemptPublicId: string;
  cartPublicId?: string | null;
  orderReference?: string | null;
  onPaid?: (info: PaymentReturnPaidInfo) => void;
  extraActions?: ReactNode;
}

export function PaymentReturnConfirmation(props: PaymentReturnConfirmationProps): JSX.Element {
  const normalizedAttemptId = props.attemptPublicId.trim();
  if (!ULID_RE.test(normalizedAttemptId)) {
    return (
      <div
        data-testid="payment-return-confirmation"
        data-payment-return-state="invalid"
        className="grid min-w-0 gap-4"
      >
        <Callout tone="warning" title="Missing payment confirmation reference">
          <p className="[overflow-wrap:anywhere]">
            This return address did not include a valid checkout reference. Open your orders or invoices to review your current payment status.
          </p>
        </Callout>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link href="/orders">Go to orders</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/invoices">View invoices</Link>
          </Button>
          {props.extraActions}
        </div>
      </div>
    );
  }

  return (
    <PaymentReturnConfirmationActive
      key={normalizedAttemptId}
      normalizedAttemptId={normalizedAttemptId}
      orderReferenceProp={props.orderReference}
      onPaid={props.onPaid}
      extraActions={props.extraActions}
    />
  );
}

function PaymentReturnConfirmationActive({
  normalizedAttemptId,
  orderReferenceProp,
  onPaid,
  extraActions,
}: {
  normalizedAttemptId: string;
  orderReferenceProp?: string | null | undefined;
  onPaid?: ((info: PaymentReturnPaidInfo) => void) | undefined;
  extraActions?: ReactNode | undefined;
}): JSX.Element {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [result, setResult] = useState<ConfirmCheckoutPaymentResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [autoChecksCompleted, setAutoChecksCompleted] = useState(0);

  const paidNotifiedRef = useRef(false);
  const initialStartedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onPaidRef = useRef(onPaid);

  const confirmMutation = useMutation(trpc.payments.confirmCheckoutPayment.mutationOptions());
  const mutateAsyncRef = useRef(confirmMutation.mutateAsync);

  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);

  useEffect(() => {
    mutateAsyncRef.current = confirmMutation.mutateAsync;
  }, [confirmMutation.mutateAsync]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const notifyPaidIfNeeded = useCallback(
    async (data: ConfirmCheckoutPaymentResult) => {
      if (data.state !== "paid") return;
      if (paidNotifiedRef.current) return;
      paidNotifiedRef.current = true;

      const continueHref = `/orders/${encodeURIComponent(data.orderPublicId)}`;
      const invalidations: Array<Promise<unknown>> = [];
      if (typeof trpc.cart?.pathKey === "function") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: trpc.cart.pathKey() }));
      }
      if (typeof trpc.orders?.pathKey === "function") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() }));
      }
      if (typeof trpc.compliance?.pathKey === "function") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: trpc.compliance.pathKey() }));
      }
      if (typeof trpc.payments?.pathKey === "function") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: trpc.payments.pathKey() }));
      }
      await Promise.all(invalidations);
      onPaidRef.current?.({
        orderPublicId: data.orderPublicId,
        orderReference: data.orderReference ?? orderReferenceProp ?? null,
        invoicePublicId: data.invoicePublicId,
        invoiceNumber: data.invoiceNumber,
        receiptPublicId: data.receiptPublicId,
        continueHref,
      });
    },
    [orderReferenceProp, queryClient, trpc],
  );

  const runConfirmationCheck = useCallback(
    async (resetBackoff: boolean) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (resetBackoff) {
        setAutoChecksCompleted(0);
      }
      setCheckError(null);
      try {
        const next = await mutateAsyncRef.current({ attemptPublicId: normalizedAttemptId });
        if (!mountedRef.current) return;
        setResult(next);
        if (next.state === "paid") {
          await notifyPaidIfNeeded(next);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setCheckError(errorMessage(err));
      }
    },
    [normalizedAttemptId, notifyPaidIfNeeded],
  );

  useEffect(() => {
    if (initialStartedRef.current) return;
    initialStartedRef.current = true;
    const t = setTimeout(() => {
      void runConfirmationCheck(false);
    }, 0);
    return () => {
      clearTimeout(t);
    };
  }, [runConfirmationCheck]);

  useEffect(() => {
    if (confirmMutation.isPending) return;
    if (!result && !checkError) return;
    if (result && result.state !== "processing") return;
    if (autoChecksCompleted >= CONFIRM_BACKOFF_DELAYS_MS.length) return;

    const baseDelay = CONFIRM_BACKOFF_DELAYS_MS[autoChecksCompleted] ?? 30_000;
    const cooldownDelay = result?.cooldownRemainingMs ?? 0;
    const waitMs = Math.max(baseDelay, cooldownDelay);

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!mountedRef.current) return;
      setAutoChecksCompleted((n) => n + 1);
      void runConfirmationCheck(false);
    }, waitMs);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [autoChecksCompleted, checkError, confirmMutation.isPending, result, runConfirmationCheck]);

  const uiState: "paid" | "processing" | "unpaid" = result?.state ?? "processing";
  const autoRecheckExhausted =
    uiState === "processing" &&
    !confirmMutation.isPending &&
    autoChecksCompleted >= CONFIRM_BACKOFF_DELAYS_MS.length;
  const effectiveOrderRef = result?.orderReference ?? orderReferenceProp ?? null;
  const continueHref = result ? `/orders/${encodeURIComponent(result.orderPublicId)}` : null;
  const invoiceHref = result ? `/invoices/${encodeURIComponent(result.invoicePublicId)}` : null;
  const receiptHref =
    result?.receiptPublicId ? `/receipts/${encodeURIComponent(result.receiptPublicId)}` : null;

  return (
    <div
      data-testid="payment-return-confirmation"
      data-payment-return-state={uiState}
      className="grid min-w-0 gap-4"
    >
      <div aria-live="polite" aria-atomic="true">
        {uiState === "paid" ? (
          <Callout
            tone="success"
            title={
              <span className="inline-flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                Payment received
              </span>
            }
          >
            <p className="[overflow-wrap:anywhere]">
              Your payment has been verified with the payment provider and recorded on your ReadyPackets invoice.
            </p>
          </Callout>
        ) : uiState === "unpaid" ? (
          <Callout tone="warning" title="Payment not completed yet">
            <p className="[overflow-wrap:anywhere]">
              No payment has been confirmed for this checkout session. Open your invoice to review the balance due or start a new payment session, and verify any possible charge with your bank or card issuer before submitting another payment.
            </p>
          </Callout>
        ) : (
          <Callout
            tone="info"
            title={
              <span className="inline-flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
                <Clock className="size-4 shrink-0" aria-hidden />
                Confirming your payment with the payment provider
              </span>
            }
          >
            <div className="grid min-w-0 gap-2 [overflow-wrap:anywhere]">
              <p className="[overflow-wrap:anywhere]">
                Returning to ReadyPackets does not confirm payment on its own. We are checking directly with the payment provider and updating this page automatically. Avoid submitting another payment while confirmation is in progress.
              </p>
              {autoRecheckExhausted ? (
                <p className="[overflow-wrap:anywhere]">
                  Your payment is still settling with the provider (bank debits and asynchronous payment methods can take additional time). You can check again below at any moment or continue directly to your order while settlement completes in the background.
                </p>
              ) : null}
            </div>
          </Callout>
        )}
      </div>

      {!result && !checkError ? (
        <Card title="Checking payment status">
          <div role="status" aria-label="Verifying payment status with provider">
            <Skeleton lines={3} />
          </div>
        </Card>
      ) : null}

      {checkError ? (
        <Callout tone="warning" live="polite" title="Temporary delay reaching payment confirmation">
          <p className="[overflow-wrap:anywhere]">
            {checkError} Your order is safe and we have not marked your payment unsuccessful. Select Check payment status to try again, or continue to your order.
          </p>
        </Callout>
      ) : null}

      {result ? (
        <Card title="Order and payment summary">
          <dl className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {effectiveOrderRef ? (
              <div className="min-w-0">
                <dt className="font-semibold">Order reference</dt>
                <dd className="break-all [overflow-wrap:anywhere]">{effectiveOrderRef}</dd>
              </div>
            ) : null}
            <div className="min-w-0">
              <dt className="font-semibold">Invoice number</dt>
              <dd className="break-all [overflow-wrap:anywhere]">
                {result.invoiceNumber ?? result.invoicePublicId}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold">Confirmation status</dt>
              <dd className="[overflow-wrap:anywhere]">
                {uiState === "paid"
                  ? "Confirmed and booked"
                  : uiState === "unpaid"
                    ? "Not paid yet"
                    : "Awaiting provider confirmation"}
              </dd>
            </div>
            {uiState === "paid" && result.receiptPublicId ? (
              <div className="min-w-0">
                <dt className="font-semibold">Payment receipt</dt>
                <dd className="font-mono text-xs break-all [overflow-wrap:anywhere]">
                  {result.receiptPublicId}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {uiState === "paid" && continueHref ? (
              <Button asChild>
                <Link href={continueHref}>Continue to your order</Link>
              </Button>
            ) : null}

            {uiState !== "paid" ? (
              <Button
                variant={autoRecheckExhausted ? "secondary" : "primary"}
                leadingIcon={<RefreshCw aria-hidden />}
                loading={confirmMutation.isPending}
                onClick={() => {
                  void runConfirmationCheck(true);
                }}
              >
                Check payment status
              </Button>
            ) : null}

            {uiState !== "paid" && continueHref ? (
              <Button asChild variant={autoRecheckExhausted ? "primary" : "secondary"}>
                <Link href={continueHref}>Continue to your order</Link>
              </Button>
            ) : null}

            {receiptHref ? (
              <Button asChild variant="secondary">
                <Link href={receiptHref}>View receipt</Link>
              </Button>
            ) : null}

            {invoiceHref ? (
              <Button asChild variant="secondary">
                <Link href={invoiceHref}>Open invoice</Link>
              </Button>
            ) : null}

            {extraActions}
          </div>
        </Card>
      ) : checkError ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            leadingIcon={<RefreshCw aria-hidden />}
            loading={confirmMutation.isPending}
            onClick={() => {
              void runConfirmationCheck(true);
            }}
          >
            Check payment status
          </Button>
          <Button asChild variant="secondary">
            <Link href="/orders">Go to orders</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/invoices">View invoices</Link>
          </Button>
          {extraActions}
        </div>
      ) : null}
    </div>
  );
}
