# `client/src/features/integrations/production` — Public Client Contract (Part B T1 / B4)

Owner: `siem_engineer` (`client/src/features/integrations/production/**`).
Server partner: `integrations_engineer` (`server/modules/integrations/production/**`, `trpc.integrations.production.*`).
Automation tab top-slot partner: `audit_engineer` (`client/src/features/automations/OrderWorkflowStageActionsPanel.tsx`).

---

## 1. Exported Feature Registrations (`./index.ts`)

Spread into `integrationsFeature` via `client/src/features/integrations/routes.tsx`:

- **`productionAdminRoutes: readonly RouteDef[]`**
  - `path: "/admin/integrations/production"` (`access: "admin"`, `capability: "integrations.manage"`, `title: "Production pipeline"`) -> `ProductionPipelinePage`.
- **`productionAdminNav: readonly NavItem[]`**
  - Console sidebar item `"Production pipeline"` (`group: "Platform"`, `order: 84`, `access: "admin"`, `capability: "integrations.manage"`).
- **`productionOrderTabs: readonly OrderTab[]`**
  - `{ key: "automation", label: "Automation", component: OrderProductionTab, access: "staff", order: 50 }` (console URL `/admin/orders/:orderId/automation`; `OrderProductionTab` additionally returns `null` whenever `area !== "console"`).

---

## 2. Top Slot Contract (`OrderWorkflowStageActionsPanel`)

`OrderProductionTab` discovers `../../automations/OrderWorkflowStageActionsPanel.tsx` via `import.meta.glob` (no static cross-feature import), wrapped in `OptionalSlotBoundary` + `Suspense`, and mounts it full width at the top of the Automation tab with props `{ orderId: string }`. Isolated unit tests may pass `stageActionsSlot?: ReactNode` on `OrderProductionTabProps`.

---

## 3. Consumed tRPC Procedures (`trpc.integrations.production.*`)

- `settings.get` (`adminProcedure`) -> `ProductionSettingsView` (includes `p101UrlConfigured`, `p101UrlMask`, `p201UrlConfigured`, `p201UrlMask`, optional `p301UrlConfigured`, `p301UrlMask`, `p401UrlConfigured`, `p401UrlMask`).
- `settings.update` (`integrations.manage` step-up) -> `ProductionSettingsView` (accepts optional `p301Url?: string | null`, `p401Url?: string | null`).
- `settings.test` (`integrations.manage` step-up, `{ phase: "P101" | "P201" | "P301" | "P401" }`) -> `ProductionDestinationTestResult`.
- `order.preview` (`orders.production.trigger`, `{ orderPublicId, releaseStatus? }`) -> `ProductionOrderPreview` (`settingsHref`, `p101`, `p201`, `p301`, `p401` with structured `disabledReasons`).
- `order.history` (`orders.production.trigger`, `{ orderPublicId }`) -> `{ items: ProductionDispatchItem[] }` (includes `retryOf` and `redeliveryOf`).
- `order.requestP101`, `order.requestP201`, `order.requestP301`, `order.requestP401` (`orders.production.trigger`).
- `order.retry` (`orders.production.trigger`, `{ orderPublicId, dispatchPublicId }`) — retries latest `failed` / `dead` dispatch for a phase when no dispatch for that phase is `queued`, `sending`, `unknown`, or `delivered`.
- `order.redeliver` (`orders.production.redeliver` admin step-up, `{ orderPublicId, dispatchPublicId, reason, confirmation: "REDELIVER" }`) — creates a new delivery record linked via `redeliveryOf`.
- `order.resend` (`orders.production.trigger` admin step-up) — preserved for `unknown` delivery outcome recovery (`PW-02`).
- `admin.listDispatches` (`adminProcedure`, `{ phase?, state?, orderReference?, fromDate?, toDate?, limit? }`) -> `{ items: ProductionDispatchItem[] }`.
