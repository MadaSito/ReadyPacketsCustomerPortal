# Webhooks console verification

| Behavior | Evidence |
| --- | --- |
| Three routed admin pages | `webhookRoutes` and `webhookNav` exports; Subscriptions, Inbound endpoints and Deliveries share accessible section navigation. |
| Enabled/off behavior | Component tests verify discovery while disabled, a deliberate settings change, explicit acknowledgement before choosing zero-day body retention, and paused subscription creation. |
| One-time secrets | Component tests verify onboarding and confirmed inbound rotation. Showing the secret does not use the TanStack query or mutation caches. |
| Delivery filter and cursor behavior | Component test verifies direction, date and status/correlation filters, and specifically preserves direction on a second cursor page. |
| Delivery details and reruns | Component tests verify plain-text display and no trace content in the query cache, explicit acknowledgement, fresh step-up through the common verification dialog, direction-specific calls, and purged payload refusal in the UI. |
| Page accessibility | The shared page harness runs axe on all three pages in both light and dark themes. The tests exercise subscription creation, secret rotation and rerun controls by accessible role/label. |

The tests use synthetic tRPC responses in jsdom via `scripts/dev/test.sh client/src/features/integrations/webhooks/webhooks.test.tsx`. They are not evidence of live receiver behavior, persisted authorization decisions, log redaction on the server, browser reflow/contrast, or screen-reader behavior.
