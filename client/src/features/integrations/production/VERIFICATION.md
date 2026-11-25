# `client/src/features/integrations/production` — Verification (Increment 04 Part B, T1 / B4)

Owner: `siem_engineer`.

All views in `client/src/features/integrations/production/**` are designed and tested against WCAG 2.2 AA (`client/src/test/a11y.tsx` `pageA11y` light and dark document scans).

---

## 1. Automated Verification Matrix

| Check | Command / Harness | Status |
|---|---|---|
| Full workspace TypeScript check (serialized lock) | `scripts/dev/tc.sh` | Checked |
| ESLint on owned T1 client paths | `scripts/dev/lint.sh client/src/features/integrations/production` | Checked |
| Order tab rename (`"Production"` -> `"Automation"`, `key: "automation"`, `order: 50`) and customer `area="customer"` null guard | `production.test.tsx` | Checked |
| Phase I (`P101`) & Phase II (`P201`) cards with explicit disabled reasons and admin-only `/admin/integrations/production` settings links | `production.test.tsx` | Checked |
| Top `"Workflow stage actions"` slot (`../../automations/OrderWorkflowStageActionsPanel.tsx`) mounted full width via `import.meta.glob` + `OptionalSlotBoundary` | `production.test.tsx` | Checked |
| `"Webhook rules"` note (`customer_id`, `order_id`, `run_mode`; `bundle_scope_manifest` JSON string; Phase I artifact prerequisite) | `production.test.tsx` | Checked |
| Optional Phase III (`P301`) / Phase IV (`P401`) endpoint fields + destination allowlist tests on `/admin/integrations/production`, and conditional `"Start Phase III"` / `"Start Phase IV"` buttons on the order Automation tab | `production.test.tsx` | Checked |
| `"This order's pipeline history"` with staff/admin `Retry` (`orders.production.trigger`) and admin-only step-up `Redeliver` (`orders.production.redeliver`, required reason + exact typed `REDELIVER`, `Redelivery of …` badge) | `production.test.tsx` | Checked |
| `pageA11y` light & dark document scans (`/admin/integrations/production` ready, `/admin/orders/:orderId/automation` ready, and Redeliver `<Dialog>` open) | `production.test.tsx` (`@/test/a11y`) | Checked |
| Increment 07 D7: Outbound HMAC-SHA256 signing switch (`settings.setSigningEnabled`), once-only signing secret rotation dialog (`settings.rotateSigningSecret`), per-workflow lifecycle auto-queue switches (`workflowAutoQueue.list` / `workflowAutoQueue.update` for `p101OnPaymentConfirmed` & `p201OnPhase1Locked` with non-retroactive callout), and `Stopped` history filter | `production.test.tsx` | Checked |
| Increment 07 D7: Order Automation tab `order.stop` dialog with optional reason on `queued` dispatches, truthful `"In flight (cannot stop)"` label on `sending` rows, and `order.retry` on `stopped` dispatches | `production.test.tsx` | Checked |

---

## 2. Not Checked Here (Browser / Partner Scope)

- Real-browser visual layout, computed color contrast, and zero-overflow checks at `1440 px`, `390 px`, and `320 px` in light and dark themes: **not checked** in jsdom (`color-contrast` and CSS media layout require Chromium in Package Z, owned by `ui_foundation_engineer`).
- Assistive-technology screen-reader announcement walkthrough (NVDA / VoiceOver): **not checked** in jsdom.
- End-to-end MySQL-backed tRPC procedures and cross-customer isolation probes for `order.requestP301`, `order.requestP401`, `order.retry`, and `order.redeliver`: owned and verified by `integrations_engineer` (`server/modules/integrations/production/**`) and `assurance_engineer` (`tests/integration/isolation.test.ts`).
