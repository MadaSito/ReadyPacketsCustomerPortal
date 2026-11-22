# 0045 — Policy acceptance log centre: a read-only view over the existing append-only evidence

Status: Accepted (2026-11-22; owner confirmation requested)

## Context
The owner asks for a log centre that tracks each customer's acceptance of a policy and of its updates, also shown on the customer's profile in the admin portal (increment 05, decision D4). The evidence already exists: account and checkout acceptances (`policy_acceptances`) and order gate acceptances (`order_policy_acceptances`, ADR 0039).

## Decision
- **A read view only.** No evidence row is ever changed or deleted. The centre is always on because it adds no new behaviour.
- **The "Policy acceptances" admin page** has three tabs:
  - **Log** lists every acceptance, newest first. Each entry shows:
    - the time and the customer (name, customer ID and e-mail);
    - the policy, version and a short content hash, and whether the version is current or "superseded by version n";
    - the source (registration, re-acceptance, checkout or order gate) and the method (tick box or typed name);
    - the order reference, an address pseudonym and the correlation id.

    The log can be filtered and is paginated by cursor. A detail dialog shows the complete record.
  - **Coverage** shows each published policy that requires acceptance: its current version and publication date, how many customers accepted it, how many are outstanding, and which customers are outstanding with the version they last accepted.
  - **Policy updates** lists every published version with its publication time, change summary and publisher, and how many customers have accepted it since.
- **The customer profile "Policies" tab** shows the status of each policy (accepted current version, update not yet accepted, or not required) and the customer's full history, with a link to the exact text of each accepted version.
- **Capabilities.**
  - `policies.acceptances.read` is for staff and administrators.
  - `policies.acceptances.export` is for administrators with step-up. The CSV export has a row limit and formula-safe cells, and is audited as `policy.acceptance_log.exported` with a filter summary and a row count.
  - Typed signer names stay encrypted and are shown only in the detail dialog to holders of `policies.manage`.
- **Times** are stored in UTC and shown in the viewer's time zone, with the UTC value available.

## Assumptions to confirm with the owner
- Staff, not only administrators, can read the acceptance log and the customer's Policies tab.

## Consequences
- The centre shows what was recorded. It does not prove a customer read the policy, and it is not legal advice.
- Acceptances recorded before increment 04 have no order-gate fields. They appear with the source they were recorded with.
