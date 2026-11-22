/**
 * Customer cart upsell suggestions section (Increment 05, Package B, Decision D2 / ADR 0043).
 *
 * Accessibility & anti-dark-pattern invariants:
 *  - Rendered only on `/cart` when `cart.upsells.length > 0` and the cart has no blocking errors.
 *  - Never rendered on checkout, payment, or policy acceptance screens.
 *  - Plain text only; zero countdown timers, pre-ticked checkboxes, auto-adds, or confirm-shaming labels.
 *  - WCAG 2.5.3 Label in Name: every button's `aria-label` begins with its exact visible label (`"Add to cart"`
 *    or `"Upgrade"`) followed by the target item(s) and live server price.
 *  - WCAG 2.4.3 Focus Order: keyboard focus moves deterministically ONLY if focus was inside the trigger
 *    before the mutation started and the user did not tab away to another control while awaiting completion;
 *    if a mutation fails while the button was temporarily disabled, focus is restored to that trigger button.
 */
import { Sparkles, X } from "lucide-react";
import { useId, useRef } from "react";
import { Badge, Button, Card, Money } from "@/ui";
import type { CartViewData } from "./CartPage";

export type CartUpsellItem = CartViewData["upsells"][number];

function formatPlainCurrency(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

export function buildUpsellActionAccessibleName(item: CartUpsellItem): string {
  const names = item.targetProducts.map((p) => p.name).join(" and ");
  const priceText = formatPlainCurrency(item.priceMinor, item.currency);
  if (item.kind === "tier_upgrade") {
    return `Upgrade: ${names} for +${priceText}`;
  }
  if (item.kind === "bundle_completion" && item.savingMinor && item.savingMinor > 0) {
    const savingText = formatPlainCurrency(item.savingMinor, item.currency);
    return `Add to cart: ${names} for ${priceText} (saves ${savingText})`;
  }
  return `Add to cart: ${names} for ${priceText}`;
}

function kindBadgeLabel(kind: CartUpsellItem["kind"]): string {
  switch (kind) {
    case "tier_upgrade":
      return "Tier upgrade";
    case "bundle_completion":
      return "Bundle completion";
    case "add_on":
      return "Add-on";
  }
}

export interface CartUpsellSectionProps {
  upsells: readonly CartUpsellItem[];
  busy: boolean;
  summaryFallbackFocusId: string;
  onAccept: (item: CartUpsellItem) => Promise<CartViewData | undefined>;
  onDismiss: (item: CartUpsellItem) => Promise<CartViewData | undefined>;
}

export function CartUpsellSection({
  upsells,
  busy,
  summaryFallbackFocusId,
  onAccept,
  onDismiss,
}: CartUpsellSectionProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const actionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const dismissRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  if (upsells.length === 0) return null;

  /** True only when the user has not tabbed to another control outside this section during an async mutation. */
  const focusRemainedOurs = () => {
    const active = document.activeElement;
    return !active || active === document.body || Boolean(sectionRef.current?.contains(active));
  };

  const resolveAfterAction = (
    item: CartUpsellItem,
    index: number,
    wasFocusedOnStart: boolean,
    nextView: CartViewData | undefined,
    originKind: "accept" | "dismiss",
  ) => {
    if (!wasFocusedOnStart || !focusRemainedOurs()) return;

    requestAnimationFrame(() => {
      if (!focusRemainedOurs()) return;

      // Mutation failed or card remained visible -> restore focus to the button that was disabled during busy state.
      if (!nextView || nextView.upsells.some((u) => u.offerPublicId === item.offerPublicId)) {
        const sameBtn =
          originKind === "accept"
            ? actionRefs.current.get(item.offerPublicId)
            : dismissRefs.current.get(item.offerPublicId);
        sameBtn?.focus();
        return;
      }

      const remaining = nextView.upsells;
      if (remaining.length > 0) {
        const targetSuggestion = remaining[Math.min(index, remaining.length - 1)];
        const nextBtn = targetSuggestion ? actionRefs.current.get(targetSuggestion.offerPublicId) : undefined;
        if (nextBtn) {
          nextBtn.focus();
          return;
        }
      }
      document.getElementById(summaryFallbackFocusId)?.focus();
    });
  };

  const handleAccept = async (item: CartUpsellItem, index: number) => {
    const triggerBtn = actionRefs.current.get(item.offerPublicId);
    const wasFocused = document.activeElement === triggerBtn;
    const next = await onAccept(item);
    resolveAfterAction(item, index, wasFocused, next, "accept");
  };

  const handleDismiss = async (item: CartUpsellItem, index: number) => {
    const triggerBtn = dismissRefs.current.get(item.offerPublicId);
    const wasFocused = document.activeElement === triggerBtn;
    const next = await onDismiss(item);
    resolveAfterAction(item, index, wasFocused, next, "dismiss");
  };

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles aria-hidden="true" className="size-4 shrink-0 text-action" />
        <h2 id={headingId} className="text-base font-semibold text-ink">
          Recommended for your cart
        </h2>
      </div>

      <div className="grid min-w-0 gap-3">
        {upsells.map((item, index) => {
          const actionAriaLabel = buildUpsellActionAccessibleName(item);
          const pricePrefix = item.kind === "tier_upgrade" ? "+" : "";

          return (
            <Card key={item.offerPublicId} className="min-w-0">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={item.kind === "bundle_completion" ? "success" : "info"}>
                      {kindBadgeLabel(item.kind)}
                    </Badge>
                    {item.savingMinor !== null && item.savingMinor > 0 ? (
                      <Badge tone="success">
                        Saves <Money value={{ amountMinor: item.savingMinor, currency: item.currency }} />
                      </Badge>
                    ) : null}
                  </div>
                  <h3 className="text-base font-semibold break-words text-ink">{item.title}</h3>
                  <p className="text-sm break-words text-body">{item.shortText}</p>
                  <p className="text-xs break-words text-muted">
                    {item.targetProducts.map((p) => p.name).join(" + ")}
                  </p>
                </div>

                <div className="flex min-w-0 flex-col gap-2 sm:items-end">
                  <p className="text-base font-semibold whitespace-nowrap text-ink">
                    {pricePrefix}
                    <Money value={{ amountMinor: item.priceMinor, currency: item.currency }} />
                  </p>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <Button
                      ref={(node) => {
                        if (node) actionRefs.current.set(item.offerPublicId, node);
                        else actionRefs.current.delete(item.offerPublicId);
                      }}
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      aria-label={actionAriaLabel}
                      onClick={() => void handleAccept(item, index)}
                    >
                      {item.kind === "tier_upgrade" ? "Upgrade" : "Add to cart"}
                    </Button>
                    <Button
                      ref={(node) => {
                        if (node) dismissRefs.current.set(item.offerPublicId, node);
                        else dismissRefs.current.delete(item.offerPublicId);
                      }}
                      variant="ghost"
                      size="sm"
                      leadingIcon={<X aria-hidden="true" className="size-4" />}
                      disabled={busy}
                      aria-label={`Dismiss: ${item.title}`}
                      onClick={() => void handleDismiss(item, index)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
