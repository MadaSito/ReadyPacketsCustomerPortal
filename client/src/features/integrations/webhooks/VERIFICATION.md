# Webhooks console verification

| Behavior | Evidence |
| --- | --- |
| Three routed admin pages | A component test verifies that the Integrations registry mounts all three admin routes and that the console nav remains discoverable while off and unavailable to staff and customers. |
| Enabled/off behavior | Component tests verify discovery while disabled, a deliberate settings change, explicit acknowledgement before choosing zero-day body retention, and paused subscription creation. |
| One-time secrets | Component tests verify onboarding and confirmed inbound rotation. Showing the secret does not use the TanStack query or mutation caches. |
| Delivery filter and cursor behavior | Component test verifies direction, date and status/correlation filters, and specifically preserves direction on a second cursor page. |
| Delivery details and reruns | Component tests verify plain-text display and no trace content in the query cache, explicit acknowledgement, fresh step-up through the common verification dialog, direction-specific calls, and no reruns for purged payloads or when the service is off. |
| Page accessibility | The shared page harness runs axe on all three pages in both light and dark themes. The tests exercise subscription creation, secret rotation and rerun controls by accessible role/label. |

The tests use synthetic tRPC responses in jsdom via `scripts/dev/test.sh client/src/features/integrations/webhooks/webhooks.test.tsx`. They are not evidence of live receiver behavior, persisted authorization decisions, log redaction on the server, browser reflow/contrast, or screen-reader behavior.
