# 0010 — Search-engine indexing boundary between public site and portal

Status: Accepted (2026-11-20)

## Context
Project instruction 16 asks for maximum search, generative and answer-engine visibility. The architecture
document assigns that responsibility to the public marketing site (`www.readypackets.com`); the portal
(`my.readypackets.com`) holds customer records behind authentication.

## Decision
- Authenticated portal routes send `X-Robots-Tag: noindex, nofollow` and are disallowed in `robots.txt`.
  Indexing private application screens would expose nothing useful to searchers and risks leaking titles.
- The portal's public entry points (sign-in, registration, policy pages) are fast, semantic, have accurate
  titles and descriptions, canonical links, Open Graph data and organisation structured data, and link back to
  the marketing site so that brand queries resolve correctly.
- All discoverability content (service pages, FAQs, structured answers, sitemap) belongs on the marketing site.

## Consequences
- This reconciles the instruction with the specification. If the owner wants specific portal pages indexed, the
  allow-list in the HTTP layer is the single place to change.
