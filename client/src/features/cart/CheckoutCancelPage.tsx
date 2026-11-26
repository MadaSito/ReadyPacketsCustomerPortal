import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, ConfirmDialog } from "@/ui";
import { CheckoutStatusPage, type CheckoutStatus, type CheckoutTarget } from "./CheckoutReturnPage";

function RestoreActions({ data, target, onChanged }: { data: CheckoutStatus; target: CheckoutTarget; onChanged: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const restore = useMutation(trpc.cart.restoreCheckout.mutationOptions());
  const [confirm, setConfirm] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string>();

  async function restoreCart() {
    setError(undefined);
    try {
      const result = await restore.mutateAsync(target);
      queryClient.setQueryData(trpc.cart.get.queryKey(), result.cart);
      void queryClient.invalidateQueries({ queryKey: trpc.cart.badgeCount.queryKey() });
      setRestored(result.restored || result.alreadyRestored);
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure, "Your cart could not be restored. Check checkout status before trying again."));
      if (safeError(failure)?.reasonCode === "CHECKOUT_ALREADY_PAID") onChanged();
      throw failure;
    }
  }

  if (data.confirmationState === "paid" || data.confirmationState === "no_payment_due" || data.confirmationState === "invoice_issued") return null;
  if (restored || data.alreadyRestored) return <Card title="Items restored">
    <p className="mb-4 text-sm text-muted">Review current prices and availability in your cart before you check out again.</p>
    <Button asChild><Link href="/cart">Open restored cart</Link></Button>
  </Card>;
  if (!data.canRestoreToCart) return null;
  const payNowIsPrimary =
    (data.confirmationState === "awaiting_payment" || data.confirmationState === "failed") &&
    data.invoiceStatus === "issued" &&
    data.balanceDueMinor > 0 &&
    data.onlinePaymentAvailable;
  return <Card title="Restore your cart" description="Restore items only if you no longer intend to complete this checkout.">
    {error ? <Callout title="Cart not restored" tone="danger" live="assertive">{error}</Callout> : null}
    <div className={error ? "mt-4" : undefined}>
      <Button variant={payNowIsPrimary ? "secondary" : "primary"} onClick={() => setConfirm(true)}>
        Restore items to cart
      </Button>
    </div>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Cancel checkout and restore items?"
      description="ReadyPackets will try to cancel the unpaid attempt and put its items back in your cart. This does not refund a provider charge."
      confirmLabel="Restore items" onConfirm={restoreCart} />
  </Card>;
}

export function CheckoutCancelPage() {
  return <CheckoutStatusPage cancelRoute renderActions={(data, target, onChanged) => (
    <RestoreActions key={data.cartPublicId} data={data} target={target} onChanged={onChanged} />
  )} />;
}

export default CheckoutCancelPage;
