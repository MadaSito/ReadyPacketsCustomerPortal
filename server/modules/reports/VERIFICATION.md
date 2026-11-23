# Reports — verification (increment 06, package H)

## Reproduce

```
source scripts/dev/env.sh
scripts/dev/test.sh server/modules/reports/reports.test.ts
scripts/dev/lint.sh server/modules/reports
scripts/dev/tc.sh
```

## Tested (one file, local dev MySQL, fakes for identity, audit and clock; synthetic data)

- **Compiler:**
  - Refuses unknown datasets and non-whitelisted columns (`ipAddressEnc`, `ipIndex`).
  - The strict schema refuses SQL-looking dataset and field names and extra keys.
  - A SQL-looking filter value is treated as data and matches nothing.
  - Personal fields are refused for staff and missing from the staff catalogue, and no listed field looks like an encrypted, index or secret column.
  - Statement-timeout errno mapping (3024, 1317).
- **CSV:**
  - Formula guard (`=`, `@`), negative numbers kept, BOM and CRLF.
  - The cumulative byte cap stops writing and reports truncation, with the byte count matching the output.
  - Canonical spec hash; the audit filter shape omits values.
- **Definitions:**
  - Create, run and export, with `report.run` and `report.exported` audit; no cell value (a formula-like reason code) appears in any audit event.
  - Private definitions are hidden from other admins; shared ones are visible but not editable; version conflicts are caught; duplicating gives a private copy.
- **Live authorization:** a role downgraded in the live session is refused before the saved spec is read, and `report.denied` is recorded.
- **Slot and rate limit:**
  - A running slot gives `REPORT_BUSY`, and is recovered once its lease passes.
  - The 11th run in a minute gives `REPORT_RATE_LIMITED`.
- **Paged export:** respects the spec limit and reports truncation.
- **Built-ins:** `signins_security` runs for staff and shows no personal field.
- **Router:**
  - Anonymous callers get `NO_SESSION`; customers are refused.
  - Staff get an empty dataset list and are refused `custom.list`.
  - Exports without fresh step-up get `STEP_UP_REQUIRED`.
  - Non-strict input gets `BAD_REQUEST`.

## Not verified

- The other seven built-ins against populated tables. They typecheck and use the same compiler, but no test seeds orders, support, payments, carts, files or referrals data.
- A real statement timeout on a slow query, timing across replicas, and memory use of a 100,000-row export.
- The `receipts` dataset against data.
- The purge job execution (only the job name is checked).
- The client (engagement_engineer) and the mounted container and root router (owned by /root).
- Accessibility of the report screens (client scope).
- Old-setting parse: not applicable, since the module adds no settings.
