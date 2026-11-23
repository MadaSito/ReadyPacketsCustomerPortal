# Reports Feature (`client/src/features/reports`) — Verification

Package I (Increment 06, D6). Designed and tested against WCAG 2.2 AA.

## Automated Verification Run

Commands executed (with `source scripts/dev/env.sh`):

1. `scripts/dev/tc.sh` — 0 TypeScript errors across `client/src/features/reports/**` against the mounted `AppRouter.reports` (`575dafb`) and `client/src/app/registry.ts`.
2. `scripts/dev/lint.sh client/src/features/reports` — 0 ESLint errors, 0 warnings (`--max-warnings 0`).
3. `scripts/dev/test.sh client/src/features/reports/reports.test.tsx` — 16/16 tests passing, including 8 `pageA11y` axe runs (light + dark themes on overview, built-in report, custom builder, and custom run view).

## Functional, Security, and Accessibility Coverage

- **Role & capability boundaries (`D6`)**:
  - `staff` sees all 8 built-in report cards, runs built-in reports, sees role-redaction `notes[]` callouts, and never sees custom report sections, custom report routes (blocked by `RequireCapability` / `NotFoundPage`), or CSV export actions.
  - `admin` sees built-in reports plus saved custom reports (`All` / `Mine` / `Shared` filter + cursor `LoadMore`), creates/previews/saves custom reports, duplicates shared reports, and edits/deletes owned reports only (passing `expectedVersion`).
  - Navigating directly to `/admin/reports/custom/:definitionId/edit` on a non-owned shared report renders a read-only callout with **Duplicate to edit** and never mounts editable form controls.
- **Step-up MFA CSV export (`reports.export`)**:
  - Built-in panel CSV export (`reports.builtIn.export`) and saved custom report CSV export (`reports.custom.export`) run inside `useStepUp().run(...)`, opening the MFA step-up dialog on `STEP_UP_REQUIRED` and retrying once re-verified.
- **Custom report spec invariants**:
  - Dataset and column/filter/group/aggregate/sort choices come exclusively from whitelisted `reports.catalogue` metadata — no free-text SQL or arbitrary identifiers exist on any client surface.
  - Switching to **Group & aggregate** mode clears detail `columns` to `[]` (matching `server/modules/reports/spec.ts`) and updates sortable keys dynamically to `groupBy` field keys plus `fn` / `fn_field` aggregate keys.
  - Typed filter inputs validate ISO dates, finite numbers, integer minor-unit `money` values, `between` `[low, high]` bounds, `in` tag lists (`max 50`), and parameterless `isNull` / `isNotNull` operators before calling `preview`, `create`, or `update`.
  - Adversarial strings in custom report names, descriptions, and cell values (e.g. `<script>...</script>`) render strictly via React text nodes with zero `dangerouslySetInnerHTML`.
- **Safe abuse/limit & concurrency error states**:
  - `REPORT_BUSY`, `REPORT_RATE_LIMITED`, `REPORT_TIMEOUT`, `REPORT_SPEC_INVALID` (including `details.path`), and `VERSION_CONFLICT` render clear, non-technical recovery guidance and retry actions.
  - Screen row truncation (`truncated: true`) displays an explicit warning banner above both chart and table views.
- **Accessibility & responsive design (designed and tested against WCAG 2.2 AA)**:
  - All charts use `@/ui`'s `<ChartFrame>` + `useChartIds()`: semantic `<svg role="img" aria-labelledby={ids.labelledBy}>`, `<title>` + `<desc>`, visible text summary above every chart, `SegmentedControl` **Chart / Table** toggle backed by `<DataTable>`, pattern fills (`ids.patternFill(2..6)`) on multi-series bars and pie/donut slices, distinct dash patterns + point markers on line series, and plain-text KPI comparison hints (`Up +25.0% vs previous period (40)` — never colour alone).
  - All interactive controls meet target size and WCAG 2.5.3 Label-in-Name rules (`Export CSV: <Panel>`, `Open report` / `Open <Title>`, `Edit <Report>`, `Delete <Report>`).
  - Fluid responsive grids (`grid-cols-1`, `flex-wrap`, `min-w-0`, `break-words`) and `DataTable` mobile card fallback reflow cleanly down to 320 px without horizontal page scroll.
