# Security review: Compliance, Engagement, and Integrations

This is a read-only review of application code, not a penetration test or a security certification. Findings below are based on the cited code paths; the module owners received the findings directly. Paths and line numbers refer to the initial review snapshot and may move as fixes land.

## Verified findings

| ID | Severity | Location and evidence | Impact | Recommended fix |
| --- | --- | --- | --- | --- |
| COMP-01 | Medium | `server/modules/compliance/domain.ts:90,109,118,243–252`; `server/modules/compliance/schema.ts:92,274,310`. The schemas permit policy bodies up to 120,000 characters and up to 60 intake answers with individual strings up to 16,000 characters. The policy text and both encrypted answer snapshots are MySQL `TEXT`, which stores at most 65,535 bytes; the HTTP JSON cap is 256 KiB (`server/http/app.ts:51`). | Inputs accepted by validation and below the HTTP limit can fail insertion, preventing staff from saving policy drafts or customers from saving valid questionnaires. | Use storage types that accommodate the accepted serialized/encrypted size, and enforce an explicit aggregate UTF-8 limit before persistence. Add international-text and large-aggregate database tests. |
| COMP-02 | Low | `server/modules/compliance/domain.ts:23–25,90,109,118`. The raw body length check precedes a transform that trims the normalized value. | A whitespace-only policy can pass the input schema and produce an empty normalized body. | Keep the pre-normalization ceiling; validate a nonempty bounded normalized body, and use the same canonical value for storage and hashing. |
| COMP-03 | Low | `server/modules/compliance/domain.ts:146–152,273–295`. A key allowed by the field schema can coincide with an inherited object property, and the validator reads the raw answer by direct property lookup. | An omitted optional field can be interpreted as having a nonempty value of the wrong type, preventing save or submission for that questionnaire. | Check `Object.hasOwn()` before reading a field, and use a null-prototype result or disallow reserved names. Add an omitted optional field regression case. |

## Areas awaiting runtime code review

- **Compliance**: Runtime policy acceptance and publication checks, order-scoped intake, invoice and payment transitions, and provider-event application. The arithmetic helper bounds quantities, amounts, subtotals, and totals using safe-integer checks; this does not prove callers lock rows or check payment caps and identity correctly.
- **Engagement**: Message and ticket services, staff-only notes and notifications, and scoped database candidate search. The initial helper bounds query length and count of blind-indexed tokens, but it cannot establish the performance, parameterization, or authorization of downstream queries.
- **Integrations**: DNS pinning, redirect refusal, allowlist semantics, SMTP TLS and addresses, browser consent, CSP, and filtering of write-only secrets. The IP classifier preserves an embedded address’s nonpublic reason for certain IPv6 transition forms; check that the policy does not treat those results as eligible for a private-network exception. This is not yet reported as a reachable finding.
