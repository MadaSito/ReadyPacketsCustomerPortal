# 0022 — The offerings matrix is catalog data; Packet 7 is a bundle rule; Packet 8 is not loaded

Status: Accepted (2026-11-20) — two points need owner confirmation (see below)

## Context
The owner supplied the Master Offerings Matrix v3.0 (Packets 1–6 with Basic, Standard and Premium tiers and
prices; Packet 7 "The All-In" as a mix-and-match bundle with a flat 15% discount for all six packets; Packet 8
"Capital & Valuation Services" marked unlisted / strategic reserve; an internal successor note).

The master prompt says: do not restore removed Packet 8, do not hardcode legacy catalog or pricing
assumptions, and treat product and pricing content as versioned owner-controlled data.

## Decision
- The matrix ships as a data file (`data/catalog/readypackets-offerings-v3.0.json`) with a JSON schema. An
  operator loads it with an explicit, idempotent, audited command (`ops:catalog-import`). The application
  contains no packet names or prices in code, and an installation starts with an empty catalog.
- Packets 1–6 are catalog groups; each tier is a versioned product carrying packet number, tier, outcome,
  timeline and deliverables. Orders snapshot those values at purchase time.
- An order holds at most one tier per packet, quantity one.
- Packet 7 is not a product. An order with more than one packet is a bundle; a bundle rule stored as
  administered data applies 15% when all six packets are present. The server computes the discount.
- Packet 8 is recorded in the data file under `reserved` and is not imported. The internal successor note is
  kept only in `docs/source-specs/increment-02/` and is never shown in the portal.

## Needs owner confirmation
1. Packet 8 stays unlisted (as the master prompt requires). If it should be orderable, an administrator can
   add it in the catalog; nothing else changes.
2. The 15% discount applies only when all six packets are in one order, at any mix of tiers.

## Consequences
Price changes are made in the admin catalog (new product version) or by importing a new matrix file; existing
orders keep the terms they were placed under. The matrix states a planned 2027 price change; it is not
automated.
