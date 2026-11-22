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

## Shared fixtures and sessions

`fixtures.example.json` is the shared `QA_ROUTE_FIXTURES` template. Copy it outside the repo and add seeded `cases`
(schema in `docs/verification/ACCESSIBILITY.md`). Anonymous cases use a clean context, so they need no state.
`capture-state.mjs` signs the synthetic customer, staff and admin accounts in through the real password + TOTP UI. It
writes `<role>.state.json` (0600) into `QA_STATE_DIR` (0700, which must be outside the repo), and it refuses to type
credentials unless `QA_EXPECT_ORIGIN` equals `QA_BASE_URL`. Credentials come from `QA_<ROLE>_EMAIL` / `_PASSWORD` /
`_TOTP_SECRET`. Put the fixture file in the same directory so relative session paths resolve.

## Rate limits

Every QA browser shares one client IP, so a full run can exceed the instance's per-IP budgets (each page load makes
several tRPC calls). If the instance answers 429, the runners wait for `Retry-After` (5–120 s) and retry the
scenario once in a fresh context. A second 429 is reported as `rate limited … (not a page result)` and counted
separately in the summary; it is never a pass or a page defect. On a disposable QA instance an administrator can raise
the `api` and `standard_browsing` budgets within their safe bounds in Console → Protection → Rate limits, then
restore the defaults afterwards. The process-local edge pre-gate (120 requests per 10 s per IP, static files
included) is not configurable, so the runners serve content-hashed `/assets` files from an in-process memory cache after
the first fetch (`routeQaContext`); navigations and API calls always reach the server.
