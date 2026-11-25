# Webhooks console verification

| Behavior | Evidence |
| --- | --- |
| Three routed admin pages | A component test verifies that the Integrations registry mounts all three admin routes and that the console nav remains discoverable while off and unavailable to staff and customers. |
| Enabled/off behavior | Component tests verify discovery while disabled, a deliberate settings change, explicit acknowledgement before choosing zero-day body retention, and paused subscription creation. |
| One-time secrets | Component tests verify onboarding and confirmed inbound rotation. Showing the secret does not use the TanStack query or mutation caches. |
| Delivery filter and cursor behavior | Component test verifies direction, date, `stopped` status, order ULID (`orderPublicId`), and correlation filters, and specifically preserves direction on a second cursor page. |
| Delivery details, stop, eligible retry, and redelivery | Component tests verify plain-text display and no trace content in the query cache, explicit acknowledgement, fresh step-up through the common verification dialog, stopping `queued`/`sending` rows with an optional reason (`deliveries.stop`), retrying eligible `failed`/`stopped` rows (`deliveries.retry`), and redelivering historical `delivered` rows (`deliveries.redeliver`). |
| Outbound subscription signing & PhaseWebhookSlot | Component tests verify per-subscription HMAC signing toggle (`Signed` / `Unsigned` badge and `signingEnabled` in create/update forms) and `PhaseWebhookSlot` (`phaseSlots.test.tsx`) in the workflow designer phase form (`onPhaseStart` / `onPhaseComplete` outbound subscription multi-selects and non-retroactive notice). |
| Page accessibility | All views are designed and tested against WCAG 2.2 AA (`pageA11y` light and dark themes in `webhooks.test.tsx` and `phaseSlots.test.tsx`). The tests exercise subscription creation, signing toggle, secret rotation, stop, retry, and redelivery controls by accessible role/label. |

The tests use synthetic tRPC responses in jsdom via `scripts/dev/test.sh client/src/features/integrations/webhooks/webhooks.test.tsx`. They are not evidence of live receiver behavior, persisted authorization decisions, log redaction on the server, browser reflow/contrast, or screen-reader behavior.
