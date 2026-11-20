/**
 * ReadyPackets brand constants — current approved identity (brand kit dated 2026-11-20).
 * Assets are self-hosted under /brand/. Retired Document-Flow, square-lockup, v2 and diamond
 * artwork is intentionally not registered. Do not recolor, redraw or typeset substitutes.
 */
export const BRAND = {
  companyLegalName: "Ready Packets Consulting LLC",
  companyShortName: "ReadyPackets",
  wordmark: "ReadyPackets\u2122",
  tagline: "Your Business, Professionally Packeted\u2122",
  taglinePlain: "Your Business, Professionally Packeted",
  logoAccessibleName: "ReadyPackets\u2122 \u2014 Your Business, Professionally Packeted\u2122",
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

export const BRAND_ASSETS = {
  light: {
    icon: "brand/readypackets-approved-header-icon-light.png",
    wordmark: "brand/readypackets-approved-header-wordmark-light.png",
    rule: "brand/readypackets-approved-header-rule-light.png",
    tagline: "brand/readypackets-approved-header-tagline-light.png",
  },
  dark: {
    icon: "brand/readypackets-approved-header-icon-dark.png",
    wordmark: "brand/readypackets-approved-header-wordmark-dark.png",
    rule: "brand/readypackets-approved-header-rule-dark.png",
    tagline: "brand/readypackets-approved-header-tagline-dark.png",
  },
  favicon: "brand/readypackets-approved-icon-light-192.png",
  pwaIcon192: "brand/readypackets-approved-icon-light-192.png",
  pwaIcon512: "brand/readypackets-approved-icon-light-512.png",
  pwaIconMaskable512: "brand/readypackets-approved-icon-maskable-512.png",
} as const;

export const BRAND_PILLARS = [
  { name: "Professionalism", detail: "Every touchpoint reflects expertise, clarity, and polish." },
  { name: "Reliability", detail: "Clients trust us to deliver on time, every time." },
  { name: "Clarity", detail: "Complex business needs translated into actionable documents." },
  { name: "Momentum", detail: "We exist to help businesses move \u2014 fast and with confidence." },
] as const;
