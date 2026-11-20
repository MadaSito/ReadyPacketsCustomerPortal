# Accessibility — ReadyPackets portal

**Target:** [WCAG 2.2](https://www.w3.org/TR/WCAG22/) Level AA for the web portal and the installable PWA, at
viewport widths from 320 px to 1920 px, in light and dark themes.

**No conformance claim.** This document records design intent, automated evidence and gaps. It is **not** a WCAG
conformance statement, a VPAT/ACR, or a claim of ADA, Section 508 or EN 301 549 compliance. A conformance statement
requires the manual audit below on real browsers and assistive technology, and no such audit has been carried out.
There is no separate native mobile app; the mobile experience is the responsive web portal and its PWA.

Sources: [`client/src/ui/README.md`](../../client/src/ui/README.md) (design-system rules) and
[`client/src/app/VERIFICATION.md`](../../client/src/app/VERIFICATION.md) (UI evidence). Each module's own
`VERIFICATION.md` covers its screens.

## What the design system does

All feature code imports controls from `@/ui`, built on Radix primitives and Tailwind semantic tokens.

| Area | What the kit provides | Related WCAG 2.2 criteria |
| --- | --- | --- |
| Colour and contrast | Semantic colour tokens only, with the default palette removed. Every rendered foreground/background pair is computed against 4.5:1 (text) or 3:1 (UI) in both themes. State is never shown by colour alone (`StatusBadge` and `Badge` have an icon and text). | 1.4.1, 1.4.3, 1.4.11 |
| Focus | Visible 3 px focus ring with 3 px offset. `.rp-on-navy` switches to a lighter ring on the navy sidebar (≥ 3:1). Forced-colours mode uses a `CanvasText` outline. `scroll-padding-top: 5rem` keeps focused items clear of the sticky header. | 2.4.7, 2.4.11, 1.4.11 |
| Targets | Kit controls are at least 44 × 44 px (`IconButton` is 44 px square; footer links use `min-h-11` on mobile). | 2.5.8 (exceeds the 24 px minimum) |
| Structure | One `<h1>` per page via `PageHeader`, `main#main` landmark from the shell, a skip link that moves focus, `Section` with `aria-labelledby`, `<dl>` key-value lists, captions on every `DataTable`. Route changes move focus and announce the new title (`RouteFocus`). | 1.3.1, 2.4.1, 2.4.2, 2.4.6 |
| Forms | `Field` wires the label, hint, error, `aria-describedby`, `aria-invalid` and `aria-required`. Native `<select>`. Radio groups use `<fieldset>`/`<legend>`. Autocomplete attributes on auth forms; password show/hide. After a failed submit, focus moves to the error summary or the first invalid field. | 1.3.5, 3.3.1, 3.3.2, 3.3.3, 4.1.2 |
| Authentication | No CAPTCHA or cognitive puzzle; code fields do not block paste; passkeys are offered when enrolled; recovery codes can be copied or downloaded. | 3.3.8 |
| Overlays | `Dialog`, `ConfirmDialog` and `Drawer` trap focus, close with Escape and return focus. Destructive confirmations focus **Cancel** first. Dialogs are capped at `90dvh` with a scrolling body. Toasts are polite live regions (assertive for danger) and never take focus; their timer pauses on hover or focus. | 2.1.2, 2.4.3, 4.1.3 |
| Tables | Table layout at `md` and wider, stacked labelled cards below it. A mobile **Sort by** control, `aria-sort`, keyboard sorting, and a focusable, labelled scroll region for wide tables. | 1.3.1, 1.4.10, 2.1.1 |
| Motion and timing | `prefers-reduced-motion` reduces animations and transitions to near zero. The sign-in slideshow has pause/play and does not autoplay under reduced motion. The idle-timeout warning comes 2 minutes before sign-out and offers **Stay signed in**; the absolute session limit is announced ahead of time. | 2.2.1, 2.2.2, 2.3.3 |
| Language and theme | `<html lang="en">`; System, Light and Dark themes held in memory. | 3.1.1 |
| Images | Presentation slide images require an **Image description** (alt text) from the administrator. | 1.1.1 |

Feature authors still have to keep heading order, label icon-only actions, write meaningful link text and add an axe
test for each new page (`client/src/ui/README.md`, "Accessibility guarantees vs. your responsibilities").

## What is verified automatically

All automated checks run in **jsdom**, which has no layout or rendering engine.

| Check | Where | What it covers |
| --- | --- | --- |
| axe-core | `client/src/ui/ui.test.tsx`, `client/src/app/shell.test.tsx`, and the feature tests (`auth`, `dashboard`, `identity`, `assurance`, `orders`, `files`, `audit`, `siem`, `platform`, `jobs`, `portable`, `backup`) | Rules tagged `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice`. `color-contrast` is disabled (it cannot run in jsdom), and `region` is disabled for components rendered in isolation. |
| Contrast token math | `client/src/ui/tokens.test.ts` | Every rendered token pair meets 4.5:1 or 3:1 in both themes, and the TypeScript tokens match `styles/index.css`. This is the only contrast evidence. |
| Behaviour | `ui.test.tsx`, `shell.test.tsx`, `isolation.test.tsx`, `review.test.tsx`, `auth.test.tsx` | Dialog/Drawer focus trap and return, skip link, landmarks, field wiring, toast live regions, DataTable keyboard and mobile sorting, focus ring on navy. |

Run them with `scripts/dev/test.sh client/src` (or `pnpm test:client` in CI). When this document was written,
`client/src/ui` passed (`ui.test.tsx` 12/12 and `tokens.test.ts` 88/88 tests). The three `client/src/app` shell test
files failed to load because of an in-progress route-registry change (`TypeError … 'routeWrappers'`). Treat the shell
axe evidence as unconfirmed at that point.

## What is NOT verified

- No real-browser runs: no Playwright or axe in Chrome, Firefox or Safari, and no rendered colour-contrast scan.
  Contrast of images (for example, text inside uploaded slide images) is not covered by the token tests.
- No screen-reader passes: NVDA, JAWS, VoiceOver (macOS and iOS) and TalkBack have not been used.
- No zoom or reflow checks at 200% and 400%, no 320 px reflow check, and no text-spacing override check
  (WCAG 1.4.4, 1.4.10, 1.4.12).
- No rendered check of forced colours (Windows High Contrast), reduced motion, or focus not obscured by the sticky
  header and drawers (2.4.11).
- Passkey ceremonies have only been tested as UI wiring; the browser's WebAuthn dialogs are outside the portal's
  control.
- The PWA update prompt, offline page and analytics consent banner have not been checked in a browser.
- No testing with voice control, switch access or a screen magnifier.
- No user testing with people with disabilities.

## Manual test script

Use a release build (not the preview build) with synthetic accounts (`*.example.test`). Record the browser, assistive
technology and version, the page, the result and any defect ID. Test at least: sign in and MFA, enrolment and
recovery codes, Account security, Orders list, New order, order detail (each tab), file upload and download, Sessions,
the console overview, the Customers list and detail, the Audit center with filters, the SIEM editor, Settings and a
`ConfirmDialog` with type-to-confirm.

### 1. Keyboard only

1. Unplug the mouse or stop using the trackpad. Load each page and press Tab once. The skip link appears; activating
   it moves focus into `main`.
2. Tab through the whole page. Order follows the visual layout, every interactive element is reachable, and focus is
   always visible and never hidden behind the sticky header or an open drawer.
3. Use Enter or Space on buttons, arrow keys in radio groups, tabs and menus, and Escape on dialogs, drawers and menus.
   Focus returns to the control that opened them.
4. In a `DataTable`, sort with the keyboard (and with **Sort by** on mobile widths) and scroll a wide table using the
   focusable region.
5. Complete sign-in → MFA → the order form → submit, with no keyboard trap.
6. Let the idle warning appear and choose **Stay signed in** with the keyboard.

### 2. Screen readers

Run the same flows with **NVDA + Firefox or Chrome** on Windows and **VoiceOver + Safari** on macOS and iOS. Also run
TalkBack + Chrome on Android if possible.

- Each page announces its title after navigation. Headings form an outline (H for next heading) with one H1.
- Landmarks (D in NVDA, rotor in VoiceOver) list the banner, navigation, main and contentinfo.
- Form fields announce label, required state, hint and error. Errors are announced after a failed submit.
- Toasts and status callouts are announced without moving focus. `StatusBadge` reads its text, not just an icon.
- Tables announce the caption, column headers and sort state. Mobile cards read each value with its label.
- Dialogs announce their title and description, and the content behind them is not reachable.
- On **Recovery codes**, the codes are readable and the copy and download actions are announced.

### 3. Zoom and reflow

1. At 1280 px wide, zoom to **200%**. All content and functions remain available without loss or overlap.
2. Zoom to **400%** (or set the window to **320 CSS px** wide). Content reflows into one column with no horizontal page
   scrolling, except for data tables and code blocks inside their own scroll regions. Dialogs fit within the viewport,
   including in short landscape.
3. Apply a text-spacing bookmarklet (line height 1.5, paragraph spacing 2, letter spacing 0.12, word spacing 0.16). No
   text is clipped.
4. Check iOS and Android at their largest text size.

### 4. Reduced motion

Turn on **Reduce motion** in the operating system. Transitions and animations are effectively removed, the sign-in
slideshow does not autoplay, and nothing flashes.

### 5. Forced colours

On Windows, turn on a **Contrast theme**, then test in Edge or Chrome. Focus rings, control borders, badges, selected
tabs and the current navigation item stay visible. Icons that carry meaning have visible text alongside them.

### 6. Other

- Use a 24 px circle overlay to confirm target size on mobile layouts.
- Check that the sign-in page's uploaded slide images have meaningful alt text, and that any text inside them meets
  contrast.
- Check the dark theme for all of the above.

## Known issues

| ID | Issue | Impact | Status |
| --- | --- | --- | --- |
| A11Y-1 | No manual or assistive-technology audit has been done (everything in "What is NOT verified") | No conformance claim possible | Open |
| A11Y-2 | Footer links to `/privacy` and `/terms` have no routes and render "Page not found" | Users cannot reach the privacy or terms content from the footer | Open |
| A11Y-3 | Focus not obscured by the sticky header and drawers is mitigated (`scroll-padding-top`, skip link `scrollIntoView`), but not checked when rendered (VERIFICATION.md, "Sticky header and drawers") | Possible 2.4.11 failures | Partly addressed |
| A11Y-4 | `ConfirmDialog` height fix (C-06) not checked at 400% zoom or in short landscape | Possible 1.4.10 issue | Fix in code; unverified |
| A11Y-5 | Light-theme `text-success` on `bg-surface-sunken` is 4.46:1, below 4.5:1. The rule is to use `Badge` or `StatusBadge` instead; this is enforced by review, not by a test | Possible 1.4.3 failure if misused | Mitigated by convention |
| A11Y-6 | Contrast of text inside admin-uploaded slide images is not checked | Possible 1.4.3 or 1.4.5 issue on the sign-in page | Admin responsibility; documented |
| A11Y-7 | Passkey, PWA update prompt, offline page and analytics consent banner not checked in a browser | Unknown | Open |
| A11Y-8 | `client/src/app` shell, isolation and review test files failed to load at the time of writing (`routeWrappers` TypeError during in-progress integration) | Shell axe and focus evidence unconfirmed for that state | Reported to integrator |
| A11Y-9 | Screens for messages, support, policies, intake, invoices, backups and integrations were uncommitted at the time of writing and are not covered by this document's evidence | Unknown until their tests run | Pending |

Report accessibility problems through the issue templates in `.github/ISSUE_TEMPLATE/` and include the browser,
assistive technology, page and steps.
