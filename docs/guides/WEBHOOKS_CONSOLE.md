# Webhooks console

Open **Console → Webhooks** to configure subscriptions, inbound endpoints, and delivery logs. The service starts off, but administrators can configure it before enabling it under **Subscriptions → Settings**. Changes to webhook configuration require fresh verification.

Setting retention to zero immediately purges retained delivery bodies and disables reruns. Review that consequence before confirming the setting.

## Configure destinations and receivers

- **Subscriptions**: Start with a paused subscription. Enter an HTTPS URL that is permitted by the outbound connections policy, select events, and securely store the signing secret when it appears. Resume when your receiver is ready. **Test delivery** queues a synthetic event; use **Deliveries** to find its outcome before relying on the subscription.
- **Inbound endpoints**: Create a disabled endpoint, securely copy the signing secret, and configure the sender with the receive path shown in the console. Enable the endpoint when the sender is ready. Inbound webhook events can start automations; they do not act as a customer login or an API credential.
- **Signing secrets**: Creation and rotation show the new secret once. Don’t place it in a URL, ticket, or log. Console rotation allows a 60-minute overlap so you can update the sender or receiver before the previous secret stops working.

## Review and rerun a delivery

Use **Deliveries** to search and filter by direction, status, event key, subscription or endpoint ID, UTC dates, or correlation ID. Open **Details** to inspect recorded attempts and any retained, redacted request or response data.

An eligible outbound record offers **Redeliver webhook**. An eligible inbound record offers **Reprocess inbound event**. Review the warning before confirming: a rerun can repeat an external notification or start an automation again. Fresh verification and acknowledgement are required. A rerun creates a separate record, not an edit to the original. Truncated or purged payloads cannot be rerun.
