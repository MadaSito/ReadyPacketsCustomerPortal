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
import { Link, useSearch } from "wouter";
import { useFeatureEnabled } from "@/lib/features";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Button, buttonClasses, Callout, Card, Field, Input, Select, Section } from "@/ui";
import { useCartViewerGate } from "./viewerGate";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function readAddToParam(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("addTo")?.trim() ?? "";
  return ULID_PATTERN.test(raw) ? raw : null;
}

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
  const search = useSearch();
  const addToParam = readAddToParam(search);

  const catalogQuery = useQuery(trpc.orders.catalog.list.queryOptions());
  const cartQuery = useQuery(trpc.cart.get.queryOptions());
  const addMutation = useMutation(trpc.cart.addItems.mutationOptions());
  const setTargetMutation = useMutation(trpc.cart.setTarget.mutationOptions());

  const [selectedProductId, setSelectedProductId] = useState("");
  const [quantityText, setQuantityText] = useState("1");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  const activeAddToOrder = cartQuery.data?.addToOrder ?? null;
  const excludedPackets = useMemo(
    () => new Set(activeAddToOrder?.packetNumbers ?? []),
    [activeAddToOrder?.packetNumbers],
  );

  const activeProducts = useMemo(() => {
    const groups = catalogQuery.data ?? [];
    const list: { publicId: string; label: string; isAddon: boolean }[] = [];
    for (const group of groups) {
      for (const product of group.products) {
        if (!product.active) continue;
        if (product.packetNumber !== null && excludedPackets.has(product.packetNumber)) continue;
        const tierSuffix = product.tier ? ` (${product.tier})` : "";
        list.push({
          publicId: product.publicId,
          label: `${group.name}: ${product.name}${tierSuffix}`,
          isAddon: group.packetNumber === null,
        });
      }
    }
    return list;
  }, [catalogQuery.data, excludedPackets]);

  const selectedProduct = activeProducts.find((item) => item.publicId === selectedProductId) ?? null;
  const busy = addMutation.isPending || setTargetMutation.isPending;

  const handleClearTarget = async () => {
    setErrorText(null);
    setStatusMessage("");
    try {
      const updated = await setTargetMutation.mutateAsync({
        addToOrderPublicId: null,
        ...(cartQuery.data?.cartPublicId ? { expectedVersion: cartQuery.data.version } : {}),
      });
      queryClient.setQueryData(trpc.cart.get.queryKey(), updated);
      setStatusMessage("Switched your cart to start a separate project.");
    } catch (err) {
      setErrorText(errorMessage(err, "Could not update your cart project target."));
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProduct) return;
    const parsedQty = selectedProduct.isAddon ? Math.max(1, Math.min(20, Number.parseInt(quantityText, 10) || 1)) : 1;
    setErrorText(null);
    setStatusMessage("");
    try {
      const updated = await addMutation.mutateAsync({
        items: [{ productPublicId: selectedProduct.publicId, quantity: parsedQty }],
        addToOrderPublicId: addToParam,
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
        {!addToParam && activeAddToOrder ? (
          <Callout tone="info" className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 break-words">
                {activeAddToOrder.projectName && activeAddToOrder.rootReference
                  ? `Your open cart is currently adding to project ${activeAddToOrder.projectName} (${activeAddToOrder.rootReference}).`
                  : "Your open cart is currently linked to an earlier project."}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={setTargetMutation.isPending}
                disabled={busy}
                onClick={() => void handleClearTarget()}
              >
                Start a separate project
              </Button>
            </div>
          </Callout>
        ) : null}
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
                disabled={busy}
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
                  disabled={busy}
                />
              </Field>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" loading={addMutation.isPending} disabled={!selectedProduct || busy}>
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
