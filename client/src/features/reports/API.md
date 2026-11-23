# Reports Feature (`client/src/features/reports`) — API Contract

Package I (Increment 06, D6). Console analytics, built-in operational reports, and the whitelisted custom report builder.

## Registry Export

Mounted in `client/src/app/registry.ts` as:

```ts
import { reportsFeature } from "@/features/reports/routes";
```

- `reportsFeature: FeatureRoutes`
  - **Console Navigation (`nav`)**:
    - `Reports` (`/admin/reports`, group `"Overview"`, `order: 5`, `access: "staff"`, `capability: "reports.read"`).
  - **Routes (`routes`)**:
    - `/admin/reports` — `ReportsOverviewPage` (`access: "staff"`, `capability: "reports.read"`).
    - `/admin/reports/built-in/:reportKey` — `BuiltInReportPage` (`access: "staff"`, `capability: "reports.read"`).
    - `/admin/reports/custom/new` — `CustomReportBuilderPage` (`access: "admin"`, `capability: "reports.manage"`).
    - `/admin/reports/custom/:definitionId/edit` — `CustomReportBuilderPage` (`access: "admin"`, `capability: "reports.manage"`).
    - `/admin/reports/custom/:definitionId` — `CustomReportRunPage` (`access: "admin"`, `capability: "reports.manage"`).

## Capabilities & Step-up Rules

| Capability | Roles | Step-up | Client surfaces |
| --- | --- | --- | --- |
| `reports.read` | `staff`, `admin` | No | `/admin/reports` built-in cards, `/admin/reports/built-in/:reportKey` KPIs, SVG charts, data tables, and plain-text period comparisons. |
| `reports.manage` | `admin` | No | Saved custom reports list (`mine` / `shared` / `all`), custom report builder, preview, save (`private` / `shared`), duplicate, owner-only edit/delete, and `/admin/reports/custom/:definitionId` run view. |
| `reports.export` | `admin` | Fresh MFA (`STEP_UP_CAPABILITIES`) | Built-in panel CSV export (`reports.builtIn.export`) and saved custom report CSV export (`reports.custom.export`) wrapped in `useStepUp().run(...)`. |

Client-side capability checks hide or disable controls for ergonomics only; the server `reports` router re-verifies live session capabilities, ownership, and fresh MFA step-up inside every transaction.

## Consumed `trpc.reports.*` Procedures

- `reports.catalogue` (`query`): built-in catalogue entries, whitelisted datasets + typed field metadata, execution limits, `canManage`, `canExport`.
- `reports.builtIn.run` (`query`): `{ key, from, to, comparePrevious, bucket }` -> `BuiltInResult` (`metrics`, `panels`, `notes`, `generatedAt`).
- `reports.builtIn.export` (`mutation`, step-up): `{ key, from, to, comparePrevious, bucket, panel }` -> `CsvResult` (UTF-8 BOM, RFC 4180 CRLF, formula-injection guarded).
- `reports.custom.list` (`infiniteQuery`): `{ cursor?, scope?: "mine" | "shared" | "all" }` -> `{ items: DefinitionView[], nextCursor: string | null }`.
- `reports.custom.get` (`query`): `{ definitionId }` -> `DefinitionView`.
- `reports.custom.create` (`mutation`): `{ name, description?, visibility, spec }` -> `DefinitionView`.
- `reports.custom.update` (`mutation`): `{ definitionId, expectedVersion, definition: { name, description?, visibility, spec } }` -> `DefinitionView`.
- `reports.custom.duplicate` (`mutation`): `{ definitionId, name? }` -> `DefinitionView`.
- `reports.custom.delete` (`mutation`): `{ definitionId, expectedVersion }` -> `{ deleted: boolean }`.
- `reports.custom.preview` (`mutation`): `{ spec }` -> `CustomResult`.
- `reports.custom.run` (`mutation`): `{ definitionId }` -> `CustomResult`.
- `reports.custom.export` (`mutation`, step-up): `{ definitionId }` -> `CsvResult`.

## Internal Modules

- `types.ts` — client wire types mirroring `server/modules/reports/spec.ts` and typed `useReportsProcedures()` (`useTRPC().reports`).
- `format.tsx` — built-in report metadata, typed cell formatters (`Money`, `DateTime`, duration, boolean, enum), plain-text KPI comparison formatter (`Up`/`Down`/`Unchanged`), UTC date-range presets and validation (`to >= from`, `<= 732` days), fallback table summaries, safe domain error mapping, and Blob CSV download helper.
- `ReportChart.tsx` — zero-dependency responsive SVG `bar`, `line`, and `pie` charts inside `@/ui`'s `<ChartFrame>` using `useChartIds()`, `ids.patternFill(2..6)`, semantic chart tokens (`fill-chart-1..6`, `stroke-chart-1..6`), distinct line dash patterns and point markers, visible text summaries, and `DataTable` fallback/switch.
