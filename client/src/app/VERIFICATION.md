# Verification — UI foundation (kit, app composition, auth, dashboard, PWA)

This document lists the evidence we have. It is **not** a WCAG/ADA certification. The target is WCAG 2.2 AA, 320–1920 px, 44 px targets and reduced motion. Automated checks run in jsdom (no layout engine). Manual checks with assistive technology have **not** been done yet.

## Automated tests (run with `scripts/dev/test.sh client/src/{ui,app,features/auth,features/dashboard}`)

| File | Verifies |
| --- | --- |
| `ui/tokens.test.ts` | Every rendered foreground/background token pair meets 4.5:1 text or 3:1 UI contrast (light and dark), and the TS tokens mirror `styles/index.css`. This is the contrast evidence, because axe's color-contrast rule cannot run in jsdom. |
| `ui/ui.test.tsx` | axe checks on the kit. Dialog focus trap, Escape and focus return. Drawer focus. DataTable keyboard sorting, aria-sort and the mobile card rendering. Field label, hint and error wiring. Toast live regions. |
| `app/guard.test.ts` | `decideRoute` for every session state × access level. `safeNextPath` open-redirect cases. |
| `app/shell.test.tsx` | axe checks on CustomerShell and ConsoleShell. Landmarks, `main#main`, the skip link moving focus, and the footer legal line and external link attributes. AppRoutes integration: anonymous → sign-in, remediation held at its step, customer blocked from the console as not-found, staff allowed, signed-in user sent away from sign-in, unknown path → 404. |
| `app/isolation.test.tsx` | Private cache purged on A → 401 → B and on a direct A → B swap (same role, seeded assurance/private data). Sign-out does not fake success when revocation fails. TOTP seed absent from the query and mutation caches. Mobile DataTable sort controls and the focusable table region. Preview hash query splitting. |
| `features/auth/auth.test.tsx` | axe checks on all 10 auth/transition screens. Uniform, non-enumerating sign-in error (no server text leaks). Local validation without a server call. `nextStep` navigation and an unsafe `?next` being ignored. Password show/hide and autocomplete attributes. "Create an account" link. Forgot-password accepted message plus preview callout. Reset strips the token and enforces length. Verify-email calls the server once. Passkey offered only when enrolled. The full enrol → codes → acknowledgment → continue flow. Reissue path. The text-file content. |
| `features/dashboard/dashboard.test.tsx` | Widget filtering and sorting by area and role. Required-action derivation. axe checks on the customer home and console overview (greeting, first-order guide). |

The axe runs use the wcag2a/aa, wcag21a/aa, wcag22aa and best-practice tags. color-contrast is disabled (covered by the token tests), and so is region (components are rendered in isolation).

## Review findings (docs/security/REVIEW-client.md)

| ID | Status | Fix and evidence |
| --- | --- | --- |
| C-01 | Closed | The TOTP setup material is fetched directly into component state, never through TanStack, and is cleared on confirm or unmount. Evidence: `isolation.test.tsx` "keeps the TOTP seed out of the query and mutation caches". |
| C-02 | Closed | `IdentityScope` keys the private cache on user, role, session state and next step. On a change the subtree is withheld while every non-`me` query and all mutations are purged. A non-`me` query failing with UNAUTHENTICATED re-checks `me`. The preview bridge uses the same purge. Evidence: `isolation.test.tsx` covers A → 401 → B and a direct A → B swap (same role, seeded private and assurance data). |
| C-03 | Closed | Sign-out only succeeds once revocation is confirmed. On failure, local data is wiped, `me` is re-checked, and if the session is still live the user stays on the page with an error (`isolation.test.tsx` sign-out tests). In preview, the transport clears the local session and CSRF header credentials on the `identity.signOut` POST before the fetch awaits, and ignores late credential replies (http_security, 521b46c). |
| C-04 | Closed (client) | The register page never renders `previewLink`. Preview users get the link from the signed-in "Send a new link" on `/verify-email`. Evidence: `review.test.tsx` "register is uniform". Server-side uniformity of the preview response belongs to identity. |
| C-05 | Closed | Preview routing uses paired hooks. `previewNavigate` writes `#/path?query` and clears the document search, and the location/search hooks parse the same representation. Copied links with the query inside the hash now match. Evidence: `isolation.test.tsx` and `review.test.tsx` hash tests. |
| C-06 | Closed | ConfirmDialog is limited to `max-h-[90dvh]`, with a scrollable body and a fixed action footer. Zoom and short-landscape checks are still pending in a real browser. |
| C-07 | Closed | Toast tracks hover and focus-within separately and resumes the timer only when both are released. |
| C-08 | Closed | DataTable has a mobile "Sort by" select and a direction toggle driven by the same sort state. The wide-table wrapper is a focusable, labelled region. Evidence: `isolation.test.tsx` "DataTable mobile sorting". |
| Focus on navy | Closed | `.rp-on-navy` switches the focus ring to teal-light on the console sidebar and drawer. It stays at 3:1 or better against navy and navy-elevated in both themes (`review.test.tsx`). |
| Sticky header and drawers | Partly | `html { scroll-padding-top: 5rem }`, the skip link uses `preventScroll` plus `scrollIntoView`, and overlays do not restore focus when closing caused a navigation. Rendered focus-obscuration checks are pending /root's browser QA. |

The H-3 preview banner is a permanent, non-dismissible "Preview — synthetic data only" notice in the public, customer and console frames. It appears when `platform.presentation.preview` is true or the build is the preview runtime (`review.test.tsx`).

The idle timeout reads `me.session.idleTimeoutSeconds` (identity 84d3089), with a 30-minute fallback if the field is missing or invalid. The warning comes 2 minutes before, or at half the limit for very short policies. A warning toast also appears 2 minutes before `absoluteExpiresAt`, which cannot be extended, and the session is re-checked once it passes. Background refetches refresh the server's lastSeenAt, so this client input-idle timer is the signal for human inactivity, and it signs the user out.

**INT-01, realm quarantine (third-party analytics).** `lib/realmTaint.ts` holds a module-memory, one-way taint flag. Integrations call `markRealmTainted("clarity"|"posthog")` synchronously before any vendor script or request. When the realm is tainted:
- `RealmTaintBoundary` (the app root, above the router and shells) renders only a neutral "Reloading securely…" status for any non-anonymous session. It then calls `location.replace(<pathname>)` once; search and hash are stripped.
- `TaintedRouteGate` lets only `/privacy` and `/terms` render. Every other location, including sign-in, is left with `location.assign` and never rendered in the tainted realm.
- `RouteGate` forces the anonymous PublicFrame and drops the idle timer.

`requestCleanRealm` fires at most once per document. `app/realmTaint.test.tsx` uses a MutationObserver over every commit to show that no user name, email or shell navigation is ever committed, and checks the exact navigation calls.

**Session refetch loop (found while testing INT-01).** An anonymous visitor's `me` is an error with no data. TanStack refetched it each time a new observer mounted, and a refetch with no data resets the status to pending. Any public page that reads the session could therefore loop: loader, unmount, remount. The fix is `retryOnMount: false` on the `me` query in `lib/session.ts`, covered by a regression test (exactly one `me` call).

## Not verified / not done

- No real-browser runs: no Playwright/axe in a browser, no responsive screenshots at 320, 768, 1280 and 1920 px, no 200%/400% zoom or reflow checks, no forced-colors or reduced-motion visual checks.
- No screen-reader passes (NVDA, JAWS, VoiceOver, TalkBack).
- Passkey ceremonies were tested only as UI wiring (`@simplewebauthn/browser` is not exercised in jsdom).
- Service worker: VitePWA is configured by the integrator (navigations NetworkOnly with an offline.html fallback, index.html not precached, /api NetworkOnly). The update prompt and offline behaviour have not been checked in a browser.
- The analytics consent slot is now provided by integrations (3f99849). It has not been checked in a rendered browser.
- The production build has not been run by me since the latest commits (it is the integrator's responsibility).
