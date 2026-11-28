/**
 * Increment 09 (D2.7): "Move to trash" for one order, on the console order detail and the /admin/orders row.
 * Owner: orders_engineer. The confirmation (what moves with it, permanent-deletion date, the no-refund note when the
 * order has payments, optional reason ≤ 200, Undo toast) is the trash feature's `MoveToTrashDialog`.
 * Shown only to roles with `trash.manage` (administrators); the server checks it again.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState, type RefObject } from "react";
import { useLocation } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { MoveToTrashDialog } from "@/features/trash/TrashDialogs";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Button } from "@/ui";

export const MOVE_ORDER_TO_TRASH_LABEL = "Move to trash";

export function useCanTrashOrders(): boolean {
  const { me } = useSession();
  const role = me?.user.role;
  return role !== undefined && role !== "customer" && roleHasCapability(role, "trash.manage");
}

export function MoveOrderToTrashButton({
  orderPublicId,
  reference,
  projectName,
  placement,
  successFocusRef,
}: {
  orderPublicId: string;
  reference: string;
  projectName: string;
  /** "detail": returns to the list after the move; "row": stays on the list. */
  placement: "detail" | "row";
  /**
   * Row only (WCAG 2.4.3): the row disappears on refetch, so after a successful move the dialog returns focus to this
   * stable container (tabIndex -1). Cancel and failures return focus to the row's button.
   */
  successFocusRef?: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const allowed = useCanTrashOrders();
  if (!allowed) return null;
  const label = `${reference} · ${projectName}`;
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey(), refetchType: "all" });
  return (
    <>
      <Button
        variant={placement === "detail" ? "danger" : "secondary"}
        size="sm"
        className="min-h-6 min-w-6"
        data-testid={placement === "detail" ? "order-move-to-trash" : `order-row-move-to-trash-${orderPublicId}`}
        aria-label={placement === "row" ? `${MOVE_ORDER_TO_TRASH_LABEL}: ${reference}` : undefined}
        onClick={() => setOpen(true)}
      >
        {MOVE_ORDER_TO_TRASH_LABEL}
      </Button>
      <MoveToTrashDialog
        open={open}
        onOpenChange={setOpen}
        kind="order"
        publicId={orderPublicId}
        itemLabel={label}
        returnFocusRef={placement === "row" ? successFocusRef : undefined}
        onMoved={() => {
          // The order is now not found for every read: drop its cached detail before leaving the page.
          queryClient.removeQueries({ queryKey: trpc.orders.admin.get.queryKey({ orderId: orderPublicId }) });
          if (placement === "detail") {
            void refresh();
            navigate("/admin/orders");
            return;
          }
          void refresh();
        }}
        onRestored={() => {
          void refresh();
          if (placement === "detail") navigate(`/admin/orders/${orderPublicId}`);
        }}
      />
    </>
  );
}
