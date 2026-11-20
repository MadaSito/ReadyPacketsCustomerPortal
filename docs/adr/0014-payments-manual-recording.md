# 0014 — Payments are recorded manually; the Stripe adapter is a disabled scaffold

Status: Accepted (2026-11-20)

## Context
No Stripe account, webhook secret or reconciliation procedure has been provided or tested. A provider event that
can change an invoice balance is a financial control and must not ship unverified.

## Decision
- Staff record payments against invoices by hand. Recording, voiding and refunding require a recent step-up
  and are audited with actor, amount, currency and reference.
- The Stripe adapter exists only as a typed scaffold. It is hard-disabled in code, not merely by a setting: no
  provider event can create, change or settle a ledger entry, and the administration screen shows it as
  "Not available in this release".
- Enabling card payments requires a new ADR covering webhook signature verification, idempotency, replay
  windows, reconciliation and refund authority.

## Consequences
The portal never stores card data. Customers see invoice status and payment instructions; they cannot pay
online in this release.
