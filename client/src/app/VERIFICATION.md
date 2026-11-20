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

## Not verified / not done

- No real-browser runs: no Playwright/axe in a browser, no responsive screenshots at 320, 768, 1280 and 1920 px, no 200%/400% zoom or reflow checks, no forced-colors or reduced-motion visual checks.
- No screen-reader passes (NVDA, JAWS, VoiceOver, TalkBack).
- Passkey ceremonies were tested only as UI wiring (`@simplewebauthn/browser` is not exercised in jsdom).
- Service worker: registration and the update prompt are untested until the integrator adds vite-plugin-pwa. Offline behaviour has not been checked.
- Idle timeout values (30 minutes, warning 2 minutes before) are assumptions. They should come from server session policy.
- The analytics consent banner depends on the integrations feature shipping `features/integrations/consent.tsx`.
- The production build has not been run by me since the latest commits (it is the integrator's responsibility).
