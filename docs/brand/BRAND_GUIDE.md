# ReadyPackets — Brand Guide

**Package in use:** ReadyPackets Complete Brand Identity, version **2026.10.15.2**, "Document-Stack Consistent Full-Lockup System"
**Supplied for use by the owner:** 27 November 2026 (increment 09, prompt 37)
**Source of truth in this repository:** [`docs/brand/master/`](master/)

This guide describes the brand as the portal uses it from increment 09. It replaces the 20 November 2026 guide, which described the earlier four-part PNG header lockup. That lockup is retired.

The package's own README and release notes call it a **"production candidate pending brand-owner approval and trademark-use review"**. The owner supplied it on 27 November 2026 and asked for the square full lockup to be used as the logo. That instruction is the approval recorded here. This guide makes no claim about the trademark-use review, which is for the owner's counsel.

## 0. Source files

| File in `docs/brand/master/` | What it is |
| --- | --- |
| `readypackets-full-lockup-square-light-4096x4096-transparent.png` | Square full lockup for light surfaces, 4096 × 4096 px, transparent, as supplied |
| `readypackets-full-lockup-square-dark-4096x4096-transparent.png` | Square full lockup for dark surfaces, 4096 × 4096 px, transparent, as supplied |
| `MASTER-ReadyPacketsBrandIdentity.zip` | The complete package exactly as supplied |

The archive contains:
- the outlined SVG and transparent PNG lockups (`logo-assets/`);
- full-size SVG and PDF vector masters, and ready-sized exports for the web, e-mail, app, social and print (`platform-and-print-exports/`);
- technical utility icons (`icons/`, and `platform-and-print-exports/04-web-email-and-app/utility-icons-only/`);
- the Brand Book PDF and its standards, logo, colour, voice, digital and rollout documents (`docs/`);
- `SHA256SUMS`, the generators and the self-hosted Inter fonts with their licence.

**Rules for these files:**
- **Never edit them.** To adopt a newer package, add it next to the current one and update this guide.
- **Check the archive.** Before copying any asset out of it, check the files against its own `SHA256SUMS`.
- **Serve only web-sized derivatives.** Browsers are never sent a 4096 px file. The live copies are listed in section 2.

## 1. Name, tagline and brand pillars

- **Name.** Use **ReadyPackets** as the short name: one word, with a capital R and P. The lockup shows **ReadyPackets™**. The legal company name is **Ready Packets Consulting LLC**.
- **Tagline.** It is now **Your Business, Professionally Packeted!™**, with an exclamation mark, as it appears in every lockup of the package. Keep the wording, capitals, comma and exclamation mark.
- **Accessible name.** The linked logo uses **ReadyPackets — Your Business, Professionally Packeted**.
- **Trademark sign.** The ™ is an unregistered-trademark notice, not a claim that registration was granted (package `docs/LOGO_USAGE.md`). In body copy, use **ReadyPackets™** at the first prominent use in formal or marketing material, and **ReadyPackets** after that.

The four brand pillars, quoted exactly from `BRAND_PILLARS` in `shared/brand.ts`, are:

| Pillar | Source wording |
| --- | --- |
| Professionalism | Every touchpoint reflects expertise, clarity, and polish. |
| Reliability | Clients trust us to deliver on time, every time. |
| Clarity | Complex business needs translated into actionable documents. |
| Momentum | We exist to help businesses move — fast and with confidence. |

## 2. The logo

### 2.1 One identity, two compositions

Every customer-facing logo is a **full lockup** with four parts: the layered Document-Stack symbol, `ReadyPackets™`, a gold divider, and `Your Business, Professionally Packeted!™`. The package has two compositions of the same lockup, not two logo tiers:

- **Square full lockup.** This is the portal's logo, at the owner's request. Use it wherever a logo is shown and a square lockup is legible:
  - sign-in, registration and every other sign-in page;
  - public and legal pages;
  - the brand tile in the sidebar of the customer portal and the console;
  - error, offline and maintenance pages;
  - launch and install surfaces;
  - the social share image.
- **Horizontal full lockup** of the same package, by the package's own rule:
  - narrow bars, such as the mobile top bar or a compact header;
  - e-mail headers and footers, and invoice and receipt PDFs, where a logo is already shown. Where none is shown today, none is added.
- **Icon-only artwork** (the bare Document-Stack mark) only in the technical slots where a full lockup cannot be read: favicon 16/32/48, the maskable PWA icon and the Apple touch icon. It comes from `utility-icons-only/`, and is never used as a customer-facing logo.

### 2.2 Light and dark

Choose the light or dark file to match the surface the logo actually sits on. In the portal, that is the resolved theme. Never mix files, recolour them, or use CSS filters.

| Part | Light surface | Dark surface |
| --- | --- | --- |
| Background | White `#FFFFFF` | Navy `#0D1B2A` |
| Ready | Navy `#0D1B2A` | White `#FFFFFF` |
| Packets | Teal `#20A090` | Teal Light `#2EC4B6` |
| Tagline | Teal Dark `#1A7A6E` | White `#FFFFFF` |
| Divider | Gold `#C9A84C` | Gold `#C9A84C` |

Dark panels keep using `.rp-brand-on-dark`, and forced-colours mode must still show the logo. Do not put the light lockup over a dark photo or the dark lockup over a light one. Use a quiet supporting field instead.

### 2.3 Do and do not

- **Do** scale proportionally and keep the supplied composition: the tagline centred under the name, both ™ signs where they are, and the stack attached.
- **Do not** stretch, crop, rotate, redraw, re-typeset, recolour or add effects. Do not pull the tagline under the symbol, use a wordmark-only logo, or swap a compact mark into a branded slot.
- **Lettering.** The lettering in the lockups is outlined Inter, so no font is needed to display it. Never retype it as live text in place of the artwork.

### 2.4 Live files in the portal

The files are self-hosted on the same origin from `client/public/brand/`. Each has an explicit `width` and `height` to avoid layout shift, and a versioned or hashed name so that neither the browser cache nor the service worker keeps serving the old logo. The registry is `BRAND_ASSETS` in `shared/brand.ts`.

<!-- PENDING-OWNER ui_foundation_engineer: final file names, sizes and component names -->

| Use | File (light / dark) | Source in the package |
| --- | --- | --- |
| Square lockup (sign-in pages, public pages, sidebar tile, error and offline pages) | to be confirmed | `logo-assets/readypackets-document-stack-square-{light,dark}.svg`, PNG fallbacks from `full-square-app-and-launch/` |
| Horizontal lockup (narrow bars) | to be confirmed | `logo-assets/readypackets-document-stack-{light,dark}.svg`, PNG from `website-header/` |
| Favicon 16/32/48 and `favicon.ico` | to be confirmed | `utility-icons-only/readypackets-utility-favicon-multiresolution.ico`, `readypackets-utility-mark-*` |
| Maskable PWA icon | to be confirmed | `utility-icons-only/readypackets-utility-app-icon-maskable-512x512.png` |
| Apple touch icon | to be confirmed | `utility-icons-only/readypackets-utility-app-icon-navy-180x180.png` |
| Open Graph, Twitter and JSON-LD logo | to be confirmed | square full lockup |
| E-mail and PDF header | to be confirmed | `email-signature/readypackets-full-lockup-horizontal-light-300x90.png` |

The superseded `readypackets-approved-*` files are removed from the live paths once nothing refers to them. They remain in the Git history.

### 2.5 Alternative text

| Context | Alternative text |
| --- | --- |
| Linked logo (home link) | `ReadyPackets — Your Business, Professionally Packeted` (the link has a name) |
| Decorative copy next to a visible site name | `alt=""` |
| Icon-only home control | `ReadyPackets home`, as a visible or ARIA label |
| Social share image | `ReadyPackets — Your Business, Professionally Packeted` |

## 3. Constant core palette

These fixed values are `BRAND_COLORS` in `shared/brand.ts`. They match the package's palette (`COLOR_AND_TYPOGRAPHY.md`). They are distinct from theme-responsive UI tokens.

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

Treat accessibility as a requirement to verify in each context, not something the brand colors provide on their own. Aim for **WCAG AA contrast of at least 4.5:1 for normal text** and **3:1 for applicable non-text controls, meaningful graphics, and state indicators** against adjacent colors. Check actual foreground/background pairs in both themes and in interactive states. **Gold on white is decorative only**—not normal text, essential information, or a necessary control boundary.

Do not rely on color alone for status or instructions. Preserve keyboard-visible focus, meaningful labels, user zoom, and reduced-motion behavior. The stylesheet supplies a `3px` focus outline with `3px` offset, a focus-revealed skip-link style, reduced-motion rules, and forced-colors adjustments; these still require context testing.

The logo is one image with the accessible name in section 2.5. When the surrounding link already has an adequate name, the image uses `alt=""` to avoid saying it twice. The contrast of the dark lockup on the navy surface and of the light lockup on white is checked as part of increment 09.

This guide does not claim blanket conformance with WCAG or the ADA. A complete accessibility review must consider content, behavior, forms, navigation, and assistive-technology use—not just branding.

## 7. App and browser icons

Browser and operating-system slots use the package's **utility icons**: the Document-Stack mark alone, from `utility-icons-only/`. These slots are favicon 16, 32 and 48 px with `favicon.ico`, the maskable 512 px PWA icon and the Apple touch icon. They are a technical exception, not a customer-facing logo. Install and launch surfaces that can show a branded square, such as the PWA manifest's standard icons and splash, use the square full lockup from `full-square-app-and-launch/`. `manifest.webmanifest`, `favicon.ico`, the Open Graph, Twitter and JSON-LD logo, the offline page and the PWA precache list all point at the new files.

These icons do not show that a native app is ready, approved in an app store, or tested as an installable app.

## 8. Sources

- **Package documents** (inside the archive, under `docs/`): `LOGO_USAGE.md`, `DIGITAL_SYSTEM.md`, `BRAND_ROLLOUT.md`, `COLOR_AND_TYPOGRAPHY.md`, `RELEASE_NOTES.md`, `platform-and-print-exports/README.md`, and the Brand Book PDF.
- **Increment contract:** [INCREMENT_09_CONTRACT.md](../engineering/INCREMENT_09_CONTRACT.md), decision D3.
