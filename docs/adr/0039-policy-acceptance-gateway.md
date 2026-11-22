# 0039 — Policy acceptance gateway on workflows, enforced by the server with append-only evidence

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asks for an acceptance gateway based on a policy (increment 04 part B, decision B6), as on the previous platform.

## Decision
- An administrator attaches a policy from the policy centre to a workflow as a gate. Each gate has:
  - a gate point: `order_start` (before the customer can work on the order) or a named step (before that phase can be submitted);
  - a signature mode: a checkbox or a typed full name;
  - "ask again when the policy has a new version" (default off).
- While a gate is unmet, the customer can open and read the order. They cannot upload, record, answer intake or submit a phase on it.
- The server refuses those mutations with `PRECONDITION_FAILED`, reason `ORDER_ACCEPTANCE_REQUIRED`, through the orders gate port. The client shows a full-width gate with the policy text but is never the gate itself.
- Each acting user accepts for themselves: the owner and every person with access. Staff are not gated.
- Evidence is append-only. Each record holds:
  - the order, the user, the policy public id and version;
  - the SHA-256 of the exact text shown;
  - the typed name, if any, and the time;
  - the source address (encrypted) and the user agent.
- An acceptance recorded for one order cannot be replayed for another.
- The console tab "Acceptances (n)" lists the records, for example "Signed by <name> using typed signature", with the time, policy and version. The source address is shown only with `sessions.read_all`.
- A printable receipt is available to the customer and in the console.

## Consequences
- Adding a gate to a published workflow affects open orders when the next version is used, so customers may be asked to accept before they can continue.
- The record shows that the user took the action. It is not a qualified electronic signature or legal advice; the owner chooses the policy text and the signature mode.
