# Automations Module — Public Contract & API (`v1.0.0`, Increment 03 Package J)

Owner: `engagement_engineer` (`server/modules/automations/**`)
Client & Trigger Catalogue / Tap Owner: `audit_engineer` (`client/src/features/automations/**`, `server/modules/audit/{tap,triggerCatalogue}.ts`)

---

## 1. Module Surface & Cross-Module Ports

Import path for peer modules (zero circular dependencies):

```ts
import {
  registerAutomationTrigger,
  registerAutomationAction,
  type AutomationsModule,
  type AutomationTriggerRegistration,
  type AutomationTriggerResolveInput,
  type AutomationResolvedTriggerContext,
  type AutomationActionRegistration,
  type AutomationActionRunContext,
  type AutomationActionRunResult,
  type AutomationActionConfigField,
} from "../automations/contracts.js";
```

Both process-level helpers (`registerAutomationTrigger(...)`, `registerAutomationAction(...)` imported from `../automations/contracts.js`) **and** instance methods (`deps.services.automations?.registerAutomationTrigger(...)` / `registerAutomationAction(...)` inside `module.init()`) are supported. Every resolver and action handler receives the active container's `{ db, services, ... }` at execution time, so parallel/isolated test containers never share mutable state.

### 1.1 `registerAutomationTrigger(registration)`

Base curated entries live in `TRIGGER_CATALOGUE` (`server/modules/audit/triggerCatalogue.ts`). Owning modules call `registerAutomationTrigger` in `init()` (or module load) to:
1. Supply the worker-side `resolveContext` callback that resolves `from: "context"` fields and user-kind `recipients` (`users.id[]`), and/or
2. Merge additional `fields` / `recipients` onto an existing catalogue key, or register an additional curated `TriggerCatalogueEntry` (e.g. `backup.remote_copy_completed`, `backup.remote_copy_failed`).

```ts
export interface AutomationTriggerResolveInput {
  triggerKey: string;
  event: AuditTapEvent;
  db: DbOrTx;
  services: Services;
  signal: AbortSignal;
}

export interface AutomationResolvedTriggerContext {
  /** Scalar `from: "context"` fields only. Undeclared keys are stripped. Never put emails/names/secrets here. */
  fields?: Readonly<Record<string, string | number | boolean | null>>;
  /** Numeric `users.id` arrays keyed by `TriggerRecipient.key` (e.g. `{ order_owner: [42] }`). `actor`, `administrators`, and `staff` are resolved automatically if omitted. */
  recipients?: Readonly<Record<string, readonly number[]>>;
  /** Canonical order `publicId` when the resource belongs to an order (auto-populated when `event.resource?.type === "order"`). */
  orderPublicId?: string | null;
  /** Canonical file `publicId` when triggered by `file.uploaded` (auto-populated when `event.resource?.type === "file"`). */
  filePublicId?: string | null;
}

export interface AutomationTriggerRegistration {
  key: string;
  entry?: TriggerCatalogueEntry | { fields?: readonly TriggerField[]; recipients?: readonly TriggerRecipient[] };
  resolveContext?: (input: AutomationTriggerResolveInput) => Promise<AutomationResolvedTriggerContext>;
}
```

### 1.2 `registerAutomationAction(registration, options?)`

```ts
export interface AutomationActionRegistration<C = Record<string, unknown>> {
  key: string; // e.g. "sharepoint.sync_order", "storage.copy_order_files", "email.send_template"
  label: string;
  description: string;
  category: "Messaging" | "Support" | "Integrations" | "Storage and sync";
  owner: "automations" | "mailTemplates" | "engagement" | "integrations" | "storage" | "portable";
  configSchema: z.ZodType<C>; // z.strictObject(...)
  secretsSchema?: z.ZodType<Record<string, string>>;
  configFields: readonly AutomationActionConfigField[]; // JSON-serializable descriptors for Wizard & FlowCanvas UI
  requiresOrderContext?: boolean;
  supportedTriggerModes?: readonly ("event" | "manual" | "schedule")[];
  /** True ONLY when re-running an interrupted attempt with `ctx.idempotencyKey` cannot duplicate external side effects. */
  retrySafe: boolean;
  run(ctx: AutomationActionRunContext<C>): Promise<AutomationActionRunResult>;
}
```

Hard guardrail (`assertAllowedActionKey`): **no action may mutate order status, permissions, roles, credentials, or platform settings.** Prohibited prefixes (`orders.transition`, `orders.set_status`, `orders.reassign`, `identity.role`, `identity.permission`, `identity.credentials`, `assurance.*`, `platform.settings`, `capabilities.*`, `permissions.*`) throw `TypeError` at registration.

### 1.3 Shipped & Peer-Registered Actions

| Key | Owner | `retrySafe` | Config Shape | Notes |
| --- | --- | --- | --- | --- |
| `email.send_template` | `automations` / `mailTemplates` (`replaceBuiltIn: true` allowed) | `true` | `{ templateKey: string; recipientMode: "catalogue" \| "fixed"; recipientKey?: string; fixedAddress?: string }` | Enqueues via `deps.mailer.enqueue` (resolving published template from Package D `MailTemplateStore` with logic-less escaped `{{var}}`; `personal: true` `recipient_name` resolved per recipient at enqueue/render time; control chars rejected). |
| `notification.send_in_app` | `automations` (`engagement`) | `true` | `{ recipientKey: string; titleTemplate: string; bodyTemplate: string; linkField?: string }` | Calls `services.engagement.notifications.notify` with `idempotencyKey = ctx.idempotencyKey`. |
| `support.create_ticket` | `automations` (`engagement`) | `true` | `{ requesterKey?: string; category: TicketCategory; priority: TicketPriority; subjectTemplate: string; bodyTemplate: string; bindOrderFromContext?: boolean }` | Creates customer/staff ticket bound to `ctx.idempotencyKey`; never triggers downstream automations (`automation:<runPublicId>` correlation). |
| `webhook.call` | `automations` (`integrations` egress) | `false` | `{ url: string; payloadFields: string[]; timeoutMs?: number }` + `secrets: { signingSecret: string }` | Validated via `services.integrations.egress` (`purpose: "webhook"`, `https:` only, `requireAllowlistRule: true`, `fetchPinned`, no redirects). Signed with `X-RP-Webhook-Id`, `X-RP-Webhook-Timestamp`, `X-RP-Webhook-Signature: v1=<hmac_sha256(ts + "." + body)>`. Lease-fenced (`assertStillOwned(tx)`) before dispatch; interrupted `dispatching` step becomes `unknown` (never re-sent automatically). |
| `sharepoint.sync_order` | `portable_contract_engineer` (H) | `true` | `{ connectionPublicId?: string }` | `requiresOrderContext: true`; enqueues fenced SharePoint order sync job with `ctx.correlationId` & `ctx.idempotencyKey`. |
| `storage.copy_order_files` | `files_engineer` (G) | `true` | `{ connectionPublicId?: string }` | `requiresOrderContext: true`; enqueues fenced order-file storage copy job with `ctx.correlationId` & `ctx.idempotencyKey`. |
| `order.set_completion` | `automations` (D5) | `true` | `{ kind: "fixed" \| "range"; percent?: number; minPercent?: number; maxPercent?: number; delayMinutes?: number }` | `requiresOrderContext: true`, `forbidOnStaffOnlyTrigger: true`. `delayMinutes` 0..43,200 (30 days). Range draws once on the server via `crypto.randomInt(min, max + 1)` and persists `resolved_percent` in `order_completion_jobs`, fenced by `orders.completion_revision`. |
| `webhook.enqueue_subscription` | `automations` (`integrations` D7) | `true` | `{ targetKey: string; eventKey?: string; includeEvaluatedFields?: boolean }` | `forbidOnStaffOnlyTrigger: true`. Accepts only `STAGE_WEBHOOK_TARGET` (`production:P101..P401` or `subscription:<ULID>`); raw URLs and secrets are forbidden. Enqueues via `services.integrations.workflowWebhooks.enqueueStageWebhook`. |
| `dashboard.create_alert` | `automations` (`opsAlerts` D5/D6) | `true` | `{ severity: "warning" \| "error" \| "critical"; titleTemplate: string; bodyTemplate?: string; code?: string }` | Permitted on `staffOnly: true` triggers (`STAFF_ONLY_ALLOWED_ACTION_KEYS`). Renders non-personal trigger fields only (`recipient_name` forbidden) and emits via `services.opsAlerts.emit`. |

---

## 2. Audit Tap, Loop Protection, Deduplication & Rate Limits

- **Default Disabled**: Global setting `automations.enabled` defaults to `false`. While `false` (or when zero enabled automations match `eventName`), `tap.listens(eventName)` returns `false` synchronously in O(1) memory with zero DB work.
- **Single-Write Tap (`onRecorded`)**: `onRecorded(event, tx)` performs a single `deps.jobs.enqueue("automations.evaluate_event", { event }, { idempotencyKey: "auto:tap:" + event.eventId, correlationId: event.correlationId ?? undefined }, tx)` inside the caller's `tx`. Evaluation and action execution happen exclusively in the worker.
- **Loop Protection by Construction (Decision 10, Gate 4.1 J)**:
  - Every run stamps `correlationId = automationCorrelationId(runPublicId)` (`"automation:<runPublicId>"`).
  - Worker execution runs inside `withRequestContext({ origin: "worker", correlationId })` and passes `correlationId` to every `jobs.enqueue`, `audit.record`, and outbound mail/webhook/sync call.
  - Both `audit/tap.ts` and `automations` drop any event where `isAutomationOrigin(event.correlationId)` is `true` (including asynchronous descendants such as `job.mail.failed`).
  - Defense-in-depth `staffOnly` isolation (`J-A01`): when a trigger catalogue entry has `staffOnly: true` (e.g. `message.internal_note`), **both save-time validation and worker-time execution** enforce an explicit default-deny allowlist (`STAFF_ONLY_ALLOWED_ACTION_KEYS = new Set(["notification.send_in_app"])`), rejecting `email.send_template`, `webhook.call`, `support.create_ticket`, `storage.copy_order_files`, `sharepoint.sync_order` (`forbidOnStaffOnlyTrigger: true`), fixed external e-mail addresses, and any customer recipient key or resolved `users.role === "customer"` row. Staff-only in-app notifications persist `staff_only = 1` with `skipEmail: true` and enforce live `users.role IN ('admin', 'staff')` visibility via a single-statement correlated `EXISTS` predicate on list/count/markRead/markAllRead so even post-enqueue demotion hides the row.
- **Deduplication**:
  - `automation_runs` enforces `UNIQUE (automation_id, trigger_event_id)` so duplicate tap deliveries never create two runs for the same `(automation, event)`.
  - `automation_run_steps` enforces `UNIQUE (run_id, step_index)` and supplies deterministic `idempotencyKey = "auto:" + runPublicId + ":step:" + stepKey`.
- **Rate Limits & Quotas**:
  - Global run ceiling (`automations.limits` setting: default `120` runs/min) and per-automation ceiling (`maxRunsPerHour`, default `60`, max `600`) enforced across event, schedule, manual, and live test runs. Exceeding either records `state = "rate_limited"` (`reasonCode = "AUTOMATION_RATE_LIMITED"` / `"GLOBAL_RATE_LIMITED"`) and durable audit event `automation.run.rate_limited`.

---

## 3. tRPC Router (`trpc.automations.*`)

Mounted at `appRouter.automations` (`server/modules/automations/router.ts`).
- Read procedures require `adminProcedure.use(requireCapability("automations.read"))`.
- Mutating / live-execution procedures require `adminProcedure.use(requireCapability("automations.manage"))` (which enforces fresh MFA step-up via `STEP_UP_CAPABILITIES` + in-transaction actor re-validation).

| Procedure | Type | Guard | Input / Output Summary |
| --- | --- | --- | --- |
| `automations.catalogue` | `query` | `automations.read` | `void` → `AutomationCatalogueView` (`globallyEnabled`, `limits`, `triggers`, `actions` with `configFields`, `operatorsByFieldType`, `starterRecipes`) |
| `automations.settings.get` | `query` | `automations.read` | `void` → `AutomationSettingsView` |
| `automations.settings.update` | `mutation` | `automations.manage` (step-up) | `Partial<AutomationSettingsView>` → `AutomationSettingsView` |
| `automations.list` | `query` | `automations.read` | `{ cursor?, limit?, enabled?, triggerMode?, query? }` → `{ items: AutomationSummaryView[], nextCursor }` |
| `automations.get` | `query` | `automations.read` | `{ publicId }` → `AutomationDetailView` (secrets masked via `secretStatus`) |
| `automations.versions` | `query` | `automations.read` | `{ publicId, limit? }` → `{ items: AutomationVersionView[] }` |
| `automations.create` | `mutation` | `automations.manage` (step-up) | `{ name, description?, enabled?, maxRunsPerHour?, trigger, conditions?, actions, canvasLayout? }` → `AutomationDetailView` (creates version `1`) |
| `automations.update` | `mutation` | `automations.manage` (step-up) | `{ publicId, expectedVersion, ... }` → `AutomationDetailView` (increments `version` + appends immutable `automation_versions` snapshot) |
| `automations.setEnabled` | `mutation` | `automations.manage` (step-up) | `{ publicId, expectedVersion, enabled }` → `AutomationDetailView` |
| `automations.duplicate` | `mutation` | `automations.manage` (step-up) | `{ publicId, name? }` → `AutomationDetailView` (starts `enabled: false`; secrets are NOT copied and require explicit configuration) |
| `automations.delete` | `mutation` | `automations.manage` (step-up) | `{ publicId, expectedVersion }` → `{ deleted: true }` |
| `automations.reorder` | `mutation` | `automations.manage` (step-up) | `{ orderedPublicIds: string[] }` → `{ orderedPublicIds: string[] }` (assigns deterministic `sortOrder = 10, 20, 30...`; rule evaluation and `automations.list` execute in `(sortOrder ASC, id ASC)` order) |
| `automations.triggerManual` | `mutation` | `automations.manage` (step-up) | `{ publicId, orderPublicId?, sampleFields? }` → `{ runPublicId, jobId }` |
| `automations.testRun` | `mutation` | `automations.read` (dry-run) / `automations.manage` (`executeLive: true`) | `{ publicId?, trigger, conditions?, actions, sampleFields?, orderPublicId?, executeLive?: boolean }` → `AutomationTestRunResult` (defaults to `executeLive: false`, performing zero side effects) |
| `automations.runs.list` | `query` | `automations.read` | `{ automationPublicId?, orderPublicId?, state?, cursor?, limit? }` → `{ items: AutomationRunView[], nextCursor }` |
| `automations.runs.get` | `query` | `automations.read` | `{ runPublicId }` → `AutomationRunView` (includes ordered `steps` with timings, attempts, `state`, `reasonCode`, `safeSummary`, plus `orderPublicId`, `stageStepKey`, and `triggeredBy`) |
| `automations.orderStageActions.get` | `query` | `orders.automations.run` (`staff` / `admin`) | `{ orderPublicId, runLimit? }` → `OrderStageActionsView` (pinned workflow stages & 5-slot phase bundles, legacy steps, readiness flags, `requiresStepUp: true`, `recentStageRuns`, `recentCompletionJobs`, and `recentRuns`) |
| `automations.orderStageActions.listRuns` | `query` | `orders.automations.run` (`staff` / `admin`) | `{ orderPublicId, cursor?, limit? }` → `{ items: AutomationRunView[], nextCursor }` |
| `automations.orderStageActions.runForOrder` | `mutation` | `orders.automations.run` (`staff` / `admin`) | `{ orderPublicId, stepKey, idempotencyKey }` → `OrderStageActionsRunResult` |
| `automations.orderStageActions.previewBundle` | `query` | `orders.automations.run` (`staff` / `admin`) | `{ orderPublicId, stageKey }` → `OrderStageBundlePreviewView` (5-slot preview, status transition/override eligibility, `orderVersion`, and keyed-HMAC `confirmationToken` bound to actor, session, pinned workflow version, live order state, and slot availability) |
| `automations.orderStageActions.runBundle` | `mutation` | `orders.stage.run` (`staff` / `admin`, step-up) | `{ orderPublicId, stageKey, idempotencyKey, confirmationToken, statusOverrideReason? }` → `RunOrderStageBundleResult` (executes 5-slot phase action bundle under `SELECT ... FOR UPDATE`, enforces `lockBlocks`/`orderLocked`, deduplicates `(orderId, idempotencyKey)`, declines stale confirmations with `STALE_STAGE_CONFIRMATION`) |
| `automations.orderStageActions.listBundleRuns` | `query` | `orders.automations.run` (`staff` / `admin`) | `{ orderPublicId, stageKey?, cursor?, limit? }` → `{ items: OrderStageRunView[], nextCursor }` |
| `automations.orderStageActions.listCompletionJobs` | `query` | `orders.automations.run` (`staff` / `admin`) | `{ orderPublicId, stageKey?, state?, cursor?, limit? }` → `{ items: OrderCompletionJobView[], nextCursor }` |
| `automations.orderStageActions.cancelCompletionJob` | `mutation` | `automations.manage` (`admin`, step-up) | `{ completionJobPublicId, reason? }` → `OrderCompletionJobView` (cancels a `scheduled` completion job idempotently) |

### 3.1 Workflow Stage Actions Binding & Safety Rules (Increment 04 Part B — Package T2)

- **Step binding** (`automationBindsToWorkflowStep`):
  - Only enabled event automations (`enabled === true` and `triggerMode === "event"`) are bound to workflow steps:
    - `triggerKey === "order.created"` binds to the workflow's `initial` step (`step.kind === "initial"`).
    - `triggerKey === "order.status_changed"` binds to `step` when its condition tree can match `to_status === step.key` and does not match an unmatched sentinel status (i.e. `to_status` `eq` / `in` rules targeting that step, including rules combined with `from_status` or `actor_role`; unconstrained global or `neq` catch-all rules do not bind to individual steps).
- **Engine readiness**: if `automations.config.enabled === false`, `orderStageActions.get` returns `engineEnabled: false` with a clear `engineDisabledReason`, and `runForOrder` refuses with `NOT_CONFIGURED` / `AUTOMATIONS_DISABLED`.
- **Per-run idempotency & rate limits**: `runForOrder` requires an `idempotencyKey` (`[A-Za-z0-9:_-]{8,64}`), hashes `(orderPublicId, stepKey, automationPublicId, idempotencyKey)` into `automation_runs.dedup_key`, tags each queued run row with `order_public_id`, `stage_step_key`, and `triggered_by_user_id`, and executes through `automations.execute_run` under existing global and per-automation rate limits.
- **Status & permission safety**: automations remain unable to change order status or user/role permissions (`assertAllowedActionKey` at registration/save time plus `ACTION_PROHIBITED` defense-in-depth enforcement in the worker before any step executes).

---

## 4. Job Types, Settings, Audit Events & Health

- **Jobs**:
  - `automations.evaluate_event` (`retrySafe: true`) — resolves matching enabled automations for a tapped `AuditTapEvent`, creates deduplicated `automation_runs` rows, and enqueues `automations.execute_run`.
  - `automations.execute_run` (`retrySafe: true` — step-level fencing prevents duplicate dispatch of `retrySafe: false` actions) — evaluates conditions, checks rate limits, executes ordered actions with per-step state/timings and exponential backoff on retryable failures.
  - `automations.schedule_tick` (registered via `jobs.registerSchedule`, every `60_000 ms`) — enqueues due `kind: "schedule"` automations within rate limits.
  - `automations.purge_runs` (registered via `jobs.registerSchedule`, daily) — purges terminal `automation_runs`, `order_stage_runs`, and `order_completion_jobs` rows older than `runRetentionDays`.
  - `automations.apply_completion` (`retrySafe: true`, one-shot delayed job) — applies `order_completion_jobs.resolved_percent` via `services.orders.stages.applyCompletionPercent` fenced by `expected_revision`, stage membership, order lock state, and cancellation; supersedes stale rows cleanly and emits an operational alert via `services.opsAlerts.emit` after 3 failed attempts.
- **Settings**:
  - `automations.config` (`{ enabled: false, stageBundlesEnabled: true, globalRunsPerMinute: 120, defaultPerAutomationRunsPerHour: 60, maxPerAutomationRunsPerHour: 600, runRetentionDays: 90 }`; legacy stored JSON without `stageBundlesEnabled` parses with `true`).
- **Increment 07 (D5) Phase Action Bundles, Triggers & Picker Catalogue**:
  - **5-Slot Phase Action Bundle (`stageBundles.ts`)**: executes pinned format-3 `stage.stageActions` slots (`status`, `completion`, `email`, `webhook`, `dashboard_alert`) only on explicit staff/admin confirmation (`orders.stage.run` + fresh MFA step-up + server-bound `confirmationToken`). Status slot requires `orders.transition` or admin override with reason (`>= 5` chars); unattended rules remain prohibited from changing order status. Emits `opsAlerts` on `partial_failed` / `failed` stage runs and terminal rule failures.
  - **Triggers**: `order.stage_submitted` (resolved in `builtinActions.ts`), `payment.succeeded` / `payment.failed` (`staffOnly: true`) / `payment.refunded` (resolved in `payments`), and `intake.submitted` / `intake.reviewed` (resolved in `compliance`, never exposing intake answers).
  - **Picker Options (`catalogue.pickerOptions`)**: returns structured option lists (`statuses`, `stages`, `workflows`, `paymentMethods`, `paymentProviders`, `intakeQuestionnaires`, `intakeDecisions`, `emailTemplates`, `phaseEmailTemplates`, `webhookSubscriptions`, `webhookTargets`, and `fieldOptionSources`) so rule and phase editors never ask administrators to type raw keys.
- **Durable Audit Events**:
  - `automation.settings.updated`, `automation.created`, `automation.updated`, `automation.enabled`, `automation.disabled`, `automation.duplicated`, `automation.deleted`, `automation.rules.reordered`, `automation.manual.triggered`, `automation.test.executed`, `automation.run.completed`, `automation.run.failed`, `automation.run.unknown`, `automation.run.rate_limited`, `order.stage_actions.run`, `order.stage_run.completed`, `order.stage_run.partial_failed`, `order.stage_run.failed`, `order.completion.scheduled`, `order.completion.updated`, `order.completion.superseded`, `order.completion.canceled`, `order.completion.failed`, `authz.automations.denied`.
- **Health Component**:
  - `automations.engine` (`disabled` when `automations.config.enabled === false`, otherwise `ok` / `degraded` based on recent failed/unknown runs).
