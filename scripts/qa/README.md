# Browser QA scripts

Run against a **disposable** QA portal only. Both scripts share `lib/browser.mjs` (local Chromium, no download)
and `lib/routes.mjs` (every registered route, fixtures from `QA_ROUTE_FIXTURES`).

| Script | Checks |
|---|---|
| `a11y-check.mjs` | axe-core WCAG 2.2 AA tags at 1280 / 640 / 320 px reflow sizes, both themes (see `docs/verification/ACCESSIBILITY.md`). |
| `responsive-check.mjs` | Every route × 240, 320, 390, 768, 1024, 1440, 1920, 2560 px × light and dark. Fails on page horizontal overflow, clipped text (unless the element scrolls or truncates with an accessible full value) and visible tap targets under 24×24 px that lack the WCAG 2.5.8 spacing exception. Inline links in sentences are exempt. |

```sh
QA_BASE_URL=https://qa.example.internal QA_ROUTE_FIXTURES=qa/fixtures.json node scripts/qa/responsive-check.mjs
```

Optional: `QA_CHROMIUM_PATH`, `QA_ROUTE_FILTER` (route ID substring) and `QA_WIDTHS=320,1440`. Either filter marks the
run as partial, which is not release evidence. Missing fixtures (for example the active customer-maintenance banner or the
Maintenance console, which need seeded state) are reported as `NOT CHECKED` and make the run exit non-zero.
Raw browser errors are never printed because they can contain tokens.

By default matrix cases use a fresh browser context and page for every width. Opt in with `QA_REUSE_CONTEXT=1`
to retain the context only within the same route fixture, theme and input mode, while opening a fresh page and
restoring the fixture cookies, storage and viewport for every measurement. Theme and scroll start fresh at each
width; throttled retries always start from a fresh browser context. Both scripts name the mode in the log header.
Literal native zoom (`QA_LITERAL_ZOOM=1`) always uses a fresh profile and ignores context reuse.
Unreadable or unreachable cases are retried once at the end of the matrix in a fresh context. If they
still cannot be measured, they are `NOT CHECKED`, not a product finding or a passing result.
The matrix runs anonymous, auth-transition and customer cases before staff and admin cases.

## Shared fixtures and sessions

`fixtures.example.json` is the shared `QA_ROUTE_FIXTURES` template. Copy it outside the repo and add seeded `cases`
(schema in `docs/verification/ACCESSIBILITY.md`). Anonymous cases use a clean context, so they need no state.
`capture-state.mjs` signs the synthetic customer, staff and admin accounts in through the real password + TOTP UI. It
writes `<role>.state.json` (0600) into `QA_STATE_DIR` (0700, which must be outside the repo), and it refuses to type
credentials unless `QA_EXPECT_ORIGIN` equals `QA_BASE_URL`. Credentials come from `QA_<ROLE>_EMAIL` / `_PASSWORD` /
`_TOTP_SECRET`. Put the fixture file in the same directory so relative session paths resolve.

A route kept only as a redirect alias (for example `/account/sessions` → `/account/security`) needs a case with
`redirectsTo`, the full document `title` and `heading` for its destination; the check then scans the destination and fails if the alias
lands anywhere else. Any other redirect still fails the case.

An explicit admin or staff case on a customer route can use `enterViaCustomerPortal: true` to exercise
the visible Customer portal switch before checking the target path. For form states, a `steps` item may
use an exact `testId`, an exact `label` (or `labelPrefix: true`), or a role and `name` (or `namePrefix: true`).
The operation is a `key` press (default `Enter`) or synthetic `text` input.
Use `first: true` only when any matching control can advance the fixture, such as the first catalog item.

## Increment 08 focused sweep

Set `QA_SUITE=increment-08` for both runners. It checks named states at **240, 320, 390, 640, 768, 1024, 1280 and 1440 CSS px** in
both themes. With `QA_LITERAL_ZOOM=1` the axe runner instead retains its existing native 100%/200%/400% zoom matrix.
This focused output is not release-wide evidence. `QA_ROUTE_FILTER` can match a route ID or a state name.

On a disposable instance, copy [the Increment 08 fixture template](fixtures.increment-08.example.json) beside private
storage-state files and replace placeholders with synthetic fixtures. Run the responsive script first, then the axe script:

```sh
export QA_BASE_URL=https://qa.example.internal QA_SUITE=increment-08 QA_ROUTE_FIXTURES=/private/qa/fixtures.json
node scripts/qa/responsive-check.mjs
node scripts/qa/a11y-check.mjs
```

The fixture map is keyed by state name. Missing routes, session files or required setup are reported as `NOT CHECKED`.
If a state has no built-in readiness selector, supply `ready` that proves the specific UI, not just `main h1`.
Only supply non-submitting fixture steps. Do not buy, publish, save billing details, accept policies or upload. In particular:

- **Registration and billing:** `/register` checks the name fields and the open optional billing section. `/account/billing` checks
  customers with and without saved data; use separate customer sessions.
- **Orders:** `/orders/new` covers tier expansion; `/orders/new?addTo=<publicId>` must show an already-purchased packet on an
  active order owned by the fixture customer. `/orders/:orderId` checks active, awaiting payment, awaiting team, and delivered
  for both configured phase workflows and legacy derived workflows. Seed eight customer-owned orders, one per state, with an actionable
  step for active cases, an issued invoice with a positive balance for payment cases, and the completion action for delivered cases.
  Do not advance past steps that save or submit data.
- **Checkout:** `/cart` and `/cart/checkout` cover the locked add-to-project flow; `/cart/checkout` also covers saved billing
  and custom entry with and without a saved profile. Use synthetic non-empty carts.
  `/checkout/return` covers paid, processing, terminal unpaid, invalid and missing-target states. Use separate seeded attempt IDs
  for paid, processing and terminal unpaid, and a known nonexistent ID for invalid. Attempt-specific states require `checkoutSandbox: true`.
  This flag only acknowledges the safety requirement: **you must configure the server with a sandbox or
  deterministic fake payment provider**, because opening a return page can reconcile an attempt. Never use live payment credentials.
  `/admin/payments/setup` checks the Stripe webhook diagnostics panel without clicking a test or changing configuration.
- **Publishing:** `/admin/workflows` and `/admin/workflows/drafts/:draftId` open Publish dialogs for a valid synthetic draft.
  A separate invalid draft checks that Publish is blocked and explains why. Do not confirm the dialog or authorize step-up.

## Rate limits

Every QA browser shares one client IP, so a full run can exceed the instance's per-IP budgets (each page load makes
several tRPC calls). If the instance answers 429, the runners wait for `Retry-After` (5–120 s) and retry the
scenario once in a fresh context. Continued rate limiting defers the case to the end of the matrix; if it still
cannot be measured, it is `NOT CHECKED` and counted separately in the summary. On a disposable QA instance an administrator can raise
the `api` and `standard_browsing` budgets within their safe bounds in Console → Protection → Rate limits, then
restore the defaults afterwards. The process-local edge pre-gate (120 requests per 10 s per IP, static files
included) is not configurable, so the runners serve content-hashed `/assets` files from an in-process memory cache after
the first fetch (`routeQaContext`); navigations and API calls always reach the server.
