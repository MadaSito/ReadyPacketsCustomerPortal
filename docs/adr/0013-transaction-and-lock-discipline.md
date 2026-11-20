# 0013 — Transaction and lock discipline

Status: Accepted (2026-11-20)

## Context
Independent reviews of several modules found the same three defects: a second pool connection opened while a
transaction was held (deadlock and read-your-writes hazards), authorization decided before the transaction and
not repeated inside it (time-of-check/time-of-use), and retention deletes whose audit record could be lost.

## Decision
- A service that is inside a transaction passes its `tx` handle to every collaborator, including settings reads
  and audit writes. No code path acquires a second pool connection while a transaction is open.
- The acting account is re-read and re-validated inside the transaction (status, role, live grants) before any
  state change. A decision made outside the transaction is advisory only.
- Row locks are taken in one deterministic order within a module, documented in that module's `API.md`.
  The default is: acting user, then other users by ascending id, then the owning aggregate, then children by
  ascending id.
- Exception: a mutation on an existing order locks the order row first, then user rows by ascending id, then
  the actor's session, then grant rows, then files (`server/modules/orders/API.md`). Files and every other
  order-scoped module use this same order, so the exception is itself deterministic.
- Retention and purge write their audit record in the same transaction, before the delete. If the audit write
  fails, nothing is deleted.

## Rejected
- Optimistic checks only (version columns without locks): insufficient for grant revocation races.
- A global advisory lock per tenant: needless contention for a single-organisation deployment.

## Consequences
Lock waits are bounded by the pool's lock timeout and surface as a retryable conflict. Reviews check these
rules explicitly; see `docs/security/REVIEW-*.md`.
