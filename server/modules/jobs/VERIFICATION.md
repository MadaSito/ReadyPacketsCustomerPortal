# Jobs module verification

| Requirement | Evidence | Classification |
| --- | --- | --- |
| MySQL durable claims and audit | `jobs.test.ts`: concurrent independent claimers see one claim; attempt and audit transitions; genuine durable emitter writes and rolls back with caller transaction. | automated-test |
| Scheduled audit volume | `jobs.test.ts`: first-attempt success keeps a durable run and a safe operational log with zero audit rows; scheduled failure records context; automatic retries and non-scheduled lifecycle remain audited. | automated-test |
| Leases, fencing and worker origin | `jobs.test.ts`: live heartbeat, expired lease, new fencing token, stale same-transaction durable write refused, worker correlation propagated; late SMTP completion cannot publish over an expired fence. | automated-test |
| Retry safe/unsafe distinction, drain, unknown | `jobs.test.ts`: explicit retry-safe claim backs off and reclaims; interrupted default jobs go unknown; maintenance blocks claims and reopening while outcomes are unknown; canceling or failing a later recovery attempt cannot hide earlier uncertainty; acknowledgement does not enable retry. | automated-test |
| Graceful shutdown | `jobs.test.ts`: cooperative work joins; intentionally non-cooperative handler receives signal, becomes unknown and stop rejects. | automated-test |
| Scheduler | `jobs.test.ts`: independent schedulers enqueue one slot and skip all missed slots after pause. | automated-test |
| Enqueue scope and transactions | `jobs.test.ts`: concurrent duplicate enqueue, per-type idempotency, caller transaction rollback and fail-closed audit. | automated-test |
| Authorization | `jobs.test.ts`: anonymous router access, staff, remediation admin, missing or future step-up refused; tampered ID and list bound enforced. | automated-test |
| Outbox | `jobs.test.ts`: atomic idempotent enqueue, encrypted vars, current user lookup, escaped HTML, header and variable validation, not configured hold, no replay of accepted/ambiguous delivery. | automated-test |
| Capture | `jobs.test.ts`: explicit test capture, encrypted capture bytes, expiry and purge, and preview/production refusal before SMTP or access to an existing capture. | automated-test |
| Admin UI | `client/src/features/jobs/jobs.test.tsx`: jsdom and axe on Jobs, Job details, Mail, Schedules and Maintenance; audit link, precise outcomes, blocked retries/reopen, and confirmation. | automated-test |
| Real browser layouts and assistive technology | Responsive components use shared design-system primitives; this module did not run a live browser, theme/viewport inspection, or screen reader. | not-verified |
| Real provider network outcome | SMTP behavior is exercised with a deterministic stub here. Live SMTP delivery/reconciliation and provider-side queue visibility are separate deployment acceptance work. | not-verified |
| Full platform drain | This module only proves fenced queue admission and tracks queue states. A universal registry of active web writers, native controller children, and external remote operations still needs adoption and deployment verification. | target |

Lost external effects remain unknown. An administrator can attest that they independently reconciled the job after review, but the durable job remains unknown, and the system does not replay it. Claims, heartbeat, fencing checks and reaping use the shared MySQL UTC clock for lease validity; scheduling and audit timestamps still use the application clock. Outbox expiry is enforced before SMTP and capture access; bounded deletion waits for a running, non-draining worker.
