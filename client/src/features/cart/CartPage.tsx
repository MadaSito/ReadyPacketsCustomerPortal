/**
 * Customer cart (/cart). Prices, discounts, upsells, and tax always come from the server (`cart.get`);
 * the page only sends product/offer ids, quantities, promo codes, and the cart version it last saw.
 * A STALE_VERSION conflict refetches the cart and announces the refresh politely instead of overwriting
 * changes made in another tab.
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Trash2 } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { PromoCodeField } from "@/features/promotions/PromoCodeField";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  buttonClasses,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Money,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "@/ui";
import { CartUpsellSection } from "./CartUpsellSection";

export type CartViewData = inferRouterOutputs<AppRouter>["cart"]["get"];
type CartLine = CartViewData["items"][number];

export const STALE_MESSAGE = "Your cart changed in another tab or window. We refreshed it. Review it and try again.";
const SUMMARY_FALLBACK_FOCUS_ID = "cart-summary-focus";
const EMPTY_CART_FALLBACK_FOCUS_ID = "cart-empty-focus";

/** Checkout is offered only for a non-empty, single-currency cart whose items are all still available. */
export function canCheckout(cart: Pick<CartViewData, "items" | "hasUnavailableItems" | "mixedCurrency">): boolean {
  return cart.items.length > 0 && !cart.hasUnavailableItems && !cart.mixedCurrency;
}

function money(amountMinor: number, currency: string | null) {
  return currency ? <Money value={{ amountMinor, currency }} /> : <span className="text-muted">—</span>;
}

export function CartPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const cartQuery = useQuery(trpc.cart.get.queryOptions());
  const catalog = useQuery(trpc.orders.catalog.list.queryOptions());
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const removeButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const cart = cartQuery.data;
  const cartKey = trpc.cart.get.queryKey();

  const onSuccess = async (view: CartViewData, message: string): Promise<CartViewData> => {
    queryClient.setQueryData(cartKey, view);
    await queryClient.invalidateQueries({ queryKey: trpc.cart.badgeCount.queryKey() });
    setError(null);
    if (message) setAnnouncement(message);
    return view;
  };
  const onError = async (err: unknown) => {
    if (safeError(err)?.reasonCode === "STALE_VERSION") {
      await queryClient.invalidateQueries({ queryKey: cartKey });
      setError(null);
      setAnnouncement(STALE_MESSAGE);
      return;
    }
    setError(errorMessage(err, "We could not update your cart. Please try again."));
  };

  const update = useMutation(trpc.cart.updateItem.mutationOptions());
  const remove = useMutation(trpc.cart.removeItem.mutationOptions());
  const clear = useMutation(trpc.cart.clear.mutationOptions());
  const add = useMutation(trpc.cart.addItems.mutationOptions());
  const save = useMutation(trpc.cart.saveDraftDetails.mutationOptions());
  const applyPromo = useMutation(trpc.cart.applyCode.mutationOptions());
  const removePromo = useMutation(trpc.cart.removeCode.mutationOptions());
  const acceptUpsell = useMutation(trpc.cart.upsell.accept.mutationOptions());
  const dismissUpsell = useMutation(trpc.cart.upsell.dismiss.mutationOptions());

  const busy =
    update.isPending ||
    remove.isPending ||
    clear.isPending ||
    add.isPending ||
    save.isPending ||
    applyPromo.isPending ||
    removePromo.isPending ||
    acceptUpsell.isPending ||
    dismissUpsell.isPending;

  const run = async (fn: () => Promise<CartViewData>, message: string): Promise<CartViewData | undefined> => {
    try {
      return await onSuccess(await fn(), message);
    } catch (err) {
      await onError(err);
      return undefined;
    }
  };

  const itemsListRef = useRef<HTMLUListElement>(null);

  const handleRemoveLine = async (line: CartLine, index: number, expectedVersion: number) => {
    const triggerBtn = removeButtonRefs.current.get(line.itemPublicId);
    const wasFocused = document.activeElement === triggerBtn;
    const next = await run(
      () => remove.mutateAsync({ itemPublicId: line.itemPublicId, expectedVersion }),
      `${line.name} removed from cart.`,
    );
    const focusRemainedInList = () => {
      const active = document.activeElement;
      return !active || active === document.body || Boolean(itemsListRef.current?.contains(active));
    };
    if (!wasFocused || !focusRemainedInList()) return;
    requestAnimationFrame(() => {
      if (!focusRemainedInList()) return;
      if (!next) {
        removeButtonRefs.current.get(line.itemPublicId)?.focus();
        return;
      }
      if (next.items.length > 0) {
        const nextLine = next.items[Math.min(index, next.items.length - 1)];
        const btn = nextLine ? removeButtonRefs.current.get(nextLine.itemPublicId) : undefined;
        if (btn) {
          btn.focus();
          return;
        }
      }
      document.getElementById(EMPTY_CART_FALLBACK_FOCUS_ID)?.focus();
    });
  };

  const handleApplyPromoCode = async (code: string) => {
    const next = await applyPromo.mutateAsync({
      code,
      idempotencyKey: `cart-promo:${crypto.randomUUID()}`,
    });
    await onSuccess(next, "");
  };

  const handleRemovePromoCode = async () => {
    if (!cart) return;
    try {
      const next = await removePromo.mutateAsync({ expectedVersion: cart.version });
      await onSuccess(next, "");
    } catch (err) {
      if (safeError(err)?.reasonCode === "STALE_VERSION") {
        await queryClient.invalidateQueries({ queryKey: cartKey });
        setError(null);
        setAnnouncement(STALE_MESSAGE);
      }
      throw err;
    }
  };

  const products = useMemo(
    () => (catalog.data ?? []).flatMap((group) => group.products.filter((p) => p.active).map((p) => ({ ...p, groupName: group.name }))),
    [catalog.data],
  );

  const showUpsells = Boolean(
    cart && cart.items.length > 0 && !cart.hasUnavailableItems && !cart.mixedCurrency && cart.upsells.length > 0,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Cart" description="Review your packets and add-ons. Prices, discounts and tax are recalculated by ReadyPackets each time the cart changes." />
      <p role="status" aria-live="polite" className={announcement ? "text-sm text-muted" : "sr-only"}>
        {announcement}
      </p>
      {error ? <Callout tone="danger" title="Cart not updated">{error}</Callout> : null}

      {cartQuery.isPending ? (
        <div role="status" aria-label="Loading cart" className="grid gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : cartQuery.isError || !cart ? (
        <ErrorState title="Your cart could not be loaded" error={cartQuery.error} onRetry={() => void cartQuery.refetch()} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
          <div className="flex min-w-0 flex-col gap-6">
            {cart.items.length === 0 ? (
              <div id={EMPTY_CART_FALLBACK_FOCUS_ID} tabIndex={-1} className="outline-none">
                <EmptyState
                  icon={ShoppingCart}
                  title="Your cart is empty"
                  description="Choose packets on Create an order, or add an item below."
                  action={
                    <Link href="/orders/new" className={buttonClasses("primary", "md")}>
                      Create an order
                    </Link>
                  }
                />
              </div>
            ) : (
              <Card
                title="Items"
                description={`${cart.itemCount} ${cart.itemCount === 1 ? "item" : "items"}`}
                actions={
                  <Button variant="secondary" size="sm" onClick={() => setConfirmClear(true)} disabled={busy}>
                    Empty cart
                  </Button>
                }
              >
                <ul ref={itemsListRef} className="flex flex-col divide-y divide-line">
                  {cart.items.map((line, index) => (
                    <CartLineRow
                      key={`${line.itemPublicId}:${line.quantity}`}
                      line={line}
                      busy={busy}
                      removeButtonRef={(node) => {
                        if (node) removeButtonRefs.current.set(line.itemPublicId, node);
                        else removeButtonRefs.current.delete(line.itemPublicId);
                      }}
                      tierOptions={line.packetNumber === null ? [] : products.filter((p) => p.packetNumber === line.packetNumber && p.tier)}
                      onTier={(productPublicId) =>
                        void run(
                          () => update.mutateAsync({ itemPublicId: line.itemPublicId, expectedVersion: cart.version, productPublicId }),
                          `${line.name} tier updated.`,
                        )
                      }
                      onQuantity={(quantity) =>
                        void run(
                          () => update.mutateAsync({ itemPublicId: line.itemPublicId, expectedVersion: cart.version, quantity }),
                          `${line.name} quantity updated to ${quantity}.`,
                        )
                      }
                      onRemove={() => void handleRemoveLine(line, index, cart.version)}
                    />
                  ))}
                </ul>
              </Card>
            )}

            {showUpsells ? (
              <CartUpsellSection
                upsells={cart.upsells}
                busy={busy}
                summaryFallbackFocusId={SUMMARY_FALLBACK_FOCUS_ID}
                onAccept={(item) =>
                  run(
                    () =>
                      acceptUpsell.mutateAsync({
                        offerPublicId: item.offerPublicId,
                        idempotencyKey: `upsell-accept:${crypto.randomUUID()}`,
                      }),
                    `${item.title} applied to your cart.`,
                  )
                }
                onDismiss={(item) =>
                  run(
                    () => dismissUpsell.mutateAsync({ offerPublicId: item.offerPublicId }),
                    `Dismissed suggestion: ${item.title}.`,
                  )
                }
              />
            ) : null}

            <AddItemCard
              products={products}
              loading={catalog.isPending}
              failed={catalog.isError}
              busy={busy}
              onAdd={(productPublicId, quantity) => void run(() => add.mutateAsync({ items: [{ productPublicId, quantity }] }), "Item added to cart.")}
            />

            <DraftDetailsCard
              key={`${cart.cartPublicId ?? "none"}:${cart.version}`}
              projectName={cart.projectName}
              note={cart.note}
              busy={busy}
              disabled={cart.cartPublicId === null}
              onSave={(projectName, note) =>
                void run(() => save.mutateAsync({ expectedVersion: cart.version, projectName, note }), "Project details saved.").then((res) => {
                  if (res) toast.show({ tone: "success", title: "Project details saved" });
                })
              }
            />
          </div>

          <SummaryCard
            cart={cart}
            busy={busy}
            onApplyPromo={handleApplyPromoCode}
            onRemovePromo={handleRemovePromoCode}
            onAnnounce={setAnnouncement}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Empty your cart?"
        description="All items are removed. Your project name and note are kept."
        confirmLabel="Empty cart"
        destructive
        onConfirm={async () => {
          if (!cart) return;
          await run(() => clear.mutateAsync({ expectedVersion: cart.version }), "Cart emptied.");
        }}
      />
    </div>
  );
}

function CartLineRow({
  line,
  busy,
  removeButtonRef,
  tierOptions,
  onTier,
  onQuantity,
  onRemove,
}: {
  line: CartLine;
  busy: boolean;
  removeButtonRef: (node: HTMLButtonElement | null) => void;
  tierOptions: readonly { publicId: string; tier: string | null; name: string }[];
  onTier: (productPublicId: string) => void;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  const [quantity, setQuantity] = useState(String(line.quantity));
  const parsed = Number(quantity);
  const validQuantity = Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000;
  const submitQuantity = (event: FormEvent) => {
    event.preventDefault();
    if (validQuantity && parsed !== line.quantity) onQuantity(parsed);
  };
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink break-words">{line.name}</p>
        {line.outcome ? <p className="text-sm text-muted break-words">{line.outcome}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          {line.packetNumber !== null ? <span>Packet {line.packetNumber}</span> : null}
          {line.timeline ? <span>{line.timeline}</span> : null}
          {!line.available ? <Badge tone="warning">No longer available</Badge> : null}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {line.packetNumber !== null && tierOptions.length > 1 ? (
            <Field label={<>Tier<span className="sr-only"> for {line.name}</span></>} className="w-full sm:w-48">
              <Select
                value={tierOptions.find((option) => option.tier === line.tier)?.publicId ?? line.productPublicId}
                options={tierOptions.map((option) => ({ value: option.publicId, label: option.tier ?? option.name }))}
                onChange={(event) => onTier(event.target.value)}
                disabled={busy}
              />
            </Field>
          ) : null}
          {line.packetNumber === null ? (
            <form onSubmit={submitQuantity} className="flex items-end gap-2">
              <Field label={<>Quantity<span className="sr-only"> for {line.name}</span></>} error={validQuantity ? undefined : "Enter a whole number from 1 to 1000."} className="w-28">
                <Input type="number" inputMode="numeric" min={1} max={1000} step={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={busy} />
              </Field>
              <Button type="submit" variant="secondary" size="md" disabled={busy || !validQuantity || parsed === line.quantity}>
                Update
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
        <div className="text-right">
          <p className="font-semibold text-ink">{money(line.lineTotalMinor, line.currency)}</p>
          {line.quantity > 1 ? (
            <p className="text-xs text-muted">
              {line.quantity} × {money(line.unitPriceMinor, line.currency)}
            </p>
          ) : null}
        </div>
        <Button
          ref={removeButtonRef}
          variant="ghost"
          size="md"
          leadingIcon={<Trash2 aria-hidden="true" />}
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${line.name}`}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

function AddItemCard({
  products,
  loading,
  failed,
  busy,
  onAdd,
}: {
  products: readonly { publicId: string; name: string; groupName: string; packetNumber: number | null; priceMinor: number; currency: string }[];
  loading: boolean;
  failed: boolean;
  busy: boolean;
  onAdd: (productPublicId: string, quantity: number) => void;
}) {
  const [productId, setProductId] = useState("");
  const selected = products.find((p) => p.publicId === productId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected) onAdd(selected.publicId, 1);
  };
  return (
    <Card title="Add a packet or add-on" description="Adding a packet tier replaces any other tier of the same packet.">
      {loading ? (
        <Skeleton className="h-11" />
      ) : failed ? (
        <Callout tone="warning">The catalog could not be loaded. You can still review and check out your cart.</Callout>
      ) : products.length === 0 ? (
        <p className="text-sm text-muted">No products are available right now.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Product" className="min-w-0 flex-1">
            <Select
              value={productId}
              placeholder="Choose a product…"
              options={products.map((p) => ({ value: p.publicId, label: `${p.groupName}: ${p.name}` }))}
              onChange={(event) => setProductId(event.target.value)}
              disabled={busy}
            />
          </Field>
          <Button type="submit" disabled={busy || !selected}>
            Add to cart
          </Button>
        </form>
      )}
    </Card>
  );
}

function DraftDetailsCard({
  projectName,
  note,
  busy,
  disabled,
  onSave,
}: {
  projectName: string;
  note: string;
  busy: boolean;
  disabled: boolean;
  onSave: (projectName: string, note: string) => void;
}) {
  const [name, setName] = useState(projectName);
  const [text, setText] = useState(note);
  const changed = name !== projectName || text !== note;
  return (
    <Card title="Project details" description="Saved with your cart and used at checkout.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) onSave(name.trim(), text);
        }}
      >
        <Field label="Project name">
          <Input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} disabled={busy || disabled} autoComplete="off" />
        </Field>
        <Field label="Note for the ReadyPackets team" hint="Optional. Do not include passwords or payment card details.">
          <Textarea value={text} maxLength={4000} rows={4} onChange={(event) => setText(event.target.value)} disabled={busy || disabled} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" disabled={busy || disabled || !changed}>
            Save details
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SummaryCard({
  cart,
  busy,
  onApplyPromo,
  onRemovePromo,
  onAnnounce,
}: {
  cart: CartViewData;
  busy: boolean;
  onApplyPromo: (code: string) => Promise<void>;
  onRemovePromo: () => Promise<void>;
  onAnnounce: (message: string) => void;
}) {
  const { totals } = cart;
  const ready = canCheckout(cart);
  const showPromoField =
    cart.items.length > 0 &&
    !cart.mixedCurrency &&
    Boolean(totals.currency) &&
    (cart.promotionsEnabled || totals.promo !== null || cart.promoNotice !== null);

  const appliedPromo =
    totals.promo && totals.currency
      ? {
          label: totals.promo.label,
          discountMinor: totals.promo.promoDiscountMinor,
          currency: totals.currency,
        }
      : null;

  return (
    <div id={SUMMARY_FALLBACK_FOCUS_ID} tabIndex={-1} className="h-max rounded-[var(--radius-card)] outline-none focus-visible:ring-2 focus-visible:ring-action lg:sticky lg:top-20">
      <Card title="Summary">
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
          <dt className="min-w-0 break-words text-muted">Subtotal</dt>
          <dd className="text-right text-ink">{money(totals.subtotalMinor, totals.currency)}</dd>
          {totals.discountMinor > 0 ? (
            <>
              <dt className="min-w-0 break-words text-muted">{totals.discountLabel ?? "Discount"}</dt>
              <dd className="text-right text-success">−{money(totals.discountMinor, totals.currency)}</dd>
            </>
          ) : null}
          <dt className="min-w-0 break-words text-muted">Tax{totals.taxRateBps > 0 ? ` (${(totals.taxRateBps / 100).toFixed(2)}%)` : ""}</dt>
          <dd className="text-right text-ink">{money(totals.taxMinor, totals.currency)}</dd>
          <dt className="border-t border-line pt-2 font-semibold text-ink">Total</dt>
          <dd className="border-t border-line pt-2 text-right font-semibold text-ink">{money(totals.totalMinor, totals.currency)}</dd>
        </dl>

        {showPromoField ? (
          <div className="mt-4 border-t border-line pt-4">
            <PromoCodeField
              applied={appliedPromo}
              onApply={onApplyPromo}
              onRemove={onRemovePromo}
              disabled={busy}
              onAnnounce={onAnnounce}
            />
            {totals.promo && totals.promo.promoDiscountMinor === 0 && totals.promo.bundleDiscountMinor > 0 ? (
              <p className="mt-2 text-xs text-muted">
                Your bundle discount saves more and is applied automatically.
              </p>
            ) : null}
          </div>
        ) : null}

        {cart.promoNotice ? (
          <Callout tone="warning" className="mt-4" title="Discount code not currently applied">
            <p>{cart.promoNotice.message}</p>
            <div className="mt-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onRemovePromo()}>
                Clear code
              </Button>
            </div>
          </Callout>
        ) : null}

        {totals.bundle && !totals.bundle.applied && totals.bundle.missingPacketNumbers.length > 0 ? (
          <Callout tone="info" className="mt-4" title={totals.bundle.label}>
            Add packet{totals.bundle.missingPacketNumbers.length === 1 ? "" : "s"} {totals.bundle.missingPacketNumbers.join(", ")} to save {totals.bundle.discountPercent}%.
          </Callout>
        ) : null}
        {cart.hasUnavailableItems ? (
          <Callout tone="warning" className="mt-4">
            Remove items that are no longer available before checking out.
          </Callout>
        ) : null}
        {cart.mixedCurrency ? (
          <Callout tone="warning" className="mt-4">
            Your cart has items in more than one currency. Keep items in one currency to check out.
          </Callout>
        ) : null}
        <div className="mt-4">
          {ready ? (
            <Link href="/cart/checkout" className={buttonClasses("primary", "lg", "w-full")}>
              Continue to checkout
            </Link>
          ) : (
            <p className="text-sm text-muted">{cart.items.length === 0 ? "Add an item to check out." : "Checkout is available once the issues above are resolved."}</p>
          )}
        </div>
      </Card>
    </div>
  );
}

export default CartPage;
