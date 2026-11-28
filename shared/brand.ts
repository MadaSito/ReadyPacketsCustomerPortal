/**
 * ReadyPackets brand constants: Document-Stack full-lockup identity, package 2026.10.15.2, supplied by the
 * owner for use on 2026-11-27 (increment 09 D3). Masters stay in docs/brand/master/ (never served). Web
 * derivatives are self-hosted under /brand/ with versioned names (`-v2026101502`) so no cache or service
 * worker can serve the superseded artwork. Never recolour, redraw, re-typeset or CSS-filter the logo.
 */
export const BRAND = {
  companyLegalName: "Ready Packets Consulting LLC",
  companyShortName: "ReadyPackets",
  wordmark: "ReadyPackets\u2122",
  tagline: "Your Business, Professionally Packeted!\u2122",
  taglinePlain: "Your Business, Professionally Packeted!",
  logoAccessibleName: "ReadyPackets \u2014 Your Business, Professionally Packeted",
  marketingUrl: "https://www.readypackets.com",
  portalUrl: "https://my.readypackets.com",
  copyright: (year = new Date().getFullYear()) =>
    `\u00A9 ${year} Ready Packets Consulting LLC. All rights reserved.`,
} as const;

export const BRAND_COLORS = {
  navy: "#0D1B2A",
  navyRaised: "#12263A",
  navyElevated: "#17304A",
  teal: "#20A090",
  tealDark: "#1A7A6E",
  tealLight: "#2EC4B6",
  gold: "#C9A84C",
  goldDark: "#A98C36",
  grayDark: "#4A5568",
  white: "#FFFFFF",
} as const;

/** Brand package version; part of every served file name. */
export const BRAND_ASSET_VERSION = "v2026101502";

type BrandImage = { readonly path: string; readonly width: number; readonly height: number };
const v = (name: string, ext: "svg" | "png" | "ico", width: number, height: number): BrandImage => ({
  path: `brand/${name}-${BRAND_ASSET_VERSION}.${ext}`,
  width,
  height,
});

/**
 * Same-origin paths are relative to the web root (no leading slash). Lockups: `square` for square and tile
 * placements, `horizontal` for narrow bars, mail and documents. `utility` is the icon-only mark for forced
 * technical slots only (favicon, Apple touch icon, maskable PWA icon) and is never a customer-facing logo.
 */
export const BRAND_ASSETS = {
  light: {
    square: v("readypackets-square-light", "svg", 1024, 1024),
    horizontal: v("readypackets-horizontal-light", "svg", 2460, 680),
    squarePng192: v("readypackets-square-light-192", "png", 192, 192),
    squarePng512: v("readypackets-square-light-512", "png", 512, 512),
    horizontalPng300: v("readypackets-horizontal-light-300x90", "png", 300, 90),
    horizontalPng500: v("readypackets-horizontal-light-500x150", "png", 500, 150),
  },
  dark: {
    square: v("readypackets-square-dark", "svg", 1024, 1024),
    horizontal: v("readypackets-horizontal-dark", "svg", 2460, 680),
    squarePng192: v("readypackets-square-dark-192", "png", 192, 192),
    squarePng512: v("readypackets-square-dark-512", "png", 512, 512),
    horizontalPng300: v("readypackets-horizontal-dark-300x90", "png", 300, 90),
    horizontalPng500: v("readypackets-horizontal-dark-500x150", "png", 500, 150),
  },
  /** Mail header/footer (light horizontal full lockup, 300 x 90). */
  mailLogo: v("readypackets-horizontal-light-300x90", "png", 300, 90),
  /** Invoice / receipt PDF masthead (light horizontal full lockup, 600 x 180 at 300 DPI). */
  documentLogo: v("readypackets-horizontal-light-600x180", "png", 600, 180),
  /** Open Graph / Twitter share image (opaque light square full lockup). */
  shareImage: v("readypackets-og-square-light-800", "png", 800, 800),
  utility: {
    favicon: v("readypackets-utility-favicon", "ico", 48, 48),
    markLight16: v("readypackets-utility-mark-light-16", "png", 16, 16),
    markLight32: v("readypackets-utility-mark-light-32", "png", 32, 32),
    markLight48: v("readypackets-utility-mark-light-48", "png", 48, 48),
    markDark16: v("readypackets-utility-mark-dark-16", "png", 16, 16),
    markDark32: v("readypackets-utility-mark-dark-32", "png", 32, 32),
    markDark48: v("readypackets-utility-mark-dark-48", "png", 48, 48),
    appleTouch180: v("readypackets-utility-apple-touch-180", "png", 180, 180),
    maskable512: v("readypackets-utility-maskable-512", "png", 512, 512),
  },
} as const;

export const BRAND_PILLARS = [
  { name: "Professionalism", detail: "Every touchpoint reflects expertise, clarity, and polish." },
  { name: "Reliability", detail: "Clients trust us to deliver on time, every time." },
  { name: "Clarity", detail: "Complex business needs translated into actionable documents." },
  { name: "Momentum", detail: "We exist to help businesses move \u2014 fast and with confidence." },
] as const;
