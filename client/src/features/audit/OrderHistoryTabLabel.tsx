/** S2 tab label (kept out of the lazy tab chunk): "History" in the customer area, "Order history" in the console. */
export function OrderHistoryTabLabel({ area }: { orderId: string; area: "customer" | "console" }) {
  return <>{area === "customer" ? "History" : "Order history"}</>;
}
