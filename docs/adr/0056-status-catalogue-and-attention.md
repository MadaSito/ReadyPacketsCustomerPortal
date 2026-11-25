# 0056 — Status catalogue and order attention

Status: Accepted (2026-11-25, after the lead's integrated QA of increment 07 at `7c6bb71`; verification in [STATUS.md](../application-context/STATUS.md#verification-for-increment-07))

## Context
The owner asked for "a status system that can be called on by the order workflow and updated if statuses need to be added". Status keys and labels live inside each workflow version today, so renaming or adding a status means editing every workflow. Reports, exports and the P101 / P201 webhooks read `orders.status_key` as a string ([ADR 0023](0023-production-pipeline-webhooks.md)).

## Decision
- **Catalogue table.** `order_status_catalog` has these columns:
  - `key` (immutable), `staffLabel` and `customerLabel`;
  - `tone`;
  - `category`: `start | working | waiting | done | canceled`;
  - `attention`: `none | staff_review | customer_response`;
  - position, retired, and a row version.

  It is seeded at start-up, idempotently, with the 10 standard workflow statuses plus the legacy `submitted`, without overwriting administrator edits. Keys used by older workflows but missing from the catalogue get a safe fallback entry when read.
- **Statuses page** (`/admin/workflows/statuses`, `orders.statuses.manage`, administrators with step-up):
  - add, rename, reorder (with buttons, not only drag), retire and restore;
  - retire is refused while a draft uses the status;
  - orders already in a retired status keep it and still display it.
- **Keys stay strings.** `orders.status_key` stays a string, so reports, exports and P101 / P201 keep working. A key containing `cancel` must have category `canceled`, and the reverse; integrations rely on this.
- **Labels.** Format-3 versions take labels and attention from the catalogue, so a rename shows everywhere. Formats 1 and 2 keep their snapshot labels.
- **Attention on orders.** `orders.attention` and `attention_since` are written in the same transaction as every status or stage change.
  - `/admin/orders` gets "Awaiting staff review" and "Awaiting customer response" filter chips with counts, and the pipeline widget shows both.
  - An optional reminder alert fires when an order has waited longer than `orders.attention_alert_hours` (default 48, range 1–8760). It is off until `orders.attention_alerts_enabled` is switched on ([ADR 0058](0058-outbound-webhooks-and-operational-alerts.md)).

## Assumptions to confirm with the owner
- Format 1/2 workflows keep their own labels; only format 3 follows catalogue renames.
- Attention filters are on after upgrade, and the reminder alerts are off.

## As implemented

Package C, from the owner's [status catalogue notes](../../server/modules/orders/STATUS_CATALOG.md):

- **Procedures.** `orders.statusCatalog.{list, attentionCounts}` need staff with `orders.read_all`. `create`, `update`, `reorder`, `retire` and `restore` need an administrator with `orders.statuses.manage` and step-up, and updates are compare-and-set.
- **Retiring.** A status used by any open draft is refused with `STATUS_USED_BY_DRAFT`. Existing orders and published versions keep working.
- **Filters.** `/admin/orders?attention=staff_review` and `?attention=customer_response` can be linked to directly. The overview pipeline widget links to both.
- **Audit.** The events are `order.status_catalog.{created, updated, reordered, retired, restored}`. The SIEM receives the key, category and attention, but not the display label.

## Consequences
- Statuses are managed once and reused by every phases workflow.
- Retiring a status never changes an existing order.
