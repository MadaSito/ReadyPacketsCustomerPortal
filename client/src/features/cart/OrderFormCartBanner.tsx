/**
 * RouteWrapper for `/orders/new` enabling "Add packet + tier from the order form" when `feature.cart` is enabled.
 * Owner: recovery_ops_engineer (Increment 04, Package L).
 *
 * Accessibility & zero-coupling invariants:
 *  - Renders `children` unmodified (zero queries) while `feature.cart` is disabled.
 *  - Places its `<h2>` section AFTER `children` so the host page's `<h1>` stays first in DOM heading order.
 *  - Never imports from `@/features/orders`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { useFeatureEnabled } from "@/lib/features";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Button, buttonClasses, Callout, Card, Field, Input, Select, Section } from "@/ui";
import { useCartViewerGate } from "./viewerGate";

export function OrderFormCartBanner({ children }: { children: ReactNode }) {
  const { pending, staffViewer } = useCartViewerGate();
  const enabled = useFeatureEnabled("cart");
  if (!enabled || pending || staffViewer) return <>{children}</>;
  return (
    <div className="space-y-8">
      {children}
      <OrderFormQuickCartSection />
    </div>
  );
}

function OrderFormQuickCartSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const catalogQuery = useQuery(trpc.orders.catalog.list.queryOptions());
  const addMutation = useMutation(trpc.cart.addItems.mutationOptions());

  const [selectedProductId, setSelectedProductId] = useState("");
  const [quantityText, setQuantityText] = useState("1");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  const activeProducts = useMemo(() => {
    const groups = catalogQuery.data ?? [];
    const list: { publicId: string; label: string; isAddon: boolean }[] = [];
    for (const group of groups) {
      for (const product of group.products) {
        if (!product.active) continue;
        const tierSuffix = product.tier ? ` (${product.tier})` : "";
        list.push({
          publicId: product.publicId,
          label: `${group.name}: ${product.name}${tierSuffix}`,
          isAddon: group.packetNumber === null,
        });
      }
    }
    return list;
  }, [catalogQuery.data]);

  const selectedProduct = activeProducts.find((item) => item.publicId === selectedProductId) ?? null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProduct) return;
    const parsedQty = selectedProduct.isAddon ? Math.max(1, Math.min(20, Number.parseInt(quantityText, 10) || 1)) : 1;
    setErrorText(null);
    setStatusMessage("");
    try {
      const updated = await addMutation.mutateAsync({
        items: [{ productPublicId: selectedProduct.publicId, quantity: parsedQty }],
      });
      queryClient.setQueryData(trpc.cart.get.queryKey(), updated);
      await queryClient.invalidateQueries({ queryKey: trpc.cart.badgeCount.queryKey() });
      setStatusMessage(`Added to cart (${updated.itemCount} ${updated.itemCount === 1 ? "item" : "items"} in cart).`);
    } catch (err) {
      setErrorText(errorMessage(err, "Could not add the selected item to your cart."));
    }
  };

  return (
    <Section
      title="Save items to your cart"
      description="Want to combine packets or add-ons and review bundle pricing before checking out? Add items to your cart instead."
      headingLevel={2}
    >
      <Card>
        <div role="status" aria-live="polite" className="sr-only">
          {statusMessage}
        </div>
        {errorText ? (
          <Callout tone="danger" className="mb-4">
            {errorText}
          </Callout>
        ) : null}
        {statusMessage ? (
          <Callout tone="success" className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{statusMessage}</span>
              <Link href="/cart" className={buttonClasses("secondary", "sm")}>
                View cart
              </Link>
            </div>
          </Callout>
        ) : null}

        {activeProducts.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-body">Open your cart to review saved items and live server totals.</p>
            <Link href="/cart" className={buttonClasses("secondary", "md")}>
              <ShoppingCart aria-hidden="true" className="size-4" />
              Open cart
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <Field label="Packet tier or add-on" className="min-w-0 flex-1">
              <Select
                value={selectedProductId}
                placeholder="Select a packet tier or add-on…"
                options={activeProducts.map((item) => ({ value: item.publicId, label: item.label }))}
                onChange={(event) => {
                  setSelectedProductId(event.target.value);
                  setQuantityText("1");
                }}
                disabled={addMutation.isPending}
              />
            </Field>
            {selectedProduct?.isAddon ? (
              <Field label="Quantity" className="w-full sm:w-28">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  inputMode="numeric"
                  value={quantityText}
                  onChange={(event) => setQuantityText(event.target.value)}
                  disabled={addMutation.isPending}
                />
              </Field>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" loading={addMutation.isPending} disabled={!selectedProduct || addMutation.isPending}>
                Add to cart
              </Button>
              <Link href="/cart" className={buttonClasses("secondary", "md")}>
                Open cart
              </Link>
            </div>
          </form>
        )}
      </Card>
    </Section>
  );
}

export default OrderFormCartBanner;
