/**
 * Automations module — public contracts, trigger/action registries, and shared types (Increment 03, Package J).
 * Owner: engagement_engineer (`server/modules/automations/**`).
 *
 * Peer modules (`orders`, `files`, `storage`, `mailTemplates`, `compliance`, `backup`, `engagement`, `portable`)
 * import types and registration helpers from `server/modules/automations/contracts.js` (or `index.js`) without
 * circular dependencies. Registrations may be invoked either in `module.init()` via
 * `deps.services.automations.registerAutomationTrigger(...)` / `registerAutomationAction(...)` OR via the
 * module-level `registerAutomationTrigger(...)` / `registerAutomationAction(...)` functions exported here.
 * Every handler receives the active container's `db` and `services` at execution time so test containers stay isolated.
 */
import type { z } from "zod";
import type { Services } from "../../container.js";
import type {
  AuditEmitter,
  Clock,
  Db,
  DbOrTx,
  FieldCrypto,
  JobQueue,
  Logger,
  Mailer,
  ModuleLifecycle,
  SafeAttributeValue,
  SessionPrincipal,
  SettingsStore,
  Tx,
} from "../../core/types.js";
import type { AuditTapEvent } from "../audit/tap.js";
import type {
  TriggerCatalogueEntry,
  TriggerField,
  TriggerFieldType,
  TriggerRecipient,
} from "../audit/triggerCatalogue.js";

export type {
  AuditTapEvent,
  TriggerCatalogueEntry,
  TriggerField,
  TriggerFieldType,
  TriggerRecipient,
};

/* ------------------------------------------------------------------ scalars & limits */

export type AutomationScalarValue = string | number | boolean | null;

export const AUTOMATION_TRIGGER_MODES = ["event", "manual", "schedule"] as const;
export type AutomationTriggerMode = (typeof AUTOMATION_TRIGGER_MODES)[number];

export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "is_true",
  "is_false",
  "exists",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const AUTOMATION_RUN_STATES = [
  "queued",
  "running",
  "completed",
  "skipped_conditions",
  "rate_limited",
  "failed",
  "partial_unknown",
  "canceled",
] as const;
export type AutomationRunState = (typeof AUTOMATION_RUN_STATES)[number];

export const AUTOMATION_STEP_STATES = [
  "pending",
  "dispatching",
  "completed",
  "skipped",
  "failed",
  "unknown",
] as const;
export type AutomationStepState = (typeof AUTOMATION_STEP_STATES)[number];

export const AUTOMATION_MAX_CONDITION_GROUPS = 10 as const;
export const AUTOMATION_MAX_CONDITIONS_PER_GROUP = 20 as const;
export const AUTOMATION_MAX_ACTIONS = 10 as const;
export const AUTOMATION_MIN_SCHEDULE_MINUTES = 15 as const;
export const AUTOMATION_MAX_SCHEDULE_MINUTES = 10_080 as const; // 7 days
export const AUTOMATION_MAX_ACTIVE_SCHEDULES = 50 as const;

/**
 * Action keys that are prohibited by architecture (ADR 0026 & Contract §2.J):
 * no automation action may mutate order status, permissions, roles, credentials, or platform settings.
 */
export const PROHIBITED_ACTION_PREFIXES = [
  "orders.transition",
  "orders.set_status",
  "orders.status",
  "orders.reassign",
  "order.transition",
  "order.set_status",
  "order.status",
  "order.change_status",
  "order.reassign",
  "identity.role",
  "identity.permission",
  "identity.credentials",
  "user.role",
  "user.set_role",
  "user.grant_permission",
  "user.revoke_permission",
  "role.",
  "roles.",
  "permission.",
  "assurance.",
  "platform.settings",
  "capabilities.",
  "permissions.",
] as const;

/* ------------------------------------------------------------------ trigger registry */

export interface AutomationTriggerResolveInput {
  /** Catalogue key, e.g. `order.created`, `file.uploaded`, `backup.failed`. */
  triggerKey: string;
  /** Validated durable audit tap event that triggered evaluation. */
  event: AuditTapEvent;
  /** Read-only database handle for loading non-secret context metadata. Do not hold across network I/O. */
  db: DbOrTx;
  /** Active container services so resolvers always use their own container's modules in tests & production. */
  services: Services;
  signal: AbortSignal;
}

export interface AutomationResolvedTriggerContext {
  /**
   * Context-resolved scalar fields (`from: "context"` in the catalogue entry).
   * Keys not declared on the trigger's `fields` list are stripped automatically.
   * Never include secrets, tokens, raw message/ticket bodies, or e-mail addresses;
   * `personal: true` fields (such as `recipient_name`) are resolved per recipient at mail-render time.
   */
  fields?: Readonly<Record<string, AutomationScalarValue>>;
  /**
   * Recipient user IDs (`users.id`) keyed by `TriggerRecipient.key` (e.g. `{ order_owner: [42], order_assignee: [7] }`).
   * Role-based recipients (`administrators`, `staff`) and `actor` (`event.actor.userId`) are resolved automatically
   * by the automations engine when omitted.
   */
  recipients?: Readonly<Record<string, readonly number[]>>;
  /**
   * Canonical order `publicId` when the trigger event belongs to or references an order
   * (used by order-scoped actions like `sharepoint.sync_order` and `storage.copy_order_files`).
   * Automatically populated from `event.resource.publicId` when `event.resource.type === "order"`.
   */
  orderPublicId?: string | null;
  /**
   * Canonical file `publicId` when the trigger event is for a specific file (`file.uploaded`),
   * automatically populated from `event.resource.publicId` when `event.resource.type === "file"`.
   */
  filePublicId?: string | null;
}

export type AutomationTriggerContextResolver = (
  input: AutomationTriggerResolveInput,
) => Promise<AutomationResolvedTriggerContext>;

export interface AutomationTriggerRegistration {
  /**
   * Stable trigger key (e.g. `order.created`, `order.status_changed`, `backup.remote_copy_failed`).
   * Must match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`.
   */
  key: string;
  /**
   * Full `TriggerCatalogueEntry` when registering a new trigger not yet in `TRIGGER_CATALOGUE`,
   * OR optional `fields` / `recipients` additions to merge onto an existing `TRIGGER_CATALOGUE` entry.
   */
  entry?:
    | TriggerCatalogueEntry
    | {
        fields?: readonly TriggerField[];
        recipients?: readonly TriggerRecipient[];
      };
  /**
   * Optional worker-side context resolver invoked when conditions or actions need `from: "context"` fields
   * or user-kind `recipients`.
   */
  resolveContext?: AutomationTriggerContextResolver;
}

/* ------------------------------------------------------------------ action registry */

export type AutomationConfigFieldType =
  | "string"
  | "textarea"
  | "number"
  | "boolean"
  | "enum"
  | "string_list"
  | "trigger_recipient"
  | "trigger_fields"
  | "secret"
  | "email"
  | "https_url"
  | "template_key"
  | "storage_connection";

export interface AutomationActionConfigField {
  key: string;
  label: string;
  helpText?: string;
  type: AutomationConfigFieldType;
  required: boolean;
  /** True when stored encrypted in `automation_secrets` and write-only in API responses (`secretStatus` returned). */
  secret?: boolean;
  enumOptions?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface AutomationActionRunContext<C = Record<string, unknown>> {
  /** Opaque `publicId` of the automation definition. */
  automationPublicId: string;
  /** Immutable version number of the automation being executed. */
  automationVersion: number;
  /** Opaque `publicId` of this `automation_runs` row. */
  runPublicId: string;
  /** Zero-based index of the step in the version's ordered action list. */
  stepIndex: number;
  /** Stable step key within the automation definition (`step_1`, …). */
  stepKey: string;
  /**
   * Deterministic idempotency key (`auto:<runPublicId>:step:<stepKey>`) unique to this
   * `(run, automationVersion, step)` execution. Pass directly to `jobs.enqueue`, `mailer.enqueue`,
   * `notifications.notify`, etc.
   */
  idempotencyKey: string;
  /**
   * Durable automation-origin correlation ID (`automation:<runPublicId>`).
   * MUST be propagated to every enqueued job, outbound mail, audit event, and downstream call so
   * asynchronous descendants never re-trigger automations (Decision 10, Gate 4.1 J).
   */
  correlationId: string;
  /** How this run was initiated. */
  triggerMode: AutomationTriggerMode;
  /** Catalogue trigger key when `triggerMode === "event"`, otherwise `null`. */
  triggerKey: string | null;
  /** Source durable audit event ID when `triggerMode === "event"`, otherwise `null`. */
  triggerEventId: string | null;
  /** Validated configuration object parsed by `definition.configSchema`. */
  config: C;
  /** Decrypted step secrets keyed by secret field name (empty object when action has no secrets). Never log! */
  secrets: Readonly<Record<string, string>>;
  /**
   * Allowlisted non-personal scalar fields (`from: "event"` + `from: "context"`).
   * Safe for logic-less `{{field}}` substitution and explicit field-allowlisted payloads.
   */
  fields: Readonly<Record<string, AutomationScalarValue>>;
  /**
   * Resolved recipient `users.id` lists keyed by `TriggerRecipient.key`
   * (including `administrators`, `staff`, `actor`, and module-resolved keys such as `order_owner`).
   */
  recipients: Readonly<Record<string, readonly number[]>>;
  /** Canonical order `publicId` when available in the trigger/manual context, otherwise `null`. */
  orderPublicId: string | null;
  /** Canonical file `publicId` when triggered by a file event (`file.uploaded`), otherwise `null`. */
  filePublicId: string | null;
  /** True when the trigger is marked `staffOnly: true` (forbids customer recipients, fixed external emails, and webhooks). */
  staffOnlyTrigger: boolean;
  /** True only during dry-run `testRun` when `executeLive === false` (actions MUST NOT perform side effects). */
  dryRun: boolean;
  /** Worker lease fence from `ClaimedJob.assertStillOwned`. Call before any non-idempotent external write. */
  assertStillOwned: (tx?: Tx) => Promise<void>;
  signal: AbortSignal;
  /** Container-scoped infrastructure & module services for this worker execution. */
  deps: {
    db: Db;
    clock: Clock;
    logger: Logger;
    audit: AuditEmitter;
    crypto: FieldCrypto;
    settings: SettingsStore;
    mailer: Mailer;
    jobs: JobQueue;
    services: Services;
  };
}

export type AutomationActionRunResult =
  | {
      outcome: "completed";
      safeSummary?: string;
      safeCounts?: Record<string, number>;
      externalRef?: string;
    }
  | {
      outcome: "skipped";
      reasonCode: string;
      safeSummary?: string;
    }
  | {
      outcome: "failed";
      reasonCode: string;
      /** True ONLY when safe to retry with backoff without duplicating an already-accepted external effect. */
      retryable: boolean;
      safeSummary?: string;
    }
  | {
      /**
       * Ambiguous external outcome (e.g. lost lease or connection drop after request bytes were written).
       * Never automatically retried for non-idempotent actions (Gate 4.1 J).
       */
      outcome: "unknown";
      reasonCode: string;
      safeSummary?: string;
    };

export interface AutomationActionRegistration<C = Record<string, unknown>> {
  /**
   * Stable action key, e.g.:
   *  - `"email.send_template"` (built-in / package D)
   *  - `"notification.send_in_app"` (built-in)
   *  - `"support.create_ticket"` (built-in)
   *  - `"webhook.call"` (built-in)
   *  - `"sharepoint.sync_order"` (package H — `portable_contract_engineer`)
   *  - `"storage.copy_order_files"` (package G — `files_engineer`)
   */
  key: string;
  label: string;
  description: string;
  category: "Messaging" | "Support" | "Integrations" | "Storage and sync";
  owner: "automations" | "mailTemplates" | "engagement" | "integrations" | "storage" | "portable";
  /** Strict Zod object validating non-secret `config` on save and before execution. */
  configSchema: z.ZodType<C>;
  /** Optional strict Zod schema for write-only step `secrets` (e.g. `{ signingSecret }`). */
  secretsSchema?: z.ZodType<Record<string, string>>;
  /** Serializable field metadata so the Wizard and FlowCanvas builders render typed forms without expressions. */
  configFields: readonly AutomationActionConfigField[];
  /** When true, builder & validator require a trigger (or manual input) that supplies `orderPublicId`. */
  requiresOrderContext?: boolean;
  /**
   * When true, this action cannot be used on `staffOnly: true` triggers (e.g. `webhook.call` or external sinks),
   * enforced both on save and at run time (`J-A01`).
   */
  forbidOnStaffOnlyTrigger?: boolean;
  /** Defaults to all trigger modes (`["event", "manual", "schedule"]`). */
  supportedTriggerModes?: readonly AutomationTriggerMode[];
  /**
   * Declare `true` ONLY when re-running an interrupted step with the same `idempotencyKey` cannot duplicate
   * an external effect (e.g. enqueuing an idempotent DB job/mail/notification). Must be `false` for direct
   * outbound HTTP calls like `webhook.call` so lease loss or mid-flight crashes become `unknown` instead of
   * dispatching twice.
   */
  retrySafe: boolean;
  /** Worker-side execution handler. */
  run(ctx: AutomationActionRunContext<C>): Promise<AutomationActionRunResult>;
}

/* ------------------------------------------------------------------ automation model & views */

export type AutomationTriggerConfig =
  | { kind: "event"; triggerKey: string }
  | { kind: "manual"; requireOrderPublicId?: boolean }
  | { kind: "schedule"; everyMinutes: number };

export interface AutomationConditionLeaf {
  field: string;
  operator: ConditionOperator;
  value?: string | number | boolean | readonly (string | number)[] | null;
}

export interface AutomationConditionGroup {
  match: "all" | "any";
  conditions: readonly AutomationConditionLeaf[];
}

export interface AutomationConditionTree {
  match: "all" | "any";
  groups: readonly AutomationConditionGroup[];
}

export interface CanvasNodePosition {
  x: number;
  y: number;
}

export interface AutomationCanvasLayout {
  /** Node coordinates keyed by `"trigger"`, `"conditions"`, or `stepKey`. Data-only coordinates. */
  positions: Readonly<Record<string, CanvasNodePosition>>;
}

export interface AutomationActionStepInput {
  stepKey: string;
  actionKey: string;
  label?: string;
  config: Record<string, unknown>;
  /**
   * Write-only secret values keyed by secret field name.
   * On update: omit/`undefined` keeps the existing secret for the same `stepKey`, `null` clears it,
   * non-empty string replaces it.
   */
  secrets?: Record<string, string | null>;
}

export interface AutomationSecretFieldStatus {
  configured: boolean;
  last4: string | null;
}

export interface AutomationActionStepView {
  stepKey: string;
  actionKey: string;
  label: string | null;
  config: Record<string, unknown>;
  secretStatus: Record<string, AutomationSecretFieldStatus>;
}

export interface AutomationSummaryView {
  publicId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  trigger: AutomationTriggerConfig;
  conditionGroupCount: number;
  actionCount: number;
  maxRunsPerHour: number;
  lastRun: {
    publicId: string;
    state: AutomationRunState;
    triggerMode: AutomationTriggerMode;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationDetailView extends AutomationSummaryView {
  conditions: AutomationConditionTree;
  actions: readonly AutomationActionStepView[];
  canvasLayout: AutomationCanvasLayout | null;
}

export interface AutomationVersionView {
  version: number;
  trigger: AutomationTriggerConfig;
  conditions: AutomationConditionTree;
  actions: readonly AutomationActionStepView[];
  canvasLayout: AutomationCanvasLayout | null;
  createdByUserPublicId: string | null;
  createdAt: Date;
}

export interface AutomationRunStepView {
  stepIndex: number;
  stepKey: string;
  actionKey: string;
  state: AutomationStepState;
  attemptCount: number;
  reasonCode: string | null;
  safeSummary: string | null;
  safeCounts: Record<string, number> | null;
  externalRef: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
}

export interface OrderStageRunActorView {
  publicId: string;
  displayName: string;
  role: "admin" | "staff" | "customer";
}

export interface AutomationRunView {
  publicId: string;
  automationPublicId: string;
  automationName: string;
  automationVersion: number;
  triggerMode: AutomationTriggerMode;
  triggerKey: string | null;
  triggerEventId: string | null;
  orderPublicId: string | null;
  stageStepKey: string | null;
  triggeredBy: OrderStageRunActorView | null;
  correlationId: string;
  isTest: boolean;
  state: AutomationRunState;
  reasonCode: string | null;
  /** Non-personal scalar snapshot evaluated for conditions (never contains `personal: true` fields or secrets). */
  evaluatedFields: Record<string, SafeAttributeValue>;
  steps: readonly AutomationRunStepView[];
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
}

export interface OrderStageBoundAutomationView {
  publicId: string;
  name: string;
  description: string | null;
  version: number;
  triggerKey: string;
  actionCount: number;
  actionLabels: readonly string[];
}

export interface OrderStageStepView {
  stepKey: string;
  label: string;
  customerLabel: string;
  kind: "initial" | "active" | "terminal";
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  phaseKey: string | null;
  isCurrentOrderStep: boolean;
  configuredAutomationCount: number;
  configuredActionCount: number;
  automations: readonly OrderStageBoundAutomationView[];
}

export interface OrderStageActionsView {
  orderPublicId: string;
  orderReference: string;
  currentStatusKey: string;
  workflowKey: string;
  workflowVersionNumber: number;
  engineEnabled: boolean;
  engineDisabledReason: string | null;
  settingsPath: "/admin/automations";
  canManageAutomations: boolean;
  steps: readonly OrderStageStepView[];
  recentRuns: readonly AutomationRunView[];
}

export interface OrderStageActionsRunResult {
  orderPublicId: string;
  stepKey: string;
  queuedRuns: readonly {
    runPublicId: string;
    automationPublicId: string;
    automationName: string;
    jobId: string;
    deduplicated: boolean;
  }[];
}

export interface AutomationStarterRecipe {
  key: string;
  name: string;
  description: string;
  trigger: AutomationTriggerConfig;
  conditions: AutomationConditionTree;
  actions: readonly Omit<AutomationActionStepInput, "secrets">[];
}

export interface AutomationCatalogueView {
  /** Global feature switch (`automations.enabled`); ships `false` by default until an admin enables it. */
  globallyEnabled: boolean;
  limits: {
    globalRunsPerMinute: number;
    defaultPerAutomationRunsPerHour: number;
    maxPerAutomationRunsPerHour: number;
    maxActionsPerAutomation: number;
    maxConditionGroups: number;
    maxConditionsPerGroup: number;
    minScheduleMinutes: number;
    maxScheduleMinutes: number;
    maxActiveSchedules: number;
  };
  triggers: readonly TriggerCatalogueEntry[];
  actions: readonly {
    key: string;
    label: string;
    description: string;
    category: AutomationActionRegistration["category"];
    owner: AutomationActionRegistration["owner"];
    configFields: readonly AutomationActionConfigField[];
    requiresOrderContext: boolean;
    forbidOnStaffOnlyTrigger: boolean;
    supportedTriggerModes: readonly AutomationTriggerMode[];
    retrySafe: boolean;
  }[];
  operatorsByFieldType: Readonly<Record<TriggerFieldType, readonly ConditionOperator[]>>;
  starterRecipes: readonly AutomationStarterRecipe[];
}

export interface AutomationSettingsView {
  enabled: boolean;
  globalRunsPerMinute: number;
  defaultPerAutomationRunsPerHour: number;
  maxPerAutomationRunsPerHour: number;
  runRetentionDays: number;
}

export interface AutomationTestRunResult {
  dryRun: boolean;
  conditionsMatched: boolean;
  groupResults: readonly {
    groupIndex: number;
    match: "all" | "any";
    matched: boolean;
    leafResults: readonly {
      field: string;
      operator: ConditionOperator;
      actualValue: AutomationScalarValue | undefined;
      matched: boolean;
    }[];
  }[];
  plannedSteps: readonly {
    stepIndex: number;
    stepKey: string;
    actionKey: string;
    wouldRun: boolean;
    previewSummary: string;
  }[];
  /** Populated only when `executeLive === true` was requested and conditions matched. */
  liveRunPublicId: string | null;
}

/* ------------------------------------------------------------------ module service interface */

export interface AutomationsModule extends ModuleLifecycle {
  /** Register or enrich a trigger catalogue entry + context resolver (safe at module load or in `init()`). */
  registerAutomationTrigger(registration: AutomationTriggerRegistration): void;
  /** Register an executable automation action (safe at module load or in `init()`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAutomationAction<C = any>(
    registration: AutomationActionRegistration<C>,
    options?: { replaceBuiltIn?: boolean },
  ): void;

  /**
   * Trusted server-internal port (Package I outbound webhooks): returns all registered trigger
   * catalogue entries (built-in `TRIGGER_CATALOGUE` merged with dynamic registrations) without requiring a user principal.
   * Callers dispatching to external endpoints MUST respect `entry.staffOnly === true` (refuse or omit internal triggers).
   */
  listTriggerCatalogue(): readonly TriggerCatalogueEntry[];

  /**
   * Trusted server-internal port (Package I outbound webhooks): returns all trigger catalogue entries matching `event`.
   */
  matchingTriggersForEvent(event: AuditTapEvent): readonly TriggerCatalogueEntry[];

  /**
   * Trusted server-internal port (Package I outbound webhooks): resolves non-personal `from: "event"` and
   * `from: "context"` scalar fields for `(triggerKey, event)` using registered context resolvers.
   * Never includes `personal: true` fields (such as `recipient_name`) or internal user IDs.
   */
  resolveTriggerEventFields(input: {
    triggerKey: string;
    event: AuditTapEvent;
    signal?: AbortSignal;
  }): Promise<{
    entry: TriggerCatalogueEntry;
    fields: Record<string, AutomationScalarValue>;
    orderPublicId: string | null;
    filePublicId: string | null;
    staffOnly: boolean;
  } | null>;

  getCatalogue(principal: SessionPrincipal): Promise<AutomationCatalogueView>;
  getSettings(principal: SessionPrincipal): Promise<AutomationSettingsView>;
  updateSettings(
    principal: SessionPrincipal,
    input: Partial<AutomationSettingsView>,
  ): Promise<AutomationSettingsView>;

  list(
    principal: SessionPrincipal,
    input: {
      cursor?: string;
      limit?: number;
      enabled?: boolean;
      triggerMode?: AutomationTriggerMode;
      query?: string;
    },
  ): Promise<{ items: AutomationSummaryView[]; nextCursor: string | null }>;

  get(principal: SessionPrincipal, input: { publicId: string }): Promise<AutomationDetailView>;

  listVersions(
    principal: SessionPrincipal,
    input: { publicId: string; limit?: number },
  ): Promise<{ items: AutomationVersionView[] }>;

  create(
    principal: SessionPrincipal,
    input: {
      name: string;
      description?: string | null;
      enabled?: boolean;
      maxRunsPerHour?: number;
      trigger: AutomationTriggerConfig;
      conditions?: AutomationConditionTree;
      actions: readonly AutomationActionStepInput[];
      canvasLayout?: AutomationCanvasLayout | null;
    },
  ): Promise<AutomationDetailView>;

  update(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      expectedVersion: number;
      name?: string;
      description?: string | null;
      enabled?: boolean;
      maxRunsPerHour?: number;
      trigger?: AutomationTriggerConfig;
      conditions?: AutomationConditionTree;
      actions?: readonly AutomationActionStepInput[];
      canvasLayout?: AutomationCanvasLayout | null;
    },
  ): Promise<AutomationDetailView>;

  setEnabled(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; enabled: boolean },
  ): Promise<AutomationDetailView>;

  duplicate(
    principal: SessionPrincipal,
    input: { publicId: string; name?: string },
  ): Promise<AutomationDetailView>;

  remove(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number },
  ): Promise<{ deleted: true }>;

  triggerManual(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      orderPublicId?: string | null;
      sampleFields?: Record<string, AutomationScalarValue>;
    },
  ): Promise<{ runPublicId: string; jobId: string }>;

  testRun(
    principal: SessionPrincipal,
    input: {
      publicId?: string;
      trigger: AutomationTriggerConfig;
      conditions?: AutomationConditionTree;
      actions: readonly AutomationActionStepInput[];
      sampleFields?: Record<string, AutomationScalarValue>;
      orderPublicId?: string | null;
      /** Defaults to `false` (sends/writes nothing). Setting `true` requires `automations.manage` + step-up and obeys rate limits. */
      executeLive?: boolean;
    },
  ): Promise<AutomationTestRunResult>;

  listRuns(
    principal: SessionPrincipal,
    input: {
      automationPublicId?: string;
      orderPublicId?: string;
      state?: AutomationRunState;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: AutomationRunView[]; nextCursor: string | null }>;

  getRun(principal: SessionPrincipal, input: { runPublicId: string }): Promise<AutomationRunView>;

  /**
   * Increment 04 Part B (Package T2 — B4 "Workflow stage actions"):
   * Lists the steps of the order's pinned workflow version with enabled automations bound to each step,
   * engine readiness state, and recent order-scoped automation runs. Requires `orders.automations.run`.
   */
  getOrderStageActions(
    principal: SessionPrincipal,
    input: { orderPublicId: string; runLimit?: number },
  ): Promise<OrderStageActionsView>;

  /**
   * Increment 04 Part B (Package T2): paginated automation run history scoped to one order.
   * Requires `orders.automations.run`.
   */
  listOrderStageRuns(
    principal: SessionPrincipal,
    input: { orderPublicId: string; cursor?: string; limit?: number },
  ): Promise<{ items: AutomationRunView[]; nextCursor: string | null }>;

  /**
   * Increment 04 Part B (Package T2 — B4 "Workflow stage actions"):
   * Queues and runs the enabled automations bound to `stepKey` on `orderPublicId` through the
   * automations engine with per-run idempotency, rate limits, run-history tagging, and `order.stage_actions.run` audit.
   * Requires `orders.automations.run`.
   */
  runForOrder(
    principal: SessionPrincipal,
    input: { orderPublicId: string; stepKey: string; idempotencyKey: string },
  ): Promise<OrderStageActionsRunResult>;
}

/* ------------------------------------------------------------------ shared static registry backing */

const STATIC_TRIGGER_REGISTRATIONS = new Map<string, AutomationTriggerRegistration>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STATIC_ACTION_REGISTRATIONS = new Map<string, AutomationActionRegistration<any>>();

const TRIGGER_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ACTION_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function assertValidTriggerKey(key: string): void {
  if (!TRIGGER_KEY_RE.test(key) || key.length > 80) {
    throw new TypeError(`Invalid automation trigger key: ${key}`);
  }
}

export function isProhibitedActionKey(key: string): boolean {
  for (const forbidden of PROHIBITED_ACTION_PREFIXES) {
    if (key === forbidden || key.startsWith(forbidden)) {
      return true;
    }
  }
  return false;
}

export function assertAllowedActionKey(key: string): void {
  if (!ACTION_KEY_RE.test(key) || key.length > 80) {
    throw new TypeError(`Invalid automation action key: ${key}`);
  }
  if (isProhibitedActionKey(key)) {
    throw new TypeError(
      `Automation action key "${key}" is prohibited: actions may never mutate order status, permissions, credentials, or settings`,
    );
  }
}

/**
 * Process-level registration helper so peer modules (`orders`, `files`, `compliance`, `backup`, `engagement`)
 * can register trigger context resolvers without waiting on container wiring order.
 * Every container created afterwards inherits these registrations automatically while passing its own `db`/`services`.
 */
export function registerAutomationTrigger(registration: AutomationTriggerRegistration): void {
  assertValidTriggerKey(registration.key);
  STATIC_TRIGGER_REGISTRATIONS.set(registration.key, registration);
}

/**
 * Process-level registration helper so peer modules (`mailTemplates`, `storage`, `portable`)
 * can register automation actions cleanly without circular imports.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAutomationAction<C = any>(
  registration: AutomationActionRegistration<C>,
  options?: { replaceBuiltIn?: boolean },
): void {
  assertAllowedActionKey(registration.key);
  if (STATIC_ACTION_REGISTRATIONS.has(registration.key) && !options?.replaceBuiltIn) {
    STATIC_ACTION_REGISTRATIONS.set(registration.key, registration);
    return;
  }
  STATIC_ACTION_REGISTRATIONS.set(registration.key, registration);
}

/** Internal reader used by `createAutomationsModule` to seed each container's isolated registry. */
export function getStaticAutomationRegistrations(): {
  triggers: ReadonlyMap<string, AutomationTriggerRegistration>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: ReadonlyMap<string, AutomationActionRegistration<any>>;
} {
  return {
    triggers: STATIC_TRIGGER_REGISTRATIONS,
    actions: STATIC_ACTION_REGISTRATIONS,
  };
}
