import type { EmitOpsAlert } from "./index.js";

/** Payments owns the grace window and verified-webhook evidence. Never pass customer or endpoint data. */
export function stripeWebhookDeliveryMissingAlert(environment: "test" | "live"): EmitOpsAlert {
  return {
    source: "payment",
    dedupKey: `stripe.webhook_delivery.missing:${environment}`,
    severity: "warning",
    code: "STRIPE_WEBHOOK_DELIVERY_MISSING",
    title: "Stripe is not delivering webhooks to this server",
    text: environment === "live"
      ? "Check the live-mode endpoint, selected event types, and matching signing secret in Payments setup."
      : "Check the test-mode endpoint, selected event types, and matching signing secret in Payments setup.",
  };
}
