# Policy Acceptance Log Centre — Verification (`Package D2`)

## What Was Run

1. **Workspace TypeScript check (`scripts/dev/tc.sh`)**
   - Ran full monorepo `tsc --noEmit` via `scripts/dev/tc.sh`: zero TypeScript diagnostics across all files in `client/src/features/compliance/pages/acceptances/**`.
2. **ESLint (`scripts/dev/lint.sh client/src/features/compliance/pages/acceptances`)**
   - Clean (0 errors, 0 warnings).
3. **Client integration, keyboard, authorization, and accessibility suite (`scripts/dev/test.sh client/src/features/compliance/pages/acceptances/acceptances.test.tsx`)**
   - 19/19 tests passing:
     - Route, navigation (`order: 47` under `Billing & compliance`), and `customerTabs` (`key: "policies"`, `order: 40`) registration via `complianceFeature`.
     - **Log tab**: viewer-local `<time>` + explicit `YYYY-MM-DD HH:MM UTC` timestamps, order reference links, salted address pseudonym, correlation ID, descriptive version link `aria-label`s, stacked `<md` card list (`md:hidden`), cursor pagination via `LoadMore` moving focus to the polite status summary on final page, sparse-filter bounded-scan continuation (`items: []` with non-null `nextCursor` keeps `LoadMore` active with `"No matches on this page yet. Load more to keep searching."` in both `AcceptanceLogTab` and `CustomerPoliciesTab`), filter selection + zero-result polite `role="status"` announcement, and `Clear filters`.
     - **Authorization & Evidence confidentiality**: `staff` (`policies.acceptances.read` only) sees no `Export CSV` control and sees `Encrypted` + `Requires policy management permission` in `AcceptanceEvidenceDialog` (`typedSignerName` omitted); `admin` (`policies.manage` + `policies.acceptances.export`) sees decrypted `typedSignerName` and `Export CSV`; `FORBIDDEN` server responses render `<ErrorState />` (never `<EmptyState />`).
     - **XSS / HTML inertness**: `<script>` payload inside policy `bodyText` renders strictly as plain text via `SafePolicyText` with zero script execution.
     - **Keyboard & focus management**: `RouteTabs` `Home` / `End` / `ArrowRight` + `Space` activation; `Tab` into the `tabIndex={0}` scrollable exact policy text region inside `AcceptanceEvidenceDialog`; `Escape` dismissal restoring focus to the exact `View evidence` launcher button.
     - **Step-Up MFA CSV export**: `STEP_UP_REQUIRED` response opens `StepUpProvider` verification dialog -> password + 6-digit TOTP submission -> single retry of `compliance.policies.admin.acceptanceLog.export` with active filters -> CSV blob download + toast confirmation.
     - **Coverage tab, Policy updates tab, Customer `Policies` tab, and Exact Version Text page**: per-policy coverage counts and outstanding customers list, published version timeline with change summaries and publishers, customer profile status per policy + history + version links, and `/admin/policy-acceptances/versions/:versionId` reader with SHA-256 hash and Print action.
     - **Automated WCAG 2.2 AA checks (`pageA11y` in both `light` and `dark` themes — 12 runs total)**:
       1. `/admin/policy-acceptances` (Log tab ready) — light & dark
       2. `/admin/policy-acceptances` (Evidence detail dialog open) — light & dark
       3. `/admin/policy-acceptances/coverage` (Coverage tab ready) — light & dark
       4. `/admin/policy-acceptances/updates` (Policy updates tab ready) — light & dark
       5. Customer profile `Policies` tab (`CustomerPoliciesTab` inside host `<main><PageHeader />`) — light & dark
       6. `/admin/policy-acceptances/versions/:versionId` (Exact version text page ready) — light & dark

---

## Tested Against Fakes / Fixtures

- `acceptances.test.tsx` exercises the real `TRPCProvider` (`httpBatchLink` + `dropInfiniteDirectionLink` + `superjson`), `AppRoutes`, `AppShell`, `StepUpProvider`, and `@/ui` primitives against fixture handlers matching `server/modules/compliance/API.md` §9.1 DTO shapes (`trpc.compliance.policies.admin.acceptanceLog.*`).
- Server-side database queries, cursor signing, formula-injection escaping, encrypted signer decryption, and step-up enforcement are verified in Package D1 (`server/modules/compliance/`).

---

## Not Verified Here

- Live browser visual rendering and hardware screen-reader narration (VoiceOver / NVDA) at 320 CSS px and desktop viewports (jsdom + `axe-core` verifies DOM structure, ARIA, landmarks, focus order, and token contrast, not CSS pixel geometry or `window.print()` print layout).
