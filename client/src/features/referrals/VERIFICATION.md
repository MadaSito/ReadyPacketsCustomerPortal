# Package G — Client Referrals UI & Accessibility Verification (`client/src/features/referrals`)

## Scope
Customer referral page (`/account/referrals`), Console referral management & ledger page (`/admin/referrals`), and registration referral-code capture wrapper (`RegisterReferralCapture` on `/register`), designed and tested against WCAG 2.2 AA in both light and dark themes.

## Automated Verification Run
- **Typecheck**: `scripts/dev/tc.sh client/src/features/referrals` — 0 diagnostics.
- **Lint**: `scripts/dev/lint.sh client/src/features/referrals` — 0 warnings / 0 errors.
- **Component, RBAC & Accessibility Suite**: `scripts/dev/test.sh client/src/features/referrals/referrals.test.tsx` — **13 / 13 passed** (10 `pageA11y` light/dark document scans + 3 route, workflow, and RBAC tests).

## Accessibility Evidence (`INCREMENT_04_CONTRACT.md` §4.2)

| Route | State | Theme | Automated Tool (`@/test/a11y` `pageA11y` + `axe-core` + landmark/`<h1>`/title checks) | Result |
| --- | --- | --- | --- | --- |
| `/account/referrals` | Ready (share link, stats, masked history table) | `light` | `pageA11y` full-document scan via `AppRoutes` + `CustomerShell` | 0 violations (passed) |
| `/account/referrals` | Ready (share link, stats, masked history table) | `dark` | `pageA11y` full-document scan via `AppRoutes` + `CustomerShell` | 0 violations (passed) |
| `/account/referrals` | Disabled (`feature.referrals = false` / `REFERRALS_DISABLED`) | `light` | `pageA11y` full-document scan | 0 violations (passed) |
| `/account/referrals` | Disabled (`feature.referrals = false` / `REFERRALS_DISABLED`) | `dark` | `pageA11y` full-document scan | 0 violations (passed) |
| `/account/referrals` | `E-mail my link` modal dialog open in portal | `light` | `pageA11y` full-document scan including portal dialog | 0 violations (passed) |
| `/account/referrals` | `E-mail my link` modal dialog open in portal | `dark` | `pageA11y` full-document scan including portal dialog | 0 violations (passed) |
| `/admin/referrals` | Ready (summary, filter bar, referrals table, tabs) | `light` | `pageA11y` full-document scan via `AppRoutes` + `ConsoleShell` | 0 violations (passed) |
| `/admin/referrals` | Ready (summary, filter bar, referrals table, tabs) | `dark` | `pageA11y` full-document scan via `AppRoutes` + `ConsoleShell` | 0 violations (passed) |
| `/admin/referrals` | `Approve referral reward` modal dialog open in portal | `light` | `pageA11y` full-document scan including portal dialog | 0 violations (passed) |
| `/admin/referrals` | `Approve referral reward` modal dialog open in portal | `dark` | `pageA11y` full-document scan including portal dialog | 0 violations (passed) |

## Design & Manual / Browser Checklist Status
- **Landmarks, single `<h1>`, ordered `<h2>` sections, labelled inputs (`<Field>`), error messaging (`aria-invalid` + `aria-describedby`), non-colour status indicators (text + icon badges), and keyboard-operable Radix dialogs (`<Modal>`)**: Built on `@/ui` primitives and verified in jsdom tests (`referrals.test.tsx`).
- **Live browser rendering at 320 CSS px / 400 % zoom, computed CSS contrast ratios on rendered pixels, text-spacing override bookmarklet, `prefers-reduced-motion` visual check, and assistive-technology screen-reader walkthrough (NVDA / VoiceOver)**: **not checked** in this worker sandbox (jsdom does not compute layout geometry or real CSS pixel contrast; queued for the central browser QA pass).
