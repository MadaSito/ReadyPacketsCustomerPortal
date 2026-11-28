# Jobs, maintenance and mail API

## Cross-module contracts

- `createJobQueue(deps: QueueDeps): JobQueue` and `createMailer(deps: QueueDeps & { jobs: JobQueue }): Mailer` in `queue.ts`. Use `deps.jobs` and `deps.mailer` for the contracts from `server/core/types.ts`; use `services.jobAdmin` for maintenance and workforce controls.
- `JobQueue.enqueue(type, payload, options?, tx?) → { jobId }`: transaction support; a repeated key in one type returns the original job. Do not place raw credential or auth material in job payloads.
- `JobQueue.register(type, handler, options?)`: bounded retries for failure the handler explicitly classifies as retryable and without an uncertain effect; interrupted execution is recoverable automatically only when registered with `{ retrySafe: true }`. Declare that mode only when all writes and provider effects are fenced or independently idempotent.
- `ClaimedJob.assertStillOwned(tx?) → void`: call immediately before external effects; pass the same transaction used for local publication to hold the claim fence until publication commits. External mutations still require provider idempotency or reconciliation.
- `JobQueue.registerSchedule({ name, type, everyMs, payload? })`: fixed UTC epoch-aligned slot and durable unique slot key; missed slots are skipped, never replayed after restart, drain, or outage. On recovery the current slot may be queued immediately.
- `JobsModule.isDraining(): Promise<boolean>`: privileged writers and new long-running operations use this authoritative check and fail closed on errors.
- `JobsModule.reconcileOutboxJob(jobPublicId, tx, { cancelQueued? }) → OutboxJobDisposition`: internal system-only port, not a router procedure. Pass only the job ID bound to the caller's outbox record, lock the job before locking the outbox, and recheck that relationship after locking the outbox; roll back on mismatch. Returns `missing`, `queued_live`, `running_live`, `settled_unknown`, `canceled_queued`, or `terminal` with `jobState`. Expired claims are settled unknown, never retried by this port. `canceled_queued` means a queued attempt was stopped; it is not proof that an earlier attempt had no effect. Lease checks use the post-lock database clock. All state and audit writes use the supplied transaction.
- `JobsModule.canReplaceFailedOutboxJob(jobPublicId, expectedJobType, tx) → boolean`: internal, non-mutating guard for replacing a conclusively failed generation, not a status projection or router procedure. It locks the bound job and allows replacement only of matching, unscheduled `failed` jobs that the Jobs administrator cannot retry and that have no pending interruption. It never settles expired claims. Read the caller's bound job ID, lock the job through this guard, then lock the caller's outbox row, recheck the bound job ID and authoritative failure status, and stage replacement in the same transaction. The caller remains responsible for checking the actor, source, and destination.
- `JobsModule.startWorker(): Promise<WorkerHandle>`; `WorkerHandle.stop(): Promise<void>`: stops claims immediately, gives started work a bounded settlement window, then signals cancellation and commits an interruption disposition if possible. An unsettled handler rejects stop; an HTTP listener stopping is not proof external effects ceased.
- `Mailer.registerTemplate(template)` and `Mailer.enqueue(mail, tx?)` follow the core contract. Jobs resolves a published template by key, falling back to the built-in registration. Only declared variable names are allowed. Variables, pinned sensitive-variable classifications and literal recipients are encrypted. Stable outbox idempotency keys are unique; expired or already accepted/unknown messages are not automatically resent. Recipient user IDs resolve a current address at execution time.
- **Order-scoped mail:** trusted server producers set `OutboundMail.orderId` from an authorized live order, never from request input. Jobs binds known recipients (including literal addresses matched by blind index), cancels scoped queued mail on trash, and rechecks scope immediately before each provider submission. A transport already called is not retractable. Permanent deletion scrubs indexed outbox content without erasing attempt/audit evidence.
- **Outbox upgrade:** the existing expiry job repairs up to 25 unexpired legacy payload bindings per pass using immutable user IDs, address blind indexes, and reserved or canonical order references. An old literal address cannot bind to a newer account; when the original association remains unresolved and a customer purge happened at or after enqueue, dispatch refuses the message even before its maximum 72-hour lifetime. A separate 25-row pass erases historical partially/unbound terminal bodies after a relevant purge without changing delivery outcomes; those bodies are hidden from reads immediately. Otherwise ordinary content retention applies.
- **Mail links:** shipped action links are labelled anchors. Only authored text and recognized destination variables yield automatic HTTPS links; free-form values stay escaped, including inside branded security mail. Stored HTML remains sanitized and the editor preview remains inert. Text alternatives carry complete normalized destinations, although recipient clients may independently auto-detect URLs displayed as text.
- **Trash retention:** the Jobs scheduler registers `trash.retention.every_hour` for `trash.retention_cleanup` every 3,600,000 ms. It observes the ordinary scheduler maintenance gate; the Trash handler rechecks maintenance and claims a single sweep before processing due targets. Operators cannot manually retry this system-only job; queue-managed retries still work.

### Provider refund reconciliation

- `registerRefundReconciliation(jobs, lookup)` returns `enqueue(refundPublicId, tx, { runAt?, correlationId? })`. Register once during module construction. The job type `compliance.refund.reconcile` accepts only `{ refundPublicId }` (a ULID) and deduplicates by refund ID. Enqueue it alongside the durable refund intent, before the first provider submission. Set `runAt` ahead of the initial provider call; a later retry only does lookup, never a second provider write.
- `lookup(refundPublicId, { jobId, signal, correlationId, assertStillOwned }) → "settled" | "pending"` must be read-only at the provider. Honor cancellation and do not treat missing evidence as a terminal provider failure. In a local finalization transaction take `assertStillOwned(tx)` before the refund row lock, recheck the intent, and apply the verified result idempotently. `pending` retries with queue backoff up to eight attempts; `REFUND_RECONCILE_EXHAUSTED` marks the job, not the refund. Late authenticated provider events can still reconcile an unresolved refund. This is not a public route or a way to reissue a refund.
- System mail key `compliance.refund_notice`: `orderReference`, `refundAmount` (formatted with currency) and `refundReference` (internal public refund ID) are all redacted in retained content and audit copies. Send only after durable success when the administrator opted in, including recorded manual refunds; pass a recipient `userId`, `refund-notice:<refundPublicId>` as the stable outbox key, and the settlement transaction. Never pass an operator's reason, provider IDs or payment instrument data. A queued notice is not confirmation of delivery.

### Payment receipts and policy notices

- Order references are opaque strings for mail and may have legacy, current or manually assigned shapes. Receipt numbers and attachment filenames retain their separate `RPR-YYYY-NNNNNN` contract.

- `enqueuePaymentReceipt(mailer, { receiptPublicId, recipientUserId, receiptNumber, orderReference?, projectName?, pdf, resendRequestPublicId? }, tx?)` (`receiptMail.ts`) stages the editable `payment_receipt` template. `receiptNumber` (`RPR-YYYY-NNNNNN`) is required. Optional `orderReference` and `projectName` render as labelled context in both customer mail parts, including when the active override predates those variables. Pass a system-generated `Buffer` PDF. Up to 690 KiB is attached; if larger, the message has only the portal link. The caller must retain the PDF in the portal independently. The result `{ attachment: "attached" | "omitted_too_large" }` describes the requested payload, not the persisted outcome of a duplicate intent, provider acceptance, or delivery. `payment-receipt:<receiptPublicId>` deduplicates the original; only the caller's authorized, audited, rate-limited resend intent may add `:resend:<resendRequestPublicId>`. Pass the same resend ID when retrying that intent.
- Receipt PDF bytes and the filename are present only in the encrypted pending outbox and the actual customer transport message. The PDF does not enter audit or operational records, the optional audit mailbox copy, retained mail bodies, or development capture. Retained and audit copies redact receipt number, order reference and project name. The ordinary payload cap is still 96 KiB; 690 KiB of PDF plus its base64 expansion and metadata fits the existing 1 MiB field-crypto ceiling without a schema or cryptography change.
- Both receipt variants require an active account with a verified current email address at send time. Otherwise the worker refuses delivery and purges the queued payload; the receipt remains available in the portal. This restriction does not apply to account activation or email verification messages.
- Published overrides of `compliance.invoice_issued` and `compliance.invoice_paid` still render with their original declared variables. The delivery engine fills in missing labelled order and project details in each mail part from the caller's values. Invoice audit and retained copies redact the project name.
- `registerPolicyNoticeJobs({ jobs, db, clock, rateLimiter }, runBatch)` (`policyNoticeJobs.ts`) registers `compliance.policy_notice.batch` once and returns `schedule({ noticePublicId, revision, scheduledAt }, tx?) → Promise<{ jobId }>`. The ULID and positive monotonic revision identify a scheduling generation. Rescheduling means revising the owner row and staging a new revision in the same transaction. Keep configuration, authorization, audience, reminder rate limits, cancellation and acceptance in Compliance.
- `runBatch({ noticePublicId, revision, cursor, limit }, { signal, correlationId, assertStillOwned }, tx) → Promise<{ nextCursor: string | null }>` is called under the current job's row fence. Lock and recheck the notice and revision before selecting up to 25 recipients. Stage notifications, policy mail and idempotent progress updates in `tx`; never call providers from the callback. Return `null` for a completed, stale or canceled generation. Otherwise return a new deterministic cursor (1–200 characters in `[a-zA-Z0-9_:.=-]`). Jobs inserts the successor with the same correlation and a 5-second minimum delay in the same transaction. A crash after commit but before job settlement may replay the same cursor; the callback must not double-increment progress.
- Notice batches use a dedicated subject in the database-backed `expensive` limiter (30 batches per minute by default across workers). Throttling durably defers the same cursor until the limiter's retry time without touching progress, up to 48 times. A thrown batch failure rolls back its writes and follows the queue's bounded backoff, up to eight attempts. Exhaustion is visible in Jobs; scheduling a fresh revision is an owner decision.
- `enqueuePolicyNoticeMail(mailer, { kind, policyVersionPublicId, recipientUserId, policyTitle, portalUrl, summary?, deadline?, warningText?, reminderPublicId? }, tx?)` stages `policy_update_notice` or `policy_enforcement_warning`. Editable variables are `policyTitle`, `portalUrl`, plus `summary` for updates or `deadline` and `warningText` for warnings. Use a trusted configured absolute portal URL (`https`, or loopback `http` for development). The generated outbox key deduplicates by kind, version and user; only an explicitly requested reminder gets a separate stable ULID.
- `policyNoticeMailKey({ kind, policyVersionPublicId, recipientUserId, reminderPublicId? })` derives the lookup key. `services.jobAdmin.policyNoticeMailStates(keys, tx?)` returns a read-only map for at most 250 keys, omitting missing rows. `queued` includes sending; `sent` means provider accepted, not mailbox delivery or policy acceptance; `failed` means not confirmed sent and includes unknown, held, expired, canceled and development-capture outcomes. An unknown outcome must not be automatically resent. The caller owns aggregate progress and acceptance counts.

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
  attachments?: readonly { filename: string; contentType: "application/pdf"; content: Buffer }[];
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
- At delivery, user-ID messages use the current preferred name, or first name, for the explicit `recipient_name` greeting variable and the `name` variable in account invitations and email verification. Other `name` fields (including billing names) are not changed. Address-targeted producers supply their own greeting. Recipient names loaded at render time are not persisted to the outbox or used in retained/audit renders.

## Console procedures

- `jobs.maintenanceBanner`: public-safe `active` boolean and fixed text only.
- `jobs.admin.list`, `detail`, `schedules`, `listMail`, `mailDetail`, `maintenance`: full administrator plus `jobs.read`.
- `jobs.admin.cancel`, `retry`: full administrator plus `jobs.manage`; queued-only cancellation; retries require safe classification; unknown effects never replay automatically. Canceling a queued recovery retry stops the retry, not the earlier uncertainty, so that job stays `unknown`.
- `jobs.admin.resend({ publicId, acknowledgeDuplicateRisk?, expectedGeneration? }) → { jobId }`: ordinary held or failed mail requires `jobs.manage`. An unknown outcome requires literal `acknowledgeDuplicateRisk: true`, `mail.manage`, and fresh step-up revalidated in the enqueue transaction. The console supplies the reviewed `expectedGeneration` to reject stale confirmation. Retention expiry, purged payload, the generation limit and worker drain still prevent queueing. The original unknown job/attempt remains unchanged, and `job.mail.resent_after_unknown` records the administrator, original job ID, and new job ID. Attempts history includes a separate manual resend marker; queuing does not mean delivery.
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
| `jobs.admin.endCustomerSessions` | Admin with `sessions.revoke_any` and fresh step-up, revalidated by Identity | No input → `{ ended }`. Only available when customer maintenance is active; passes fixed reason `CUSTOMER_MAINTENANCE` to Identity. |

An effective settings change records `job.customer_maintenance.changed` in the same transaction with `enabled`, `starts_at`, and `ends_at`; the notice body is never included. The `customer_maintenance.configured` automation trigger fires on successful enabling or editing of the configured window, not when its scheduled boundary passes or when turned off. Its context provides `windowLabel`, `summary`, and `link` for the published `platform.maintenance_window` template. Saving a window never ends sessions. The confirmed console bulk action uses the `identity.sessions.endAllCustomers` service; it does not run inside the maintenance configuration transaction.

## Configuration and evidence

- `jobs.mail.capture`: boolean setting, defaults off; only development and test allow use. Preview and production refuse capture.
- `jobs.mail.sender`: `{ fromAddress, fromName, replyToAddress }`; empty sender address keeps legacy SMTP sender identity so installed SMTP configurations continue working. `jobs.mail.routing`: `{ primary: "smtp" | "graph", secondary: "none" | "smtp" | "graph" }`; defaults to SMTP only. Selected transports must differ.
- `jobs.mail.audit_copy`: `{ enabled, address }`, off by default. The configured mailbox must be verified before use. After a known customer acceptance, Jobs may make one independent, separately recorded submission to that mailbox on the accepting transport. It does not fail over or replay a copy. Its failure or unknown outcome does not change the accepted customer status.
- `jobs.mail.retain_content` defaults off; `jobs.mail.retention_days` defaults to 30 (0 to 90, zero hides and purges). The window applies when content is stored. Retention and audit copies use an independent render with sensitive inputs replaced with `[REDACTED]`, not a textual scrub of delivery HTML. If redacted rendering fails, neither is produced and the failure is audited. These configuration writes require `mail.manage` with live step-up via platform settings.
- `jobs.mail.deliver`: one non-retry-safe job per generation. Safe outcomes distinguish queued, sending, accepted (not delivery confirmation), held, captured, failed, expired, canceled, and unknown. Unknown payloads stay encrypted until original outbox expiry, then the expiry worker purges the payload while preserving `unknown` in history. No automatic retry on failure or ambiguous submission.
- `jobs.mail.expire`: recurring bounded cleanup of expired encrypted outbox data, redacted retained content and development captures. Sensitive payloads default to 30 minutes, other messages to 24 hours; a caller can supply the authoritative expiry up to 72 hours. Captures are readable for at most 15 minutes, and already expired data cannot be read or sent. Physical cleanup is deferred while workers are unavailable or maintenance is active.
- `jobs.queue` and `jobs.mail`: queue depth/oldest/stuck/unknown health and mail hold/unknown health.
- Audit namespace: `job.enqueued`, `job.claimed`, `job.completed`, `job.failed`, `job.canceled`, `job.unknown`, `job.retry.queued`, `job.lease.expired`, `job.maintenance.changed`, `job.mail.*`. Events use `category: job` and no payload, recipient or rendered content.
- Ordinary first-attempt successes from the internal scheduler are operational logs, not audit events. The durable job and attempt rows still drive Jobs and Schedules; the structured completion log records job ID, job type, schedule, UTC slot, correlation ID, duration and bounded safe counts. Failed (including terminal failures), unknown, interrupted and canceled runs, retries and operator actions remain audited. Scheduled failures include job type, schedule, UTC slot and attempt in the local audit record. Non-scheduled jobs retain full lifecycle audit even when they use the same handler as a recurring tick.
- The durable maintenance gate is serialized with worker claims and scheduling across processes. Queue `queue_drained` describes this queue only; it is not proof that unregistered web writers, native processes, or external provider work have stopped. Keep maintenance on while claims run or have unknown outcomes that await reconciliation, including earlier attempts whose retry is queued.

See the [mail delivery and outbox administrator guide](ADMIN_GUIDE.md) for the operator workflow.
