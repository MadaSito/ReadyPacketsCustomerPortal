/** Customer order detail (/orders/:orderId). Owner: orders_engineer. */
import { OrderDetailView } from "./OrderDetailView";

export default function OrderDetailPage() {
  return <OrderDetailView area="customer" />;
}
