# 0049 — Reports: built-in reports and safe custom reports

Status: Accepted (2026-11-23; implemented in increment 06 and checked in the lead's QA browser run — see STATUS.md. Assumptions below remain open for owner confirmation)

## Context
The owner asked for detailed reporting (orders, customers, referrals, support tickets and more) and for custom reports built in the admin panel. Free-form queries would open SQL injection and data-exposure risks (OWASP A01 and A03).

## Decision
- **Built-in reports.** Each has a date range, a comparison with the previous period, a chart with a table, and CSV.

  | Report | Contents |
  | --- | --- |
  | Orders | created, completed, by status, phase, workflow, product and tier; turnaround time; overdue; revenue |
  | Customers | new, active, by lifecycle, top by orders and revenue, policy acceptance state |
  | Referrals | invitations, sign-ups, conversions, rewards |
  | Support | opened and closed, by status, category and priority; time to first response and to resolution; backlog age |
  | Payments and discounts | paid, refunded, waived, by provider; code redemptions and discount given |
  | Carts | open, abandoned, converted; upsell shown and accepted |
  | Files and recordings | uploads, conversions, failures |
  | Sign-ins and security | sign-ins, failures, bans |

- **Custom reports.** These are for administrators with `reports.manage`.
  - **Definition.** An administrator picks one dataset from a server-side whitelist, then columns, typed filters (field, operator, value), an optional group-by with count, sum, average, minimum or maximum, a sort and a chart type.
  - **Row limits.** Up to 5,000 rows show on screen and up to 100,000 go into a CSV.
  - **Saving.** A report is saved with a name and description, either private or shared with staff. Reports can be duplicated, edited and deleted, and they run on demand.
  - **No SQL.** There is no free-form SQL and there are no expressions. A definition is data, validated by a strict schema and compiled to parameterised Drizzle queries over whitelisted columns only.
- **Data rules:**
  - other modules' tables are read only, following the portable-module precedent;
  - encrypted or secret columns are never read;
  - only public ids and customer numbers are shown;
  - personal-data columns are flagged in the dataset catalogue, and only roles that may already see them get them;
  - staff see built-in reports only; customers have no access;
  - query timeouts and row caps apply, each user runs one report at a time, and runs are rate limited.
- **Export.** CSV is UTF-8 with a BOM, follows RFC 4180, and guards against formula injection with the acceptance-log helper. Export needs `reports.export` and step-up.
- **Audit:**
  - `report.run`, with the key or definition id and filters without personal values;
  - `report.exported`, with the definition hash and the row count.
- **Storage.** Definitions live in `report_definitions`, with a run log if needed. Portable transfer and backups cover the new tables.
- **Accessibility.** Every chart has a data-table alternative and a text summary, and colour is never the only encoding.

## Assumptions to confirm with the owner
- Reports are on for staff and administrators after upgrade.
- Staff are limited to built-in reports.

## As implemented

Packages H and I, as reported by the owners:

- **Ranges and comparison.** Ranges go up to 732 days, with time buckets of hour, day, week or month and a comparison with the previous period.
- **Personal fields.** Staff never see personal fields.
- **Custom reports:**
  - up to 20 detail columns;
  - or up to 4 groupings with 6 aggregates;
  - up to 16 typed filters and 4 sort rules.
- **Sharing.** Shared definitions are visible to all administrators; this refines "shared with staff" in the contract. Only the owner edits or deletes, guarded by optimistic version checks.
- **Limits:**
  - one run at a time and 10 a minute per person;
  - a 15-second statement timeout;
  - CSV of at most 100,000 rows or 16 MiB, marked truncated when a cap is hit.
- **Retention and audit.** Run history (`report_runs`) is kept for 90 days. Definition changes are audited as `report.definition.*`.
- **Portable transfer.** Saved reports are excluded from the business export and included in backups.

## Consequences
- Each new dataset needs a code change to the whitelist, which is the intended limit.
- Large CSV exports load the database and are capped and rate limited.
