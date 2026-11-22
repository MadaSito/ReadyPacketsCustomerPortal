# Portal accessibility verification

The ReadyPackets portal is designed and tested against WCAG 2.2 AA. This register separates automated DOM evidence, real-browser layout and contrast evidence, and manual assistive technology evidence. An automated pass is not a conformance determination. Unchecked workflows and incomplete axe results still need review.

## Page owner gate

Add a `pageA11y` case in light and dark for every new page, and additional cases for central interactive states such as dialogs. See the [page test API and how-to-pass guide](../../client/src/test/API.md). Use the real `AppRoutes`/shell where practical, wait for the intended content and include a heading, title and one main landmark. Run the feature’s test file with `scripts/dev/test.sh <test-file>`. Do not suppress relevant rules or count a loading/error/permission page as the feature’s successful state.

## Disposable Chromium run

Only run this against an isolated synthetic database and matching working-tree build. Enable the features under review there. Use a local sandbox or otherwise authorized QA instance, not the live portal. Use Playwright storage-state files from dedicated synthetic local MFA accounts for `customer`, `staff`, `admin`, and exact remediation states. Store files with private permissions outside the repository, never upload them or include them in evidence, and revoke the sessions after testing. The driver does not install Chromium; use `QA_CHROMIUM_PATH` for your executable or let it select an executable from the Playwright cache.

```sh
source scripts/dev/env.sh
QA_BASE_URL=http://localhost:5000 \
QA_ROUTE_FIXTURES=/private/qa/route-fixtures.json \
node scripts/qa/a11y-check.mjs
```

The same scenario catalogue is available to the responsive runner. Catalogue entries come from the current registry through a jsdom test (including attached order and customer tabs and a missing-route case). Static pages are included automatically under a role that can reach them; the public Accessibility route is checked anonymously and signed in. Staff routes have staff and admin cases. Parameterized routes, remediation transitions, and token-dependent reset/verification/activation/SSO completion require explicit concrete paths and a selector only visible in the intended state. Authenticated cases also require the corresponding session. Add cases for additional states, such as a modal open, an empty list, and a populated list. Do not include credentials or private content in selectors, names, fixture filenames or recorded evidence.

```json
{
  "sessions": {
    "customer": "customer.state.json",
    "staff": "staff.state.json",
    "admin": "admin.state.json"
  },
  "cases": {
    "/orders/:orderId": [
      { "role": "customer", "path": "/orders/01QA_SYNTHETIC_ORDER", "ready": "[data-testid='seeded-order-ready']" }
    ],
    "/mfa": [
      { "role": "transition", "storageState": "mfa.state.json", "ready": "input[autocomplete='one-time-code']" }
    ],
    "/account/security": [
      { "role": "customer", "ready": "[data-testid='seeded-security-card']" },
      { "role": "customer", "heading": "Account security", "steps": [{ "role": "button", "name": "Generate new recovery codes" }], "ready": "[role='alertdialog']" }
    ]
  }
}
```

- **Fixture values**: Paths and readiness selectors in the sample are placeholders; use the seeded IDs and actual selectors. Signed-in cases can override `storageState` per scenario (paths relative to the manifest). An optional `heading` checks the exact accessible name; `steps` activate named controls with Enter. Use only safe UI interactions. For an exact catalogue ID and title, run `node --input-type=module -e 'import { qaRouteInventory } from "./scripts/qa/lib/routes.mjs"; console.table(await qaRouteInventory());'`.
- **Coverage no longer implicit**: Missing authenticated/parameterized/transition fixtures yield `NOT CHECKED` and a non-zero exit. The runner probes the session role, checks exact URL and title, requires one visible `h1` within the main landmark, and uses real Chromium axe (including contrast and landmark rules). `QA_ROUTE_FILTER` can narrow to a literal route ID substring for a smoke test; filtered results are partial. One-shot reset/SSO links and memory-only recovery handoffs also require separate manual or integration coverage, not an anonymous URL screenshot.
- **Zoom and layout**: By default the runner checks no page-level horizontal overflow at 1280, 640, and 320 CSS px. The latter two are layout equivalents of 200% and 400% zoom from a 1280 CSS px baseline, not actual browser zoom. For actual 100%, 200%, and 400% desktop zoom, set `QA_LITERAL_ZOOM=1` and use a Chromium build that supports unpacked headless extensions. The permission-free local test extension changes the tab zoom in a new throwaway Chromium profile; the harness verifies Chromium's reported factor, device-pixel ratio, and reflow width before scanning. It never falls back to viewport simulation in that mode. Literal mode is slower; start with a filtered smoke test and retain manual keyboard, clipping, and assistive-technology checks. Do not count a passing check when axe returns rules needing manual review.

## Manual checklist

- **Landmarks, language, and navigation**: Verify `lang`, useful page title, one `h1`, ordered headings, main and skip link. Follow links between routes: on client navigation, `RouteFocus` should move focus to the heading or main and announce the change without duplicate announcements. Check link purpose and consistent help/navigation location.
- **Keyboard, pointer, and dialogs**: Check Tab and Shift+Tab order, keyboard activation, visible focus of at least 3:1 and not obscured by sticky elements, and no traps. Dialog arrows/tab/escape behavior should match the widget pattern; modal focus stays inside and returns to the trigger. For safety acknowledgement, confirm there is a keyboard-operable cancellation path. Validate drag alternatives and targets at least 24 × 24 CSS px (44 preferred on touch).
- **Assistive technology**: Test NVDA/Firefox and VoiceOver/Safari where available. Verify accessible names, roles and states, menus, errors, status, live-region feedback, tables/headers, and motions of focus. For forms check labels, `autocomplete`, field-associated messages, no redundant re-entry or cognitive tests, paste and password managers.
- **Contrast in light and dark**: Record foreground/background ratios for default, disabled where applicable, active, selected, hover, invalid and focus states. Text requires at least 4.5:1, large text and relevant UI controls and focus at least 3:1. Check actual rendered pairs, including overlays, against the token values. Color must not be the sole signal.
- **Reflow and motion**: At literal 200% and 400% browser zoom (1280 CSS px desktop baseline, 320 CSS px at 400%), and at a 320 CSS px viewport, verify no clipped controls or two-dimensional page scroll. Tables may use an independently scrollable labelled area. Apply text-spacing overrides (line height 1.5, paragraph spacing 2×, letter spacing 0.12em, word spacing 0.16em); check clipping. Hover/focus content must remain hoverable, persistent and dismissible; respect reduced motion and avoid flashing.
- **Feedback, timeouts, and media**: Check status messages announced once, progress updates meaningful, timeout warning announced with time to extend, and no unexpected content changes. Verify named record/playback controls, visible duration and a labelled optional transcript field for audio.

## Evidence

| Route or state | jsdom axe | Real Chromium, both themes | Manual keyboard, assistive technology, contrast and literal zoom |
| --- | --- | --- | --- |
| `/accessibility`, anonymous and full customer | Passed, both themes (`accessibility.test.tsx`, four cases) | Not checked | Not checked |
| `/account/security`, two-factor content and recovery confirmation | Passed, both themes (`assurance.test.tsx`, four cases); real registered Identity cards not covered by these fixture cases | Not checked | Not checked |
| Public sign-in, registration, reset, policy, SSO and fallback; account-transition routes | Not checked in this review | Not checked | Not checked |
| Customer orders/files/audio, account/sessions, policies/privacy, support/messages, notifications/search, and feature-flagged customer flows | Not checked in this review | Not checked | Not checked |
| Staff/admin routes and registered detail tabs, including protection, identity, privacy, audit, payments, integrations, and operations | Not checked in this review | Automated sweep at `50a7dd6`, targeted recheck at `b00f8df`; see Increment 04 automated run below | Not checked |
| Customer routes (all catalogued, synthetic fixtures) | See page tests | Automated sweep at `50a7dd6`, targeted recheck at `b00f8df`; see Increment 04 automated run below | Not checked |

Use one row per concrete route/state when recording results. Include the commit, fixtures (non-secret names), role, browser/OS/assistive technology versions, themes, zoom/viewport and the evidence source. Attach a short finding and disposition for failures. The route catalogue gives the full route inventory; these grouped unchecked rows make no claim about other suites or live accessibility.

## Increment 04 automated Chromium run

This is automated evidence only. Literal 200%/400% browser zoom (`QA_LITERAL_ZOOM`) was not used, and no assistive technology (NVDA, JAWS, VoiceOver, TalkBack) was exercised. The reflow numbers come from viewport widths, not real browser zoom. Axe "incomplete" results, such as colour contrast over overlays, still need manual review and are not counted as passes. All data was synthetic, on an isolated local dev instance (`127.0.0.1:5034`) with dedicated synthetic local MFA accounts (customer, staff, admin). Session-state files, logs and screenshots were stored outside the repository with private permissions and are not part of this evidence.

### Full sweep at build `50a7dd6` (22 Nov 2026)

| Runner | Executed | Failed | Rate-limited | Not checked (missing fixture) | Widths |
| --- | --- | --- | --- | --- | --- |
| `scripts/qa/a11y-check.mjs` | 1002 | 26 | 0 | 24 | runner default |
| `scripts/qa/responsive-check.mjs` | 2672 | 46 | 0 | 24 | 240, 320, 390, 768, 1024, 1440, 1920, 2560 |

Routes with failures were sent to their owning features. The UI foundation fixes from this round: `02ecbb1` (buttons wrap below 360 px), `445e025` (card and page-header action rows), `620cae1` (DataTable scroll region contains positioned cells), `88b1765` (RouteTabs re-measure), `00b4899` (workflow canvas label overlap, field hints wrap). Fixes in other features: `069a7d2` (customer credentials tab), `0bf7e56` (webhooks), `12ffb84` (customer engagement widget), `b00f8df` (referrals heading), `f34a9a4` (backups at 240 px), `c2caddd` (invoice link target).

### Targeted recheck at build `b00f8df` (22 Nov 2026)

Only the routes and widths that failed in the full sweep were rerun, plus `/admin/storage/new` at 240 px and the customer Credentials tab at 320 px in both themes. This was not a new full sweep.

| Route | Check | Width(s) | Result |
| --- | --- | --- | --- |
| `/admin/customers/:customerId#credentials` | axe | — | Fixed, 6 executed / 0 failed |
| `/admin/integrations/webhooks` (incl. inbound, deliveries) | axe | — | Fixed, 18 / 0 |
| `/admin/referrals` | axe | — | Fixed, 12 / 0 |
| `/admin/sharepoint-sync` | axe | — | Fixed, 6 / 0 |
| `/orders/new` | axe | — | **Still failing**: 6 / 3, `page-has-heading-one` (intermittent). The policy gate's heading is hidden by the route Suspense fallback while the lazy page loads. Routed to compliance. |
| `/account/security`, `/account/sessions`, `/admin/audit/integrity`, `/admin/catalog`, `/admin/maintenance`, `/admin/orders/:orderId/automation`, `/admin/orders/:orderId/sync`, `/admin/settings` | overflow | 240 | Fixed, 0 failed |
| `/admin/backups` | overflow | 240 | Fixed, 6 / 0 (1 case not checked: missing fixture) |
| `/admin/customers/:customerId` (incl. `#credentials`, `#orders`), light and dark | overflow | 240, 320 | Fixed, 20 / 0 |
| `/admin/integrations/webhooks` | overflow | 768, 1024 | Fixed, 12 / 0 |
| `/admin/knowledge` | overflow | 1024 | Fixed, 12 / 0 |
| `/invoices` | overflow | 390 | Fixed, 18 / 0 |
| Customer `/`, light and dark | overflow | 240 | Fixed, 0 px overflow |
| `/admin/storage/new` | overflow | 240 | **Failing at `b00f8df`**: 2 / 2, 4 px. Caused by an unbreakable token in a radio option description. Fixed in `838de62` (radio labels and descriptions wrap). The fix was checked with an in-page style simulation (0 px) but not yet rerun on a rebuilt server. |

Open items: rerun `/orders/new` (axe) and `/admin/storage/new` (240 px) on a build that contains the compliance fix and `838de62`. Manual keyboard, assistive technology, contrast and literal zoom checks from the checklist above remain outstanding for all routes.
