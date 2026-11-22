# Policy Acceptance Log Centre — Client Surface (`Package D2`)

## Overview

`client/src/features/compliance/pages/acceptances/` implements the Increment 05 Package D2 console UI per `docs/engineering/INCREMENT_05_CONTRACT.md` (D4) and `docs/adr/0045-policy-acceptance-log-centre.md`:

1. **Policy acceptances console centre** (`/admin/policy-acceptances`, `/admin/policy-acceptances/coverage`, `/admin/policy-acceptances/updates`) with `RouteTabs` for **Log**, **Coverage**, and **Policy updates**, plus **Export CSV** behind fresh MFA step-up.
2. **Evidence detail dialog** (`AcceptanceEvidenceDialog`) displaying the immutable evidence record, full SHA-256 content hash, correlation ID, salted address pseudonym, typed signer name (or redaction state), and the exact accepted policy version text.
3. **Exact policy version reader** (`/admin/policy-acceptances/versions/:versionId`) providing a standalone printable view of any published immutable policy version text and SHA-256 content hash.
4. **Customer profile `Policies` tab** (`CustomerPoliciesTab` via `customerTabs`) showing current acceptance state per active policy, full paginated acceptance history, links to exact accepted version text, and the evidence detail dialog.

No feature-flag setting gates this UI (`INCREMENT_05_CONTRACT.md` §0 exception: the acceptance log centre is an always-on read view over existing immutable evidence).

---

## Exported Registry Symbols (`./index.ts`)

Picked up automatically by `client/src/features/compliance/routes.tsx`:

| Export | Type | Details |
| --- | --- | --- |
| `acceptanceLogRoutes` | `readonly AppRoute[]` | `/admin/policy-acceptances`, `/admin/policy-acceptances/coverage`, `/admin/policy-acceptances/updates`, `/admin/policy-acceptances/versions/:versionId` (`area: "console"`, `access: "staff"`, `capability: "policies.acceptances.read"`) |
| `acceptanceLogNav` | `readonly NavEntry[]` | `"Policy acceptances"` under `"Billing & compliance"` (`order: 47`, `access: "staff"`, `capability: "policies.acceptances.read"`) |
| `acceptanceLogCustomerTabs` | `readonly CustomerDetailTab[]` | `{ key: "policies", label: "Policies", access: "staff", order: 40, component: CustomerPoliciesTab }` |

---

## Capability & Step-Up Matrix

| Action / Field | Capability | Roles | Step-Up | Client Behaviour |
| --- | --- | --- | --- | --- |
| Read Log, Coverage, Policy updates, Customer `Policies` tab, Version text | `policies.acceptances.read` | `staff`, `admin` | No | Route guard + server capability check; `<ErrorState />` on denial |
| View decrypted `typedSignerName` in Evidence detail dialog | `policies.manage` | `admin` | No | Server sets `signerNameRedacted: true` and `typedSignerName: null` for `staff`; UI shows `Encrypted` badge + `Requires policy management permission` |
| Export matching log rows as CSV | `policies.acceptances.export` | `admin` | Yes (`STEP_UP_CAPABILITIES`) | `Export CSV` button hidden unless `can(role, "policies.acceptances.export")`; wrapped in `useStepUp().run(...)` to prompt for password + second factor on `STEP_UP_REQUIRED` |

---

## Consumed tRPC Procedures (`trpc.compliance.policies.admin.acceptanceLog.*`)

Defined in `server/modules/compliance/API.md` §9.1:

- `filterOptions` (`query`) — policy documents and published versions for filter selects.
- `list` (`infiniteQuery`) — cursor-paginated acceptance evidence rows filtered by `customerQuery`, `customerPublicId`, `policyDocumentPublicId`, `versionPublicId`, `from` (inclusive UTC start of day), `to` (exclusive UTC start of next day), `source`, `method`, `freshness`, and `orderReference`.
- `detail` (`query`) — single evidence record including `bodyText`, `contentFormat`, and capability-gated `typedSignerName` / `signerNameRedacted`.
- `coverage` (`query`) — active customer totals and per-policy accepted vs outstanding customer breakdowns.
- `updates` (`query`) — chronological published policy version history with change summary, publisher, and accepted customer counts.
- `forCustomer` (`infiniteQuery`) — customer profile policy status summary + cursor-paginated acceptance history.
- `versionText` (`query`) — standalone read-only policy version text + SHA-256 content hash.
- `export` (`mutation`) — step-up-guarded, formula-injection-neutralized CSV export matching active filters.

---

## Timezones, Responsive Layout, and Accessibility

- Every timestamp renders in the viewer's local time zone (`<DateTime>` with semantic `<time dateTime="...">`) alongside explicit `YYYY-MM-DD HH:MM UTC` text.
- All tabular surfaces use shared `DataTable`, switching cleanly to stacked `<dl>` cards below `md` (covering `< 640 px` down to `320 CSS px`) with wrap-safe identifiers and short non-truncating status badges.
- Designed and tested against WCAG 2.2 AA in both light and dark themes.
