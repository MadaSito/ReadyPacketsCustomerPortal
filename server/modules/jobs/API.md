# Jobs, maintenance and mail API

## Cross-module contracts

- `createJobQueue(deps: QueueDeps): JobQueue` and `createMailer(deps: QueueDeps & { jobs: JobQueue }): Mailer` in `queue.ts`. Use `deps.jobs` and `deps.mailer` for the contracts from `server/core/types.ts`; use `services.jobAdmin` for maintenance and workforce controls.
- `JobQueue.enqueue(type, payload, options?, tx?) → { jobId }`: transaction support; a repeated key in one type returns the original job. Do not place raw credential or auth material in job payloads.
- `JobQueue.register(type, handler, options?)`: bounded retries for failure the handler explicitly classifies as retryable and without an uncertain effect; interrupted execution is recoverable automatically only when registered with `{ retrySafe: true }`. Declare that mode only when all writes and provider effects are fenced or independently idempotent.
- `ClaimedJob.assertStillOwned(tx?) → void`: call immediately before external effects; pass the same transaction used for local publication to hold the claim fence until publication commits. External mutations still require provider idempotency or reconciliation.
- `JobQueue.registerSchedule({ name, type, everyMs, payload? })`: fixed UTC epoch-aligned slot and durable unique slot key; missed slots are skipped, never replayed after restart, drain, or outage. On recovery the current slot may be queued immediately.
- `JobsModule.isDraining(): Promise<boolean>`: privileged writers and new long-running operations use this authoritative check and fail closed on errors.
- `JobsModule.reconcileOutboxJob(jobPublicId, tx, { cancelQueued? }) → OutboxJobDisposition`: internal system-only port, not a router procedure. Pass only the job ID bound to the caller's outbox record, lock the job before locking the outbox, and recheck that relationship after locking the outbox; roll back on mismatch. Returns `missing`, `queued_live`, `running_live`, `settled_unknown`, `canceled_queued`, or `terminal` with `jobState`. Expired claims are settled unknown, never retried by this port. `canceled_queued` means a queued attempt was stopped; it is not proof that an earlier attempt had no effect. Lease checks use the post-lock database clock. All state and audit writes use the supplied transaction.
- `JobsModule.startWorker(): Promise<WorkerHandle>`; `WorkerHandle.stop(): Promise<void>`: stops claims immediately, gives started work a bounded settlement window, then signals cancellation and commits an interruption disposition if possible. An unsettled handler rejects stop; an HTTP listener stopping is not proof external effects ceased.
- `Mailer.registerTemplate(template)` and `Mailer.enqueue(mail, tx?)` follow the core contract. Jobs resolves a published template by key, falling back to the built-in registration. Only declared variable names are allowed. Variables, pinned sensitive-variable classifications and literal recipients are encrypted. Stable outbox idempotency keys are unique; expired or already accepted/unknown messages are not automatically resent. Recipient user IDs resolve a current address at execution time.

### Mail transport and published templates

Import these types from `server/modules/jobs/index.ts`; register adapters on `deps.services.jobAdmin` in the provider's `init()` hook, after all constructors return. The registration methods are not router procedures.

```ts
type MailTransportKey = "smtp" | "graph";
interface MailSenderIdentity {
  fromAddress: string;
  fromName: string;
  replyToAddress?: string;
}
interface MailTransportMessage {
  sender: MailSenderIdentity;
  to: string;
  subject: string;
  text: string;
  html: string;
  signal: AbortSignal;
}
interface MailTransportResult {
  outcome: "accepted" | "not_configured" | "rejected" | "unknown";
  retryable?: boolean;
  safeDetail?: string;
}
interface MailTransport {
  readonly key: MailTransportKey;
  isConfigured(): Promise<boolean>;
  send(input: MailTransportMessage): Promise<MailTransportResult>;
}
interface PublishedMailTemplate {
  readonly key: string;
  readonly vars: readonly string[];
  readonly sensitiveVars?: readonly string[];
  render(vars: OutboundMail["vars"]): { subject: string; text: string; html?: string };
}
interface MailTemplateStore {
  resolve(key: string, tx?: Tx): Promise<PublishedMailTemplate | null>;
}
```

- `JobsModule.registerMailTransport(transport: MailTransport): void`: one adapter per key. `isConfigured` checks local prerequisites without submitting; `send` must use the supplied sender and honor cancellation. Secondary is eligible for `not_configured` or `rejected` with `retryable: true` only. Do not report policy denial, unexpected local failure or permanent rejection as eligible. A thrown send or lost confirmation after possible submission is `unknown`; never send via the secondary in that case. `safeDetail`, if present, is a fixed safe classification, not provider text; Jobs does not persist it.
- `JobsModule.registerMailTemplateStore(store: MailTemplateStore): void`: one provider. `resolve` returns the current published renderer or `null`, never a draft. Use the supplied transaction for reads if present. The published renderer is synchronous and must escape substitutions, handle redacted variable strings, and sanitize HTML again after substitution. The Jobs engine owns fallback to built-in renderers and preserves their `sensitiveVars`.
- `JobsModule.getBuiltinMailTemplates(): readonly MailTemplate[]`: in-process snapshots of current built-in registrations, for discovering system defaults. Never expose functions or raw actual mail variables over a router.
- `JobsModule.getMailSenderIdentity(): Promise<MailSenderIdentity | null>`: shared sender; use for provider test sends as well. `JobsModule.getMailReadiness(): Promise<{ ready: boolean }>` checks sender and configured routes without contacting a provider to send; readiness is not acceptance.
- Automation mail inherits the worker's `automation:<runPublicId>` correlation ID, persists it in the outbox and copies it to every delivery generation (even manual resend). Mail audit keeps that ID, so the audit tap suppresses automation-origin events from future triggers without suppressing the durable audit record itself.

## Console procedures

- `jobs.maintenanceBanner`: public-safe `active` boolean and fixed text only.
- `jobs.admin.list`, `detail`, `schedules`, `listMail`, `mailDetail`, `maintenance`: full administrator plus `jobs.read`.
- `jobs.admin.cancel`, `retry`, `resend`: full administrator plus `jobs.manage`; queued-only cancellation; retries require safe classification; unknown effects never replay automatically. Canceling a queued recovery retry stops the retry, not the earlier uncertainty, so that job stays `unknown`.
- `jobs.admin.setMaintenance`, `acknowledgeUnknown`, `capture`: full administrator and fresh step-up (maintenance and mail capability gates respectively). `acknowledgeUnknown` is an operator attestation after checking the provider independently; it never changes the unknown outcome or authorizes a retry. Capture reads use POST and are audited, only in explicit non-production capture mode, and never present content as delivered.
- `jobs.mail.content({ publicId })` (POST) -> `{ to, subject, text, html }`: full administrator with `mail.content.read`, fresh step-up and live transaction-time authorization. No content in preexisting rows, ordinary list/history, browser query cache, capture, or provider test flows. Responses inherit authenticated `Cache-Control: no-store`. Attributes omit recipient and body; successful access records `mail.content.viewed`. HTML is displayed as escaped source, not executed or loaded by the console.
- `jobs.mail.auditCopy.status` (query) -> `{ verified: boolean }`; `jobs.mail.auditCopy.requestVerification` (POST; no input) -> `{ queued: true }`; `jobs.mail.auditCopy.confirmVerification({ code })` (POST) -> `{ verified: true }`. Full administrator, `mail.manage` and fresh step-up. Mutations are rate-limited and revalidate the live session in their transaction. A one-time, 22-character base64url code expires in 30 minutes; requesting another replaces it. The challenge is a reserved mail template; its code cannot appear in development capture, retained content, or an audit copy.
- No raw HTTP routes.

## Customer access maintenance (Increment 04)

This policy is independent of `JobsModule.isDraining()` and the queue maintenance procedures. The Identity and shell port is `deps.services.jobAdmin.maintenance.customerAccess(tx?: Tx): Promise<CustomerAccessStatus>`. Pass the same transaction that issues a customer session or creates a customer registration for the final check; a preliminary check may omit `tx`. Staff and administrator access is not blocked. The public tRPC query `jobs.maintenance.customerAccess` has no input and returns exactly the same shape:

```ts
interface CustomerAccessStatus {
  active: boolean;
  message: string | null;
  expectedEnd: string | null; // ISO UTC, or null for no set end
}
```

Inactive responses always have `message: null` and `expectedEnd: null`; scheduled future windows do not disclose their contents before activation. An active window starts at the inclusive start and ends at the exclusive expected end, if one is set. Scheduled boundaries do not depend on a worker running. The public banner component is `@/features/jobs/CustomerMaintenanceBanner`.

The maintenance singleton is locked for shared reads through the Identity transaction and for exclusive updates; use the same order as Identity (`users`/`user_sessions` before this lock). Do not perform unrelated external work while holding this lock. Query times are interpreted in UTC using the injected server clock. A missing policy means disabled; a transactional check initializes the singleton as needed.

| Admin procedure | Authorization | Contract |
| --- | --- | --- |
| `jobs.admin.customerMaintenance` | Admin with `jobs.read` | `{ enabled, message, startsAt, endsAt, active, phase, version }`. `phase` is `off`, `scheduled`, `active`, or `ended`; times are UTC ISO strings or null. |
| `jobs.admin.setCustomerMaintenance` | Admin with `maintenance.manage` and fresh step-up, revalidated inside the transaction | `{ enabled, message, startsAt, endsAt, expectedVersion }` → same admin view. Up to 500 plain-text characters; nullable UTC instants; concurrent edits fail with `CUSTOMER_MAINTENANCE_CHANGED`. |

An effective settings change records `job.customer_maintenance.changed` in the same transaction with `enabled`, `starts_at`, and `ends_at`; the notice body is never included. The `customer_maintenance.configured` automation trigger fires on successful enabling or editing of the configured window, not when its scheduled boundary passes or when turned off. Saving a window never ends sessions. The confirmed console bulk action uses Identity's own `identity.admin.sessions.endAllCustomers`, requiring fresh step-up for `sessions.revoke_any`; it does not run inside the maintenance configuration transaction.

## Configuration and evidence

- `jobs.mail.capture`: boolean setting, defaults off; only development and test allow use. Preview and production refuse capture.
- `jobs.mail.sender`: `{ fromAddress, fromName, replyToAddress }`; empty sender address keeps legacy SMTP sender identity so installed SMTP configurations continue working. `jobs.mail.routing`: `{ primary: "smtp" | "graph", secondary: "none" | "smtp" | "graph" }`; defaults to SMTP only. Selected transports must differ.
- `jobs.mail.audit_copy`: `{ enabled, address }`, off by default. The configured mailbox must be verified before use. After a known customer acceptance, Jobs may make one independent, separately recorded submission to that mailbox on the accepting transport. It does not fail over or replay a copy. Its failure or unknown outcome does not change the accepted customer status.
- `jobs.mail.retain_content` defaults off; `jobs.mail.retention_days` defaults to 30 (0 to 90, zero hides and purges). The window applies when content is stored. Retention and audit copies use an independent render with sensitive inputs replaced with `[REDACTED]`, not a textual scrub of delivery HTML. If redacted rendering fails, neither is produced and the failure is audited. These configuration writes require `mail.manage` with live step-up via platform settings.
- `jobs.mail.deliver`: one non-retry-safe job per generation. Safe outcomes distinguish queued, sending, accepted (not delivery confirmation), held, captured, failed, expired, canceled, and unknown. A held or definitively refused message may be resent while its encrypted payload remains valid; no automatic retry on failure or ambiguous submission.
- `jobs.mail.expire`: recurring bounded cleanup of expired encrypted outbox data, redacted retained content and development captures. Sensitive payloads default to 30 minutes, other messages to 24 hours; a caller can supply the authoritative expiry up to 72 hours. Captures are readable for at most 15 minutes, and already expired data cannot be read or sent. Physical cleanup is deferred while workers are unavailable or maintenance is active.
- `jobs.queue` and `jobs.mail`: queue depth/oldest/stuck/unknown health and mail hold/unknown health.
- Audit namespace: `job.enqueued`, `job.claimed`, `job.completed`, `job.failed`, `job.canceled`, `job.unknown`, `job.retry.queued`, `job.lease.expired`, `job.maintenance.changed`, `job.mail.*`. Events use `category: job` and no payload, recipient or rendered content.
- Ordinary first-attempt successes from the internal scheduler are operational logs, not audit events. The durable job and attempt rows still drive Jobs and Schedules; the structured completion log records job ID, job type, schedule, UTC slot, correlation ID, duration and bounded safe counts. Failed (including terminal failures), unknown, interrupted and canceled runs, retries and operator actions remain audited. Scheduled failures include job type, schedule, UTC slot and attempt in the local audit record. Non-scheduled jobs retain full lifecycle audit even when they use the same handler as a recurring tick.
- The durable maintenance gate is serialized with worker claims and scheduling across processes. Queue `queue_drained` describes this queue only; it is not proof that unregistered web writers, native processes, or external provider work have stopped. Keep maintenance on while claims run or have unknown outcomes that await reconciliation, including earlier attempts whose retry is queued.

See the [mail delivery and outbox administrator guide](ADMIN_GUIDE.md) for the operator workflow.
