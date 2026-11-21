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
