# Order Status Catalogue (Increment 07 — Package C / Decision D2)

Owner: `recovery_ops_engineer`
Paths:
- `shared/orderStatusCatalog.ts`
- `server/modules/orders/statusCatalogSchema.ts`
- `server/modules/orders/statusCatalog.ts`
- `server/modules/orders/statusCatalogRouter.ts`
- `server/modules/orders/statusCatalog.test.ts`
- `client/src/features/orders/pages/workflows/AdminWorkflowStatusesPage.tsx`
- `client/src/features/orders/statusCatalog.test.tsx`
- D2 console filter & pipeline updates in `client/src/features/orders/pages/AdminOrdersPage.tsx`, `client/src/features/orders/OrdersPipelineWidget.tsx`, `client/src/features/orders/pages/AdminWorkflowsPage.tsx`, and `client/src/features/orders/routes.tsx`.

## 1. Schema & Domain Rules (`order_status_catalog`)

- Table `order_status_catalog` (`migrations/0007_increment_07.sql`):
  - `id` (`bigint unsigned` PK), `public_id` (`char(26)` ULID, unique `order_status_catalog_public_id_uq`), `key` (`varchar(48)` lowercase snake_case, unique `order_status_catalog_key_uq`), `staff_label` (`varchar(60)` NFC plain text), `customer_label` (`varchar(60)` NFC plain text), `tone` (`neutral | info | success | warning | danger`), `category` (`start | working | waiting | done | canceled`), `attention` (`none | staff_review | customer_response`), `position` (`int unsigned`), `retired` (`boolean`), `retired_at` (`timestamp(3)` nullable), `version` (`int unsigned` CAS), `created_at`, `updated_at`.
- **Startup seed (`ensureSeeded`)**: Idempotently inserts the 10 standard workflow statuses plus legacy `submitted` without overwriting administrator edits (`onDuplicateKeyUpdate` no-op).
- **Bidirectional cancel invariant (`validateStatusCancelCategoryRule`)**: A status key containing `cancel` must have category `canceled`, and a status in category `canceled` must contain `cancel` in its key.
- **Draft-aware retirement**: `retire` inspects open `order_workflow_drafts` inside the serializable transaction and refuses retirement with `CONFLICT:STATUS_USED_BY_DRAFT` while any open draft references `key` (supports both format 1/2 `states` and format 3 `stages[].statuses`). Existing orders and published workflow versions keep working when a status is retired.
- **Backward compatibility**: `getManyInTx(keys, tx)` resolves known keys from `order_status_catalog` and synthesizes safe fallback entries (`fallbackStatusLookup(key)`) for legacy workflow keys not yet in the catalogue. Format-1 and format-2 published workflow versions continue reading their own snapshot labels.

## 2. Service Ports (`OrdersModule.statusCatalog`) & Router (`trpc.orders.statusCatalog.*`)

- Service ports (`OrderStatusCatalogService`):
  - `ensureSeeded(): Promise<void>`
  - `list(options?: { includeRetired?: boolean; includeUsage?: boolean }, tx?: DbClient): Promise<StatusCatalogItem[]>`
  - `getManyInTx(keys: readonly string[], tx?: DbClient): Promise<Map<string, StatusCatalogLookup>>`
  - `attentionCounts(tx?: DbClient): Promise<{ staffReview: number; customerResponse: number }>`
  - `create`, `update`, `reorder`, `retire`, `restore`
- tRPC procedures (`server/modules/orders/statusCatalogRouter.ts`):
  - `orders.statusCatalog.list` (`staffProcedure` + `requireCapability("orders.read_all")` before `.input()`)
  - `orders.statusCatalog.attentionCounts` (`staffProcedure` + `requireCapability("orders.read_all")`)
  - `orders.statusCatalog.create` (`adminProcedure` + `requireCapability("orders.statuses.manage")` before `.input()`, step-up required)
  - `orders.statusCatalog.update` (`adminProcedure` + `requireCapability("orders.statuses.manage")` before `.input()`, step-up required, `expectedVersion` CAS)
  - `orders.statusCatalog.reorder` (`adminProcedure` + `requireCapability("orders.statuses.manage")` before `.input()`, step-up required)
  - `orders.statusCatalog.retire` (`adminProcedure` + `requireCapability("orders.statuses.manage")` before `.input()`, step-up required)
  - `orders.statusCatalog.restore` (`adminProcedure` + `requireCapability("orders.statuses.manage")` before `.input()`, step-up required)

## 3. Audit Events

- `order.status_catalog.created`, `order.status_catalog.updated`, `order.status_catalog.reordered`, `order.status_catalog.retired`, `order.status_catalog.restored` (`category: "admin"`, `resource.type: "order_status_catalog"`).

## 4. Console UI & Accessibility

- `/admin/workflows/statuses` (`AdminWorkflowStatusesPage`): linked from `/admin/workflows` (`Statuses` header action), gated to `admin` + `orders.statuses.manage`, supports Add, Edit (`key` read-only), keyboard-accessible Move Up / Move Down buttons (`reorder`), draft-aware Retire confirmation, Restore, and `Show retired statuses` switch.
- `/admin/orders` (`AdminOrdersPage`): attention filter chips (`All orders`, `Awaiting staff review (N)`, `Awaiting customer response (N)`), deep-link support (`/admin/orders?attention=staff_review` and `/admin/orders?attention=customer_response`), and catalogue-backed Status `<Select>` for both staff and administrators.
- Console overview (`OrdersPipelineWidget`): displays `Awaiting staff review` and `Awaiting customer response` counts linking to `/admin/orders?attention=...`.
- Designed and tested against WCAG 2.2 AA in light and dark themes (`pageA11y` + `expectNoAxeViolations`), with explicit non-colour status/attention badges and zero browser storage APIs.

## 5. Verification

- `scripts/dev/test.sh server/modules/orders/statusCatalog.test.ts` — **5/5 passing** on real MySQL (`0007_increment_07.sql`).
- `scripts/dev/test.sh client/src/features/orders/statusCatalog.test.tsx` — **10/10 passing** (including light & dark `pageA11y` axe checks).
- `scripts/dev/test.sh client/src/features/orders/orders.test.tsx` — **43/43 passing** (regression suite).
