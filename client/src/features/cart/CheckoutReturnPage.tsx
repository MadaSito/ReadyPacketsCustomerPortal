import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { Link, useSearch } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, EmptyState, ErrorState, Money, PageHeader, Skeleton } from "@/ui";
import type { ReactNode } from "react";

export type CheckoutStatus = inferRouterOutputs<AppRouter>["cart"]["checkoutStatus"];
export type CheckoutTarget = { attemptPublicId: string } | { cartPublicId: string };
const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const maxStatusChecks = 30;

export function readCheckoutTarget(search: string): CheckoutTarget | null {
  const query = new URLSearchParams(search);
  const attempts = query.getAll("attempt");
  const carts = query.getAll("cart");
  if (attempts.length === 1 && carts.length === 0 && ulid.test(attempts[0]!)) return { attemptPublicId: attempts[0]! };
  if (carts.length === 1 && attempts.length === 0 && ulid.test(carts[0]!)) return { cartPublicId: carts[0]! };
  return null;
}

const stateCopy = {
  pending_confirmation: { title: "Waiting for payment confirmation", text: "Returning from checkout does not confirm payment. This page checks for confirmation automatically for a short time. Avoid submitting another payment while you wait.", tone: "info" },
  paid: { title: "Payment confirmed", text: "Your payment is recorded on your ReadyPackets invoice.", tone: "success" },
  no_payment_due: { title: "Nothing to pay — your discount covers this order.", text: "Your order is placed and your zero-balance invoice is settled. No payment was needed.", tone: "success" },
  invoice_issued: { title: "Order placed and invoice issued", text: "No online payment was collected. Open your invoice for the balance and payment instructions.", tone: "success" },
  cancelled: { title: "Checkout cancelled", text: "No payment is confirmed for this checkout. If you believe a charge was made, verify it before paying again.", tone: "warning" },
  failed: { title: "Payment could not be confirmed", text: "Check your invoice and verify any charge with the provider before trying again.", tone: "warning" },
} as const;

function CheckoutResult({ data, cancelRoute, actions }: { data: CheckoutStatus; cancelRoute: boolean; actions?: ReactNode }) {
  const waivedSmallTotal = data.paymentMode === "waived_small_total" || data.waivedMinor > 0;
  const state = waivedSmallTotal && (data.confirmationState === "no_payment_due" || data.confirmationState === "paid")
    ? {
        title: "Order placed — remaining balance waived",
        text: "Your remaining balance below the online payment minimum was waived automatically and your invoice is settled.",
        tone: "success" as const,
      }
    : stateCopy[data.confirmationState];
  const cancelledPending = cancelRoute && data.confirmationState === "pending_confirmation";
  return <div className="grid gap-4">
    <div aria-live="polite" aria-atomic="true">
      <Callout title={cancelledPending ? "Checkout was not completed in the browser" : state.title} tone={cancelledPending ? "warning" : state.tone}>
        {cancelledPending ? "This return page does not cancel a payment. Verify any possible charge before restoring items or paying again." : state.text}
      </Callout>
    </div>
    <Card title="Order and invoice">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="font-semibold">Order reference</dt><dd className="break-all">{data.orderReference}</dd></div>
        <div><dt className="font-semibold">Invoice number</dt><dd className="break-all">{data.invoiceNumber ?? "Not assigned"}</dd></div>
        <div><dt className="font-semibold">Order total</dt><dd><Money value={{ amountMinor: data.totalMinor, currency: data.currency }} /></dd></div>
        {data.waivedMinor > 0 ? (
          <div><dt className="font-semibold">Amount waived</dt><dd><Money value={{ amountMinor: data.waivedMinor, currency: data.currency }} /></dd></div>
        ) : null}
        <div><dt className="font-semibold">Invoice balance</dt><dd><Money value={{ amountMinor: data.balanceDueMinor, currency: data.currency }} /></dd></div>
      </dl>
      {data.confirmationState !== "cancelled" ? <div className="mt-4 flex flex-wrap gap-3">
        <Button asChild variant="secondary"><Link href={`/orders/${encodeURIComponent(data.orderPublicId)}`}>View order</Link></Button>
        <Button asChild variant="secondary"><Link href={`/invoices/${encodeURIComponent(data.invoicePublicId)}`}>View invoice</Link></Button>
      </div> : null}
    </Card>
    {actions}
  </div>;
}

function CheckoutStatusLoader({ target, cancelRoute, renderActions }: {
  target: CheckoutTarget;
  cancelRoute: boolean;
  renderActions?: ((data: CheckoutStatus, target: CheckoutTarget, onChanged: () => void) => ReactNode) | undefined;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = trpc.cart.checkoutStatus.queryOptions(target, {
    refetchOnMount: "always",
    refetchIntervalInBackground: false,
    refetchInterval: (query) => !cancelRoute && query.state.status === "success" &&
      query.state.data?.confirmationState === "pending_confirmation" && query.state.dataUpdateCount < maxStatusChecks ? 2500 : false,
  });
  const status = useQuery(options);
  const reload = () => { void status.refetch(); };
  const data = status.data;
  if (status.isPending) return <div role="status" aria-label="Checking checkout status"><Skeleton lines={5} /></div>;
  if (status.isError || !data) return <ErrorState title="Checkout status could not be confirmed" error={status.error} onRetry={reload} />;
  const checks = queryClient.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
  const pollingFinished = !cancelRoute && data.confirmationState === "pending_confirmation" && checks >= maxStatusChecks;
  return <CheckoutResult data={data} cancelRoute={cancelRoute} actions={<div className="grid gap-4">
    {renderActions?.(data, target, reload)}
    {pollingFinished ? <p role="status" className="text-sm text-muted">Automatic checks ended. You can check the payment status again at any time.</p> : null}
    {!cancelRoute && (data.confirmationState === "cancelled" || data.confirmationState === "failed" || pollingFinished) &&
      (data.canRestoreToCart || data.alreadyRestored) ? <div><Button asChild variant="secondary">
        <Link href={`/checkout/cancel?cart=${encodeURIComponent(data.cartPublicId)}`}>Review cart recovery</Link>
      </Button></div> : null}
    {data.confirmationState === "pending_confirmation" ? <div>
      <Button variant="secondary" onClick={reload} disabled={status.isFetching}>Check payment status</Button>
    </div> : null}
  </div>} />;
}

export function CheckoutStatusPage({ cancelRoute = false, renderActions }: {
  cancelRoute?: boolean;
  renderActions?: ((data: CheckoutStatus, target: CheckoutTarget, onChanged: () => void) => ReactNode) | undefined;
}) {
  const target = readCheckoutTarget(useSearch());
  return <div className="grid gap-6">
    <PageHeader title={cancelRoute ? "Checkout recovery" : "Checkout status"}
      description={cancelRoute ? "Check the current status before returning items to your cart." : "Follow your order and invoice after checkout."}
      actions={<Button asChild variant="secondary"><Link href="/cart">Back to cart</Link></Button>} />
    {target ? <CheckoutStatusLoader target={target} cancelRoute={cancelRoute} renderActions={renderActions} /> :
      <EmptyState title="Checkout reference unavailable" description="Open your orders or invoices to check the status of a recent checkout."
        action={<Button asChild><Link href="/orders">View orders</Link></Button>} />}
  </div>;
}

export function CheckoutReturnPage() { return <CheckoutStatusPage />; }

export default CheckoutReturnPage;
