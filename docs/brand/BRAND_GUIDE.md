# ReadyPackets — Current Brand Guide

**Package date:** 20 November 2026
**Verified repository source baseline:** `16820fce1205b1447b2683b1507dd5d14cfbfe04`

This guide describes the current approved web identity, not a redesign. Its implementation sources are `shared/brand.ts`, `client/src/components/brand/ApprovedBrandLogo.tsx`, and `client/src/styles/index.css` at the verified baseline above. Historical package/version comments in those files do not authorize retired artwork. No superseded guide was used.

## 1. Name, tagline, and brand pillars

Use **ReadyPackets** as the short name: one word, with capital R and P. The source display wordmark is **ReadyPackets™**. The legal company name is **Ready Packets Consulting LLC**.

The tagline is **Your Business, Professionally Packeted™**. The source also provides the plain-text form **Your Business, Professionally Packeted**. Preserve the wording, capitalization, and comma. Reproducing the source’s ™ does not establish trademark registration; this guide makes no registration or legal-status claim.

The four brand pillars, quoted exactly from `BRAND_PILLARS`, are:

| Pillar | Source wording |
| --- | --- |
| Professionalism | Every touchpoint reflects expertise, clarity, and polish. |
| Reliability | Clients trust us to deliver on time, every time. |
| Clarity | Complex business needs translated into actionable documents. |
| Momentum | We exist to help businesses move — fast and with confidence. |

## 2. Approved logo artwork

The active full web lockup consists of **four supplied PNG components per appearance**, served locally from `/brand/`:

| Component | Light appearance | Dark appearance |
| --- | --- | --- |
| Icon | `readypackets-approved-header-icon-light.png` | `readypackets-approved-header-icon-dark.png` |
| Wordmark | `readypackets-approved-header-wordmark-light.png` | `readypackets-approved-header-wordmark-dark.png` |
| Rule | `readypackets-approved-header-rule-light.png` | `readypackets-approved-header-rule-dark.png` |
| Tagline | `readypackets-approved-header-tagline-light.png` | `readypackets-approved-header-tagline-dark.png` |

Use the **light set for light appearance** and the **dark set for dark appearance**; select the complete matching set rather than mixing variants. Check visibility against the actual placement background. Do not manufacture another variant by recoloring or filtering the light or dark files.

`ApprovedBrandLogo` is the current full-lockup implementation. It places the icon beside a vertical wordmark/rule/tagline stack, retaining each component’s native aspect ratio with automatic height. The icon uses `18%` width; wordmark and rule use the stack’s full width; tagline uses `95%`. The layout uses `gap-2` between icon and stack and `gap-0.5` within the stack. These are implementation relationships, not a new dimensional production specification. `ApprovedBrandIcon` is the approved compact-mark component and uses `object-contain`.

**Preserve the original PNG component files.** Scale proportionally; do not stretch, crop, redraw, recolor, add effects, substitute typed text, or redesign the icon or lockup. Keep the actual logo letterforms as the supplied raster artwork. Inter is the UI typeface, not an asserted identification of the logo’s font.

An **original vector master was not found in the reviewed source scope**. An assembled lockup made from these PNGs remains raster artwork. Embedding a PNG in an SVG or PDF does not make it a vector master. Do not label such a file as an original vector logo.

**Retired and excluded:** Document-Flow artwork, square-lockup artwork, old v2 logos, and diamond logos. Do not reintroduce them into this current package.

**Placement recommendations — not owner-approved standards:** Give the lockup generous separation from text, controls, and edges. At the intended display size, confirm that the tagline remains readable and the rule and icon remain distinct. If the full lockup becomes illegible in a compact location, use the approved compact icon with an accessible name rather than alter the full artwork. The reviewed sources do not establish numerical clear-space or minimum-size standards.

## 3. Constant core palette

These fixed values are `BRAND_COLORS` in `shared/brand.ts`. They are distinct from theme-responsive UI tokens.

| Core name | Hex | Core name | Hex |
| --- | --- | --- | --- |
| navy | `#0D1B2A` | navyRaised | `#12263A` |
| navyElevated | `#17304A` | teal | `#20A090` |
| tealDark | `#1A7A6E` | tealLight | `#2EC4B6` |
| gold | `#C9A84C` | goldDark | `#A98C36` |
| grayDark | `#4A5568` | white | `#FFFFFF` |

Navy is the foundation; teal is a primary accent and gold a secondary accent. Hex values are digital specifications. No CMYK, Pantone, print-match, or ink-production standard is established here.

## 4. Current semantic UI colors

Use the semantic CSS tokens for UI work rather than treating the core palette as a universal set of foreground/background pairings. The default `@theme` values define light appearance; `html.dark` overrides the same names for dark appearance. Each token below has the prefix `--color-`.

| Token | Light | Dark |
| --- | --- | --- |
| navy | `#0D1B2A` | `#071824` |
| navy-raised | `#12263A` | `#0D2635` |
| navy-elevated | `#17304A` | `#123444` |
| navy-border | `#1F3A56` | `#275064` |
| ink | `#0D1B2A` | `#F2F8F8` |
| body | `#4A5568` | `#C4D2D8` |
| muted | `#5E6D82` | `#92A8B2` |
| line | `#DFE5EC` | `#284656` |
| surface | `#FFFFFF` | `#091A27` |
| surface-soft | `#F5F7FA` | `#102634` |
| surface-sunken | `#EEF2F7` | `#142F3E` |
| teal | `#20A090` | `#2EC4B6` |
| teal-dark | `#1A7A6E` | `#55D6C9` |
| teal-light | `#2EC4B6` | `#8CE8DC` |
| action | `#137568` | `#2EC4B6` |
| action-hover | `#0E6056` | `#55D6C9` |
| on-action | `#FFFFFF` | `#071824` |
| danger-action | `#B3261E` | `#FF8D87` |
| danger-action-hover | `#8F1E18` | `#FFB2AD` |
| on-danger-action | `#FFFFFF` | `#071824` |
| control-border | `#7B8798` | `#708C9C` |
| gold | `#C9A84C` | `#E2C26A` |
| gold-dark | `#A98C36` | `#C9A84C` |
| success | `#157F52` | `#57CF91` |
| warning | `#8A570E` | `#EFBD65` |
| danger | `#B3261E` | `#FF8D87` |
| info | `#1A6FA8` | `#6DBCF0` |

Pair action backgrounds with their corresponding `on-action` or `on-danger-action` foregrounds. Use `ink` for headings, `body` for body copy, and the surface tokens for backgrounds. Subtle `line` separators are not a substitute for the stronger `control-border` where a control boundary must be perceptible. Card radius is `0.75rem`; card and raised shadows also change with the theme.

## 5. UI typography and existing sizing

The site self-hosts **Inter, normal style, weights 400, 500, 600, and 700**, with `font-display: swap`:

- `/fonts/inter-400.woff2`
- `/fonts/inter-500.woff2`
- `/fonts/inter-600.woff2`
- `/fonts/inter-700.woff2`

The CSS stack is `"Inter", "Helvetica Neue", Arial, sans-serif`. **Helvetica Neue and Arial are OS fallbacks, not font files provided by this package.** No italic font face is declared in the reviewed stylesheet.

Official Inter 4.1 desktop supplementary files are included separately from the exact current-site WOFF2 files, with their SIL Open Font License. They are supplementary desktop resources, not replacements for those web files and not a reason to typeset a substitute logo.

The existing sizing source is `client/src/styles/index.css`; it does not define a complete universal heading-size scale:

| Scope | Current declaration |
| --- | --- |
| Body | `1rem`; line-height `1.6` |
| All `h1`–`h6` | Weight `600`; line-height `1.25`; letter-spacing `-0.011em` |
| `.prose-rp h1` | `1.875rem` |
| `.prose-rp h2` | `1.375rem` |
| `.prose-rp h3` | `1.0625rem` |
| `.prose-rp table` | `0.9375rem` |
| Code, preformatted text, keyboard notation, samples | System monospace stack; `0.9em` |
| Inputs, textareas, selects, buttons | Inherit font and color |
| Inputs other than checkbox/radio, textareas, selects on coarse pointers | `1rem` |

The prose sizes apply to `.prose-rp`, not automatically to every heading in the app. Rem sizes remain relative to the browser’s root font size. Preserve readable spacing and avoid fixed-size assumptions that interfere with user scaling.

## 6. Accessibility in practice

Treat accessibility as a requirement to verify in each context, not a property guaranteed by brand colors. Aim for **WCAG AA contrast of at least 4.5:1 for normal text** and **3:1 for applicable non-text controls, meaningful graphics, and state indicators** against adjacent colors. Check actual foreground/background pairs in both themes and in interactive states. **Gold on white is decorative only**—not normal text, essential information, or a necessary control boundary.

Do not rely on color alone for status or instructions. Preserve keyboard-visible focus, meaningful labels, user zoom, and reduced-motion behavior. The stylesheet supplies a `3px` focus outline with `3px` offset, a focus-revealed skip-link style, reduced-motion rules, and forced-colors adjustments; these still require context testing.

The full lockup is exposed as one accessible image group, with the default label `ReadyPackets™ — Your Business, Professionally Packeted™`. Its component images are decorative within that group. When the parent link already has an adequate accessible label, the component supports an empty group label to avoid duplication. A standalone compact icon needs an appropriate accessible name unless genuinely decorative.

This guide does **not** promise blanket WCAG conformance or ADA compliance. A complete accessibility review must consider content, behavior, forms, navigation, and assistive-technology use—not just branding.

## 7. App and browser icon scope

Existing approved artwork is available for **192-size, 512-size, and maskable-512 app icons**, as identified in the delivery brief. The reviewed brand registry specifically lists `/brand/readypackets-approved-icon-light-192.png` as `favicon` and `/brand/readypackets-approved-icon-light-512.png` as `pwaIcon`. It does not register a maskable file path; retain the existing approved maskable artwork rather than inventing a filename or replacement.

Keep these app/browser assets distinct from the eight header components. Their existence does not establish native-app readiness, app-store approval, or a tested installable-app configuration.
