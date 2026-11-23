# Reports module (increment 06, package H / D6)

Built-in reports, saved custom report definitions, bounded runs and CSV export. The module reads other modules' tables but never writes to them. It reads only the columns whitelisted in `catalogue.ts`, so it never touches encrypted (`*Enc`), blind-index (`*Index`), secret, token, storage-key or IP columns.

## Mounting

- Schema: `export * from "../../modules/reports/schema.js"` in `server/db/schema/index.ts` (`report_definitions`, `report_runs`).
- Container: `createReportsModule(deps)` → `services.reports` (`ReportsModule`).
- tRPC: `reportsRouter` → `reports`. Until the module is mounted, the router fails closed with `REPORTS_UNAVAILABLE`.
- Job: `reports.runs.purge` (schedule `reports.runs.purge.daily`). It deletes finished run-log rows older than 90 days.

## Router (`trpc.reports.*`)

| Procedure | Gate | Input → output |
|---|---|---|
| `catalogue` (query) | staff/admin, `reports.read` | → `{ builtIns, datasets, limits, canManage, canExport }`. `datasets` is empty for staff. |
| `builtIn.run` (query, expensive) | `reports.read` | `{ key, range:{from,to}, comparePrevious?, bucket? }` → `BuiltInResult` |
| `builtIn.export` (mutation, expensive) | `reports.export` (step-up) | the same plus `panel` → `CsvResult` |
| `custom.list` (query) | admin, `reports.manage` | `{ cursor?, scope?: mine\|shared\|all }` → `{ items: DefinitionView[], nextCursor }` |
| `custom.get` (query) | `reports.manage` | `{ definitionId }` → `DefinitionView` |
| `custom.create` (mutation) | `reports.manage` | `{ name, description?, visibility?, spec }` → `DefinitionView` |
| `custom.update` (mutation) | `reports.manage`, owner only | `{ definitionId, expectedVersion, definition }` → `DefinitionView` |
| `custom.duplicate` (mutation) | `reports.manage` | `{ definitionId, name? }` → private copy owned by the caller |
| `custom.delete` (mutation) | `reports.manage`, owner only | `{ definitionId, expectedVersion }` → `{ deleted: true }` |
| `custom.preview` (mutation, expensive) | `reports.manage` | `{ spec }` → `CustomResult` (unsaved; up to 5,000 rows) |
| `custom.run` (mutation, expensive) | `reports.manage` | `{ definitionId }` → `CustomResult` |
| `custom.export` (mutation, expensive) | `reports.manage` + `reports.export` (step-up) | `{ definitionId }` → `CsvResult` (saved definitions only) |

All inputs are strict Zod objects. Types are in `spec.ts`.

## Built-in reports

`orders`, `customers`, `referrals`, `support`, `payments_discounts`, `carts`, `files_recordings`, `signins_security`.

- Ranges are half-open `[from, to)` in UTC, at most 732 days long. `comparePrevious` adds the same-length window immediately before.
- Panels hold up to 500 rows. Staff never receive personal fields or panels that list customers; a note says so.
- Support formulas (agreed with engagement):
  - Opened: `createdAt` falls in the range.
  - Closed: `COALESCE(closedAt, resolvedAt)` falls in the range.
  - First response: the earliest staff or admin message that is not internal and is at or after the ticket's creation.
  - Resolution: `COALESCE(resolvedAt, closedAt) − createdAt`.
  - Backlog: tickets in `open`, `pending_customer` or `pending_staff`, in age buckets <24h, 1–3d, 3–7d and >7d.
  - Ticket subjects and bodies are never read.
- A cart counts as abandoned when it has expired, or is still open after 24 hours without activity. Invoices count as overdue 14 days after issue (fixed).

## Custom reports

A spec is data only: `{ dataset, columns, filters, groupBy, aggregates, sort, limit, chart }`.

- Datasets: `orders`, `order_items`, `customers`, `support_tickets`, `referrals`, `payments`, `receipts`, `refunds`, `promo_redemptions`, `carts`, `files`, `sign_ins`.
- Every name is resolved against the whitelist. Filter values become bound parameters, and there is no SQL, expression or function text anywhere.
- Fields marked personal are only available to administrators. A money aggregate needs a currency filter or a currency group.
- A stored spec is re-parsed and recompiled on every read, with the current caller's personal-data gate. If it no longer compiles, it shows as `valid: false`.
- `specHash` is the SHA-256 of the canonical spec JSON.
- Shared definitions are visible to every administrator, but only the owner can edit or delete them. Edits use optimistic `expectedVersion` checks.
- Each owner can save up to 200 definitions.
- `receipts` never exposes the card brand, last four digits, provider reference or receipt documents.

## Limits and execution

- **Live authorization:** every call re-validates the session through `identity.sessions.assertCurrent`: role, capability, pending steps, and step-up for exports. This runs inside a transaction before any saved spec is read. Denials are audited as `report.denied` (security).
- **One run per user** across all processes: the run, preview and export paths share a slot, the unique `report_runs.active_user_id`. A second attempt gets `CONFLICT/REPORT_BUSY`. A slot whose lease (4 × timeout) has passed is released.
- **Rate limit:** 10 runs per user per minute, counted from `report_runs` (`RATE_LIMITED/REPORT_RATE_LIMITED`), in addition to the edge limiter's "expensive" class.
- **Execution:** queries run in a read-only repeatable-read transaction with `SET SESSION max_execution_time = 15000`. Errno 3024 or 1317, or the wall-clock deadline (2 × timeout), gives `UNAVAILABLE/REPORT_TIMEOUT`. Supported engine: Oracle MySQL 8.4 only (see INSTALL.md); MariaDB is not supported.
- **Rows:** up to 5,000 on screen, and up to 100,000 or the spec limit in CSV.
- **CSV:**
  - Format: UTF-8 BOM, CRLF and RFC 4180 quoting.
  - Strings pass through the compliance formula-injection guard (`escapeAcceptanceCsvCell`); finite numbers are written as-is.
  - Custom exports stream 2,000-row pages inside one snapshot. The ORDER BY gets every output column as a tiebreaker so pages stay stable.
  - A cumulative 16 MiB byte cap applies; hitting a cap sets `truncated: true`.

## Audit

| Event | Category | Facts (never filter values or cell data) |
|---|---|---|
| `report.run` | business | `report_key` or `dataset`, `kind` (builtin, preview or custom), `spec_hash`, `filter_ops` (field:op list), `definition_public_id`; `safeCounts.rows` |
| `report.exported` | business | the same, plus `panel` (built-in) and `truncated` |
| `report.definition.created`, `.updated`, `.deleted` | admin | `dataset`, `spec_hash`, `visibility`; recorded in the same transaction as the change |
| `report.denied` | security | reason code |

## Settings

None. Reports are on by default and add no stored setting, so no old setting value needs to parse.
