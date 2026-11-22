# 0035 — Card payments through hosted Stripe or Square checkout (partially supersedes 0014)

Status: Accepted (2026-11-21; owner confirmation requested). The "refunds stay manual" clause is superseded by [0038](0038-provider-refunds.md).

## Context
ADR 0014 kept payments manual. The owner now asks for a cart that redirects to Stripe or Square.

## Decision
- The administrator chooses `none`, `stripe` or `square`. The portal never sees card data: it creates a hosted checkout and redirects.
- An invoice is marked paid only after a provider webhook with a valid signature and a payment object fetched back from the provider that matches the stored attempt. The return page marks nothing.
- Provider calls are signed HTTPS requests through the egress policy; no payment SDK. Refunds and disputes stay manual.
- The cart is server-side; prices are recomputed from the catalogue at checkout.

## Consequences
Not exercised against real Stripe or Square accounts in development; the owner must test with provider test keys before taking live payments. Using hosted pages keeps the portal's card-data scope minimal but does not remove the owner's PCI obligations.
