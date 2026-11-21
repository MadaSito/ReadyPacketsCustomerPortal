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
- `Mailer.registerTemplate(template)` and `Mailer.enqueue(mail, tx?)` follow the core contract. Only registered variable names are allowed. All variables and literal recipients are encrypted. Stable outbox idempotency keys are unique; expired or already accepted/unknown messages are not automatically resent. Recipient user IDs resolve a current address at execution time.

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

- `JobsModule.registerMailTransport(transport: MailTransport): void`: one adapter per key. `isConfigured` checks local prerequisites without submitting; `send` must use the supplied sender and honor cancellation. Use `rejected` only for explicit non-acceptance; set `retryable: true` only when a subsequent submit is safe. A thrown send or lost confirmation after possible submission is `unknown`; never send via the secondary in that case. `safeDetail`, if present, is a fixed safe classification, not provider text.
- `JobsModule.registerMailTemplateStore(store: MailTemplateStore): void`: one provider. `resolve` returns the current published renderer or `null`, never a draft. Use the supplied transaction for reads if present. The published renderer is synchronous and must escape substitutions, handle redacted variable strings, and sanitize HTML again after substitution. The Jobs engine owns fallback to built-in renderers and preserves their `sensitiveVars`.
- `JobsModule.getBuiltinMailTemplates(): readonly MailTemplate[]`: in-process snapshots of current built-in registrations, for discovering system defaults. Never expose functions or raw actual mail variables over a router.

## Console procedures

- `jobs.maintenanceBanner`: public-safe `active` boolean and fixed text only.
- `jobs.admin.list`, `detail`, `schedules`, `listMail`, `mailDetail`, `maintenance`: full administrator plus `jobs.read`.
- `jobs.admin.cancel`, `retry`, `resend`: full administrator plus `jobs.manage`; queued-only cancellation; retries require safe classification; unknown effects never replay automatically. Canceling a queued recovery retry stops the retry, not the earlier uncertainty, so that job stays `unknown`.
- `jobs.admin.setMaintenance`, `acknowledgeUnknown`, `capture`: full administrator and fresh step-up (maintenance and mail capability gates respectively). `acknowledgeUnknown` is an operator attestation after checking the provider independently; it never changes the unknown outcome or authorizes a retry. Capture reads use POST and are audited, only in explicit non-production capture mode, and never present content as delivered.
- No raw HTTP routes.

## Configuration and evidence

- `jobs.mail.capture`: boolean setting, defaults off; only development and test allow use. Preview and production refuse capture.
- `jobs.mail.deliver`: one non-retry-safe job per generation. Safe outcomes distinguish queued, sending, accepted (not delivery confirmation), held, captured, failed, expired, canceled, and unknown. A held or definitively refused message may be resent while its encrypted payload remains valid; no automatic retry on failure or ambiguous submission.
- `jobs.mail.expire`: recurring bounded cleanup of expired encrypted outbox data and development captures. Sensitive payloads default to 30 minutes, other messages to 24 hours; a caller can supply the authoritative expiry up to 72 hours. Captures are readable for at most 15 minutes, and already expired data cannot be read or sent. Physical cleanup is deferred while workers are unavailable or maintenance is active.
- `jobs.queue` and `jobs.mail`: queue depth/oldest/stuck/unknown health and mail hold/unknown health.
- Audit namespace: `job.enqueued`, `job.claimed`, `job.completed`, `job.failed`, `job.canceled`, `job.unknown`, `job.retry.queued`, `job.lease.expired`, `job.maintenance.changed`, `job.mail.*`. Events use `category: job` and no payload, recipient or rendered content.
- Ordinary first-attempt successes from the internal scheduler are operational logs, not audit events. The durable job and attempt rows still drive Jobs and Schedules; the structured completion log records job ID, job type, schedule, UTC slot, correlation ID, duration and bounded safe counts. Failed (including terminal failures), unknown, interrupted and canceled runs, retries and operator actions remain audited. Scheduled failures include job type, schedule, UTC slot and attempt in the local audit record. Non-scheduled jobs retain full lifecycle audit even when they use the same handler as a recurring tick.
- The durable maintenance gate is serialized with worker claims and scheduling across processes. Queue `queue_drained` describes this queue only; it is not proof that unregistered web writers, native processes, or external provider work have stopped. Keep maintenance on while claims run or have unknown outcomes that await reconciliation, including earlier attempts whose retry is queued.
