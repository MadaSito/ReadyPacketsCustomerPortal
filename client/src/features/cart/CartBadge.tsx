/**
 * Cart item count shown next to the "Cart" navigation entry (loaded by the shell's CartBadgeSlot).
 * Renders nothing when the cart feature is off, the count is zero, or the query has not answered.
 */
import { useQuery } from "@tanstack/react-query";
import { useFeatureEnabled } from "@/lib/features";
import { useTRPC } from "@/lib/trpc";
import { useCartViewerGate } from "./viewerGate";

export function cartCountLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"} in cart`;
}

export function CartBadge() {
  const { pending, staffViewer } = useCartViewerGate();
  const featureEnabled = useFeatureEnabled("cart");
  const enabled = featureEnabled && !pending && !staffViewer;
  const trpc = useTRPC();
  const badge = useQuery({ ...trpc.cart.badgeCount.queryOptions(undefined, { enabled }), staleTime: 30_000 });
  const count = badge.data?.enabled ? badge.data.itemCount : 0;
  if (!enabled || count <= 0) return null;
  const shown = count > 99 ? "99+" : String(count);
  return (
    <span
      aria-label={cartCountLabel(count)}
      role="img"
      className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-action px-1.5 text-xs font-semibold leading-5 text-on-action tabular-nums"
    >
      {shown}
    </span>
  );
}

export default CartBadge;
