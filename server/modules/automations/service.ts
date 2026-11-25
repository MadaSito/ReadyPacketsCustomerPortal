/**
 * Automations module — core service, registry runtime, audit tap, and worker execution engine.
 * Owner: Package J server (`server/modules/automations/**`).
 */
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, conflict, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type {
  ClaimedJob,
  JobResult,
  ModuleHealth,
  SafeAttributeValue,
  SessionPrincipal,
  Tx,
} from "../../core/types.js";
import {
  AUTOMATION_ORIGIN_PREFIX,
  automationCorrelationId,
  isAutomationOrigin,
  type AuditTapEvent,
} from "../audit/tap.js";
import {
  TRIGGER_CATALOGUE,
  catalogueEntry,
  entriesForEvent,
  eventFieldValue,
  type TriggerCatalogueEntry,
  type TriggerField,
} from "../audit/triggerCatalogue.js";
import { users } from "../identity/schema.js";
import { readSetting, writeSetting } from "../platform/index.js";
import {
  assertAutomationsActorInTx,
  assertAutomationsCapabilityPreflight,
} from "./authz.js";
import {
  CUSTOMER_RECIPIENT_KEYS,
  STAFF_ONLY_ALLOWED_ACTION_KEYS,
  STARTER_RECIPES,
  attachWebhookBeforeSendFence,
  ensureAutomationMailTemplateRegistered,
  validateBuiltInActionTemplates,
} from "./builtinActions.js";
import {
  EMPTY_CONDITION_TREE,
  OPERATORS_BY_FIELD_TYPE,
  conditionTreeSchema,
  evaluateConditionLeaf,
  evaluateConditionTree,
  validateConditionTreeForFields,
} from "./conditions.js";
import {
  AUTOMATION_MAX_ACTIONS,
  AUTOMATION_MAX_ACTIVE_SCHEDULES,
  AUTOMATION_MAX_CONDITIONS_PER_GROUP,
  AUTOMATION_MAX_CONDITION_GROUPS,
  AUTOMATION_MAX_SCHEDULE_MINUTES,
  AUTOMATION_MIN_SCHEDULE_MINUTES,
  assertAllowedActionKey,
  assertValidTriggerKey,
  getStaticAutomationRegistrations,
  isProhibitedActionKey,
  type AutomationActionRegistration,
  type AutomationActionRunContext,
  type AutomationActionRunResult,
  type AutomationActionStepInput,
  type AutomationActionStepView,
  type AutomationCanvasLayout,
  type AutomationCatalogueView,
  type AutomationConditionTree,
  type AutomationDetailView,
  type AutomationRunState,
  type AutomationRunStepView,
  type AutomationRunView,
  type AutomationScalarValue,
  type AutomationSettingsView,
  type AutomationSummaryView,
  type AutomationTestRunResult,
  type AutomationTriggerConfig,
  type AutomationTriggerMode,
  type AutomationTriggerRegistration,
  type AutomationVersionView,
  type AutomationsModule,
  type CompletionJobState,
  type OrderCompletionJobView,
  type OrderStageActionsRunResult,
  type OrderStageActionsView,
  type OrderStageBoundAutomationView,
  type OrderStageBundlePreviewView,
  type OrderStageRunActorView,
  type OrderStageRunView,
  type OrderStageStepView,
  type RunOrderStageBundleResult,
} from "./contracts.js";
import { buildCataloguePickerOptions } from "./catalogueOptions.js";
import {
  JOB_APPLY_COMPLETION,
  cancelOrderCompletionJobByAdmin,
  handleApplyCompletionJob,
  handleOrderChangeForCompletionJobs,
  listOrderCompletionJobsForOrder,
  sanitizeOpsAlertCopy,
  type ApplyCompletionJobPayload,
} from "./completionJobs.js";
import {
  automationRunSteps,
  automationRuns,
  automationSecrets,
  automationVersions,
  automations,
  orderCompletionJobs,
  orderStageRuns,
} from "./schema.js";
import { AUTOMATIONS_CONFIG, automationsConfigSchema } from "./settings.js";
import {
  STAGE_BUNDLES_DISABLED_MESSAGE,
  buildOrderPhaseBundleSection,
  executeOrderStageBundle,
  listOrderStageBundleRuns,
  previewOrderStageBundle,
} from "./stageBundles.js";
import { renderPlainTemplate } from "./templates.js";

export const JOB_EVALUATE_EVENT = "automations.evaluate_event";
export const JOB_EXECUTE_RUN = "automations.execute_run";
export const JOB_SCHEDULE_TICK = "automations.schedule_tick";
export const JOB_PURGE_RUNS = "automations.purge_runs";

const MAX_STEP_ATTEMPTS = 4;
const MAX_LIVE_TEST_RUNS_PER_HOUR = 10;
const STEP_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const STAGE_STEP_KEY_RE = /^[a-z][a-z0-9_]{1,47}$/;
const STAGE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{8,64}$/;
const UNMATCHED_STEP_SENTINEL = "__rp_unmatched_step_sentinel__";
const ENGINE_DISABLED_STAGE_MESSAGE =
  "Automations engine is turned off. Enable it in Automations settings before running stage actions.";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canConditionTreeMatchStatus(
  tree: AutomationConditionTree,
  candidateStatus: string,
): boolean {
  if (tree.groups.length === 0) return true;
  const groupMatches = tree.groups.map((group) => {
    const leafMatches = group.conditions.map((leaf) => {
      if (leaf.field !== "to_status") return true;
      return evaluateConditionLeaf(leaf, candidateStatus);
    });
    return group.match === "all"
      ? leafMatches.every(Boolean)
      : leafMatches.some(Boolean);
  });
  return tree.match === "all"
    ? groupMatches.every(Boolean)
    : groupMatches.some(Boolean);
}

function conditionsBindSpecificallyToStep(
  tree: AutomationConditionTree,
  stepKey: string,
): boolean {
  return (
    canConditionTreeMatchStatus(tree, stepKey) &&
    !canConditionTreeMatchStatus(tree, UNMATCHED_STEP_SENTINEL)
  );
}

interface PersistedActionStep {
  stepKey: string;
  actionKey: string;
  label: string | null;
  config: Record<string, unknown>;
}

interface EvaluateEventJobPayload {
  event: AuditTapEvent;
}

interface ExecuteRunJobPayload {
  runPublicId: string;
}

interface TransientRunSnapshot {
  event?: AuditTapEvent | null;
  parentCorrelationId?: string | null;
  orderPublicId?: string | null;
  filePublicId?: string | null;
  actorUserId?: number | null;
  sampleFields?: Record<string, AutomationScalarValue> | null;
}

function computeRetryBackoffMs(attempt: number): number {
  return [5_000, 20_000, 60_000][Math.min(Math.max(attempt - 1, 0), 2)]!;
}

function encodeIdCursor(id: number): string {
  return Buffer.from(`v1:${id}`, "utf8").toString("base64url");
}

function decodeIdCursor(cursor: string | null | undefined): number | undefined {
  if (!cursor) return undefined;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const m = /^v1:(\d{1,18})$/.exec(raw);
    if (!m) throw new Error("bad cursor");
    const id = Number(m[1]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("bad id");
    return id;
  } catch {
    throw validation("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
}

function isFullCatalogueEntry(
  entry: AutomationTriggerRegistration["entry"],
): entry is TriggerCatalogueEntry {
  return Boolean(entry && "eventName" in entry && "label" in entry);
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return (
    anyErr.code === "ER_DUP_ENTRY" ||
    anyErr.errno === 1062 ||
    anyErr.cause?.code === "ER_DUP_ENTRY" ||
    anyErr.cause?.errno === 1062
  );
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function createAutomationsService(deps: ModuleDeps): AutomationsModule {
  const { db, clock, crypto, audit, jobs, settings, logger } = deps;

  const triggerMap = new Map<string, AutomationTriggerRegistration>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actionMap = new Map<string, AutomationActionRegistration<any>>();

  const staticRegs = getStaticAutomationRegistrations();
  for (const [k, t] of staticRegs.triggers.entries()) {
    triggerMap.set(k, t);
  }
  for (const [k, a] of staticRegs.actions.entries()) {
    assertAllowedActionKey(k);
    actionMap.set(k, a);
  }

  function registerAutomationTrigger(registration: AutomationTriggerRegistration): void {
    assertValidTriggerKey(registration.key);
    if (!catalogueEntry(registration.key) && !isFullCatalogueEntry(registration.entry)) {
      throw new Error(
        `Automation trigger '${registration.key}' is not in TRIGGER_CATALOGUE and did not supply a full TriggerCatalogueEntry.`,
      );
    }
    triggerMap.set(registration.key, registration);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function registerAutomationAction<C = any>(
    registration: AutomationActionRegistration<C>,
    options?: { replaceBuiltIn?: boolean },
  ): void {
    assertAllowedActionKey(registration.key);
    if (actionMap.has(registration.key) && !options?.replaceBuiltIn) {
      throw new Error(`Duplicate automation action registration: ${registration.key}`);
    }
    actionMap.set(registration.key, registration);
  }

  function mergeTriggerEntry(base: TriggerCatalogueEntry): TriggerCatalogueEntry {
    const reg = triggerMap.get(base.key);
    if (!reg?.entry || isFullCatalogueEntry(reg.entry)) return base;
    const extraFields = reg.entry.fields ?? [];
    const extraRecips = reg.entry.recipients ?? [];
    if (extraFields.length === 0 && extraRecips.length === 0) return base;
    const fieldKeys = new Set(base.fields.map((f) => f.key));
    const recipKeys = new Set(base.recipients.map((r) => r.key));
    return {
      ...base,
      fields: [...base.fields, ...extraFields.filter((f) => !fieldKeys.has(f.key))],
      recipients: [...base.recipients, ...extraRecips.filter((r) => !recipKeys.has(r.key))],
    };
  }

  function allTriggerEntries(): TriggerCatalogueEntry[] {
    const list: TriggerCatalogueEntry[] = TRIGGER_CATALOGUE.map(mergeTriggerEntry);
    for (const [k, reg] of triggerMap.entries()) {
      if (!catalogueEntry(k) && isFullCatalogueEntry(reg.entry)) {
        list.push(reg.entry);
      }
    }
    return list;
  }

  function findTriggerEntry(triggerKey: string): TriggerCatalogueEntry | undefined {
    const cat = catalogueEntry(triggerKey);
    if (cat) return mergeTriggerEntry(cat);
    const reg = triggerMap.get(triggerKey);
    return isFullCatalogueEntry(reg?.entry) ? reg.entry : undefined;
  }

  function entriesMatchingTapEvent(event: AuditTapEvent): TriggerCatalogueEntry[] {
    const matched = entriesForEvent(event).map(mergeTriggerEntry);
    for (const [k, reg] of triggerMap.entries()) {
      if (!catalogueEntry(k) && isFullCatalogueEntry(reg.entry)) {
        const e = reg.entry;
        const ok =
          e.eventName === event.eventName &&
          e.outcomes.includes(event.outcome) &&
          (e.resourceType === null || event.resource?.type === e.resourceType) &&
          Object.entries(e.match ?? {}).every(
            ([mk, expected]) => eventFieldValue(event, mk) === expected,
          );
        if (ok) matched.push(e);
      }
    }
    return matched;
  }

  /* ------------------------------------------------ Tap listen-set cache */

  let tapGloballyEnabled = false;
  let tapEnabledEventNames = new Set<string>();
  let tapRegistered = false;

  async function refreshTapCache(tx?: Tx): Promise<void> {
    const cfg = await readSetting(settings, AUTOMATIONS_CONFIG, tx);
    if (!cfg.enabled) {
      tapGloballyEnabled = false;
      tapEnabledEventNames = new Set();
      return;
    }
    const handle = tx ?? db;
    const rows = await handle
      .select({
        triggerKey: automations.triggerKey,
        triggerEventName: automations.triggerEventName,
      })
      .from(automations)
      .where(and(eq(automations.enabled, true), eq(automations.triggerMode, "event")));

    const nextEventNames = new Set<string>();
    for (const row of rows) {
      if (row.triggerEventName) nextEventNames.add(row.triggerEventName);
      if (row.triggerKey) {
        const entry = findTriggerEntry(row.triggerKey);
        if (entry) nextEventNames.add(entry.eventName);
      }
    }
    tapGloballyEnabled = true;
    tapEnabledEventNames = nextEventNames;
  }

  /* -------------------------------------------- Validation & J-A01 policy */

  function triggerProvidesOrderContext(
    trigger: AutomationTriggerConfig,
    entry: TriggerCatalogueEntry | undefined,
  ): boolean {
    if (trigger.kind === "manual") return trigger.requireOrderPublicId === true;
    if (trigger.kind === "schedule") return false;
    if (!entry) return false;
    return (
      entry.resourceType === "order" ||
      entry.fields.some((f) => f.key === "order_public_id" || f.key === "order_reference")
    );
  }

  function validateAutomationDefinition(input: {
    name: string;
    description?: string | null;
    maxRunsPerHour?: number | null;
    cfg: AutomationSettingsView;
    trigger: AutomationTriggerConfig;
    conditions?: AutomationConditionTree;
    actions: readonly AutomationActionStepInput[];
    canvasLayout?: AutomationCanvasLayout | null;
    existingSecretFieldsByStep?: Map<string, Set<string>>;
  }): {
    normalizedName: string;
    normalizedDescription: string | null;
    maxRunsPerHour: number;
    triggerMode: AutomationTriggerMode;
    triggerKey: string | null;
    triggerEventName: string | null;
    scheduleEveryMinutes: number | null;
    manualRequireOrder: boolean;
    triggerConfig: AutomationTriggerConfig;
    conditions: AutomationConditionTree;
    persistedActions: PersistedActionStep[];
    secretMutations: Array<{
      stepKey: string;
      fieldKey: string;
      op: "set" | "clear";
      value?: string;
    }>;
  } {
    const normalizedName = input.name.normalize("NFC").trim();
    if (normalizedName.length < 1 || normalizedName.length > 120) {
      throw validation("AUTOMATION_INVALID_NAME", "Automation name must be 1 to 120 characters.");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(normalizedName)) {
      throw validation("AUTOMATION_INVALID_NAME", "Automation name contains invalid characters.");
    }

    const rawDesc = input.description ? input.description.normalize("NFC").trim() : "";
    if (rawDesc.length > 500) {
      throw validation(
        "AUTOMATION_INVALID_DESCRIPTION",
        "Description must be 500 characters or fewer.",
      );
    }
    const normalizedDescription = rawDesc.length > 0 ? rawDesc : null;

    const maxRunsPerHour =
      input.maxRunsPerHour ?? input.cfg.defaultPerAutomationRunsPerHour;
    if (
      !Number.isInteger(maxRunsPerHour) ||
      maxRunsPerHour < 1 ||
      maxRunsPerHour > input.cfg.maxPerAutomationRunsPerHour
    ) {
      throw validation(
        "AUTOMATION_INVALID_RATE_LIMIT",
        `Per-automation hourly limit must be between 1 and ${input.cfg.maxPerAutomationRunsPerHour}.`,
      );
    }

    let triggerMode: AutomationTriggerMode;
    let triggerKey: string | null = null;
    let triggerEventName: string | null = null;
    let scheduleEveryMinutes: number | null = null;
    let manualRequireOrder = false;
    let triggerConfig: AutomationTriggerConfig;
    let entry: TriggerCatalogueEntry | undefined;

    if (input.trigger.kind === "event") {
      triggerMode = "event";
      entry = findTriggerEntry(input.trigger.triggerKey);
      if (!entry) {
        throw validation("AUTOMATION_UNKNOWN_TRIGGER", "Selected trigger is not in the catalogue.");
      }
      triggerKey = entry.key;
      triggerEventName = entry.eventName;
      triggerConfig = { kind: "event", triggerKey: entry.key };
    } else if (input.trigger.kind === "schedule") {
      triggerMode = "schedule";
      const mins = input.trigger.everyMinutes;
      if (
        !Number.isInteger(mins) ||
        mins < AUTOMATION_MIN_SCHEDULE_MINUTES ||
        mins > AUTOMATION_MAX_SCHEDULE_MINUTES
      ) {
        throw validation(
          "AUTOMATION_INVALID_SCHEDULE",
          `Schedule interval must be between ${AUTOMATION_MIN_SCHEDULE_MINUTES} and ${AUTOMATION_MAX_SCHEDULE_MINUTES} minutes.`,
        );
      }
      scheduleEveryMinutes = mins;
      triggerConfig = { kind: "schedule", everyMinutes: mins };
    } else {
      triggerMode = "manual";
      manualRequireOrder = Boolean(input.trigger.requireOrderPublicId);
      triggerConfig = { kind: "manual", requireOrderPublicId: manualRequireOrder };
    }

    const rawConditions = input.conditions ?? EMPTY_CONDITION_TREE;
    const parsedConditions = conditionTreeSchema.safeParse(rawConditions);
    if (!parsedConditions.success) {
      throw validation("AUTOMATION_INVALID_CONDITIONS", "Condition groups are malformed.");
    }
    const conditions = parsedConditions.data;
    const triggerFields: readonly TriggerField[] = entry ? entry.fields : [];
    validateConditionTreeForFields(conditions, triggerFields);

    if (input.actions.length < 1 || input.actions.length > AUTOMATION_MAX_ACTIONS) {
      throw validation(
        "AUTOMATION_INVALID_ACTIONS",
        `An automation must define between 1 and ${AUTOMATION_MAX_ACTIONS} actions.`,
      );
    }

    const staffOnly = Boolean(entry?.staffOnly);
    const hasOrderContext = triggerProvidesOrderContext(triggerConfig, entry);
    const allowedTemplateFieldKeys = new Set<string>(triggerFields.map((f) => f.key));
    if (!entry) {
      allowedTemplateFieldKeys.add("recipient_name");
      if (hasOrderContext) {
        allowedTemplateFieldKeys.add("order_public_id");
        allowedTemplateFieldKeys.add("order_reference");
        allowedTemplateFieldKeys.add("order_status_label");
        allowedTemplateFieldKeys.add("order_link");
      }
    }
    const allowedRecipientKeys = new Set<string>(
      entry
        ? entry.recipients.map((r) => r.key)
        : hasOrderContext
          ? ["administrators", "staff", "order_owner"]
          : ["administrators", "staff"],
    );

    const seenStepKeys = new Set<string>();
    const persistedActions: PersistedActionStep[] = [];
    const secretMutations: Array<{
      stepKey: string;
      fieldKey: string;
      op: "set" | "clear";
      value?: string;
    }> = [];

    for (const rawStep of input.actions) {
      if (!STEP_KEY_RE.test(rawStep.stepKey)) {
        throw validation("AUTOMATION_INVALID_STEP_KEY", "Action step key format is invalid.");
      }
      if (seenStepKeys.has(rawStep.stepKey)) {
        throw validation("AUTOMATION_DUPLICATE_STEP_KEY", "Duplicate action step key.");
      }
      seenStepKeys.add(rawStep.stepKey);

      const actionDef = actionMap.get(rawStep.actionKey);
      if (!actionDef) {
        throw validation(
          "AUTOMATION_UNKNOWN_ACTION",
          `Action '${rawStep.actionKey}' is not registered.`,
        );
      }

      const supportedModes = actionDef.supportedTriggerModes ?? ["event", "manual", "schedule"];
      if (!supportedModes.includes(triggerMode)) {
        throw validation(
          "AUTOMATION_UNSUPPORTED_TRIGGER_MODE",
          `Action '${actionDef.label}' cannot run from a ${triggerMode} trigger.`,
        );
      }

      if (actionDef.requiresOrderContext && !hasOrderContext) {
        throw validation(
          "AUTOMATION_ORDER_CONTEXT_REQUIRED",
          `Action '${actionDef.label}' requires a trigger with order context.`,
        );
      }

      // J-A01: Explicit default-deny allowlist + explicit forbid flag on staff-only triggers.
      if (
        staffOnly &&
        (!STAFF_ONLY_ALLOWED_ACTION_KEYS.has(actionDef.key) || actionDef.forbidOnStaffOnlyTrigger)
      ) {
        throw validation(
          "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
          `Action '${actionDef.label}' is forbidden on staff-only triggers.`,
        );
      }

      const cfgParsed = actionDef.configSchema.safeParse(rawStep.config);
      if (!cfgParsed.success) {
        const firstMsg = cfgParsed.error.issues[0]?.message ?? "Action configuration is invalid.";
        throw validation("AUTOMATION_INVALID_ACTION_CONFIG", firstMsg);
      }
      const cleanConfig = cfgParsed.data as Record<string, unknown>;

      if (
        typeof cleanConfig.recipientKey === "string" &&
        cleanConfig.recipientMode !== "fixed" &&
        !allowedRecipientKeys.has(cleanConfig.recipientKey)
      ) {
        throw validation(
          "AUTOMATION_RECIPIENT_NOT_IN_TRIGGER",
          `Recipient '${cleanConfig.recipientKey}' is not available on this trigger.`,
        );
      }

      if (
        staffOnly &&
        typeof cleanConfig.recipientKey === "string" &&
        CUSTOMER_RECIPIENT_KEYS.has(cleanConfig.recipientKey)
      ) {
        throw validation(
          "AUTOMATION_STAFF_ONLY_CUSTOMER_RECIPIENT_FORBIDDEN",
          "Staff-only triggers cannot address customer recipients.",
        );
      }

      validateBuiltInActionTemplates(
        actionDef.key,
        cleanConfig,
        allowedTemplateFieldKeys,
        staffOnly,
      );

      if (actionDef.secretsSchema) {
        const providedSecrets = rawStep.secrets ?? {};
        const existingForStep = new Set(
          input.existingSecretFieldsByStep?.get(rawStep.stepKey) ?? [],
        );
        const toValidate: Record<string, string> = {};
        let hasNewValues = false;

        for (const [fKey, fVal] of Object.entries(providedSecrets)) {
          if (fVal === null) {
            existingForStep.delete(fKey);
            secretMutations.push({ stepKey: rawStep.stepKey, fieldKey: fKey, op: "clear" });
          } else if (typeof fVal === "string" && fVal.length > 0) {
            toValidate[fKey] = fVal;
            hasNewValues = true;
          }
        }

        if (hasNewValues) {
          const secParsed = actionDef.secretsSchema.safeParse(toValidate);
          if (!secParsed.success) {
            throw validation(
              "AUTOMATION_INVALID_SECRET",
              "Secret value does not meet length or format requirements.",
            );
          }
          for (const [fKey, fVal] of Object.entries(secParsed.data)) {
            existingForStep.add(fKey);
            secretMutations.push({
              stepKey: rawStep.stepKey,
              fieldKey: fKey,
              op: "set",
              value: fVal,
            });
          }
        }

        for (const fieldMeta of actionDef.configFields) {
          if ((fieldMeta.type === "secret" || fieldMeta.secret) && fieldMeta.required) {
            if (!existingForStep.has(fieldMeta.key)) {
              throw validation(
                "AUTOMATION_SECRET_REQUIRED",
                `Secret '${fieldMeta.label}' is required for '${actionDef.label}'.`,
              );
            }
          }
        }
      } else if (rawStep.secrets && Object.keys(rawStep.secrets).length > 0) {
        throw validation(
          "AUTOMATION_UNEXPECTED_SECRET",
          `Action '${actionDef.label}' does not accept secrets.`,
        );
      }

      const label = rawStep.label ? rawStep.label.normalize("NFC").trim().slice(0, 80) : null;
      persistedActions.push({
        stepKey: rawStep.stepKey,
        actionKey: actionDef.key,
        label: label && label.length > 0 ? label : null,
        config: cleanConfig,
      });
    }

    return {
      normalizedName,
      normalizedDescription,
      maxRunsPerHour,
      triggerMode,
      triggerKey,
      triggerEventName,
      scheduleEveryMinutes,
      manualRequireOrder,
      triggerConfig,
      conditions,
      persistedActions,
      secretMutations,
    };
  }

  function sanitizeCanvasLayout(
    layout: AutomationCanvasLayout | null | undefined,
  ): AutomationCanvasLayout | null {
    if (!layout || typeof layout !== "object" || !layout.positions) return null;
    const positions: Record<string, { x: number; y: number }> = {};
    let countNodes = 0;
    for (const [nodeId, coords] of Object.entries(layout.positions)) {
      if (countNodes >= 32) break;
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(nodeId)) continue;
      if (
        coords &&
        typeof coords.x === "number" &&
        typeof coords.y === "number" &&
        Number.isFinite(coords.x) &&
        Number.isFinite(coords.y)
      ) {
        positions[nodeId] = {
          x: Math.max(-10_000, Math.min(10_000, Math.round(coords.x))),
          y: Math.max(-10_000, Math.min(10_000, Math.round(coords.y))),
        };
        countNodes += 1;
      }
    }
    return { positions };
  }

  async function assertScheduleQuotaInTx(
    tx: Tx,
    enablingAutomationId?: number,
  ): Promise<void> {
    const rows = await tx
      .select({ id: automations.id })
      .from(automations)
      .where(and(eq(automations.enabled, true), eq(automations.triggerMode, "schedule")));
    const otherActiveCount = rows.filter((r) => r.id !== enablingAutomationId).length;
    if (otherActiveCount >= AUTOMATION_MAX_ACTIVE_SCHEDULES) {
      throw validation(
        "AUTOMATION_SCHEDULE_LIMIT_EXCEEDED",
        `At most ${AUTOMATION_MAX_ACTIVE_SCHEDULES} scheduled automations may be enabled at the same time.`,
      );
    }
  }

  /* --------------------------------------------------- View builders */

  function rowToTriggerConfig(row: typeof automations.$inferSelect): AutomationTriggerConfig {
    if (row.triggerMode === "event") {
      return { kind: "event", triggerKey: row.triggerKey ?? "" };
    }
    if (row.triggerMode === "schedule") {
      return { kind: "schedule", everyMinutes: row.scheduleEveryMinutes ?? 60 };
    }
    return { kind: "manual", requireOrderPublicId: row.manualRequireOrder };
  }

  function buildSecretStatusMap(
    persistedSteps: readonly PersistedActionStep[],
    secretRows: ReadonlyArray<{ stepKey: string; fieldKey: string; last4: string }>,
  ): Map<string, Record<string, { configured: boolean; last4: string | null }>> {
    const byStep = new Map<
      string,
      Record<string, { configured: boolean; last4: string | null }>
    >();
    for (const step of persistedSteps) {
      const def = actionMap.get(step.actionKey);
      const statusObj: Record<string, { configured: boolean; last4: string | null }> = {};
      for (const field of def?.configFields ?? []) {
        if (field.type === "secret" || field.secret) {
          statusObj[field.key] = { configured: false, last4: null };
        }
      }
      byStep.set(step.stepKey, statusObj);
    }
    for (const row of secretRows) {
      const existing = byStep.get(row.stepKey) ?? {};
      existing[row.fieldKey] = { configured: true, last4: row.last4 || null };
      byStep.set(row.stepKey, existing);
    }
    return byStep;
  }

  async function loadLastRunMap(
    handle: Tx | typeof db,
    lastRunIds: readonly number[],
  ): Promise<Map<number, AutomationSummaryView["lastRun"]>> {
    const result = new Map<number, AutomationSummaryView["lastRun"]>();
    const unique = [...new Set(lastRunIds.filter((n) => n > 0))];
    if (unique.length === 0) return result;
    const rows = await handle
      .select({
        id: automationRuns.id,
        publicId: automationRuns.publicId,
        state: automationRuns.state,
        triggerMode: automationRuns.triggerMode,
        startedAt: automationRuns.startedAt,
        finishedAt: automationRuns.finishedAt,
        createdAt: automationRuns.createdAt,
      })
      .from(automationRuns)
      .where(inArray(automationRuns.id, unique));
    for (const r of rows) {
      result.set(r.id, {
        publicId: r.publicId,
        state: r.state,
        triggerMode: r.triggerMode,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        createdAt: r.createdAt,
      });
    }
    return result;
  }

  function rowToSummaryView(
    row: typeof automations.$inferSelect,
    lastRunMap: ReadonlyMap<number, AutomationSummaryView["lastRun"]>,
  ): AutomationSummaryView {
    const conditions = parseJsonSafe<AutomationConditionTree>(
      row.conditionsJson,
      EMPTY_CONDITION_TREE,
    );
    const actions = parseJsonSafe<PersistedActionStep[]>(row.actionsJson, []);
    return {
      publicId: row.publicId,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      sortOrder: row.sortOrder ?? 0,
      version: row.version,
      trigger: rowToTriggerConfig(row),
      conditionGroupCount: conditions.groups.length,
      actionCount: actions.length,
      maxRunsPerHour: row.maxRunsPerHour,
      lastRun: row.lastRunId ? (lastRunMap.get(row.lastRunId) ?? null) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function buildDetailView(
    handle: Tx | typeof db,
    row: typeof automations.$inferSelect,
  ): Promise<AutomationDetailView> {
    const conditions = parseJsonSafe<AutomationConditionTree>(
      row.conditionsJson,
      EMPTY_CONDITION_TREE,
    );
    const persistedActions = parseJsonSafe<PersistedActionStep[]>(row.actionsJson, []);
    const canvasLayout = parseJsonSafe<AutomationCanvasLayout | null>(row.canvasLayoutJson, null);

    const secretRows = await handle
      .select({
        stepKey: automationSecrets.stepKey,
        fieldKey: automationSecrets.fieldKey,
        last4: automationSecrets.last4,
      })
      .from(automationSecrets)
      .where(eq(automationSecrets.automationId, row.id));

    const statusByStep = buildSecretStatusMap(persistedActions, secretRows);
    const actions: AutomationActionStepView[] = persistedActions.map((step) => ({
      stepKey: step.stepKey,
      actionKey: step.actionKey,
      label: step.label,
      config: step.config,
      secretStatus: statusByStep.get(step.stepKey) ?? {},
    }));

    const lastRunMap = await loadLastRunMap(handle, row.lastRunId ? [row.lastRunId] : []);
    const summary = rowToSummaryView(row, lastRunMap);

    return {
      ...summary,
      conditions,
      actions,
      canvasLayout,
    };
  }

  /* --------------------------------------------------- Context resolution */

  async function resolveFullTriggerContext(input: {
    triggerMode: AutomationTriggerMode;
    triggerKey: string | null;
    snapshot: TransientRunSnapshot;
    signal: AbortSignal;
  }): Promise<{
    fields: Record<string, AutomationScalarValue>;
    recipients: Record<string, readonly number[]>;
    orderPublicId: string | null;
    filePublicId: string | null;
    staffOnlyTrigger: boolean;
  }> {
    const fields: Record<string, AutomationScalarValue> = {};
    const recipients: Record<string, readonly number[]> = {};
    let orderPublicId: string | null = input.snapshot.orderPublicId ?? null;
    let filePublicId: string | null = input.snapshot.filePublicId ?? null;
    let staffOnlyTrigger = false;

    if (input.triggerMode === "event" && input.triggerKey) {
      const entry = findTriggerEntry(input.triggerKey);
      staffOnlyTrigger = Boolean(entry?.staffOnly);
      const allowedFieldSet = new Set((entry?.fields ?? []).map((f) => f.key));
      const event = input.snapshot.event ?? null;

      if (event && entry) {
        for (const f of entry.fields) {
          if (f.from === "event" && !f.personal) {
            const val = eventFieldValue(event, f.key);
            if (val !== undefined) fields[f.key] = val;
          }
        }
        if (event.actor.userId && Number.isSafeInteger(event.actor.userId)) {
          recipients.actor = [event.actor.userId];
        }
        if (!orderPublicId && event.resource?.type === "order" && event.resource.publicId) {
          orderPublicId = event.resource.publicId;
        }
        if (!filePublicId && event.resource?.type === "file" && event.resource.publicId) {
          filePublicId = event.resource.publicId;
        }
      }

      const reg = triggerMap.get(input.triggerKey);
      if (event && reg?.resolveContext) {
        const resolved = await reg.resolveContext({
          triggerKey: input.triggerKey,
          event,
          db,
          services: deps.services,
          signal: input.signal,
        });
        if (resolved.fields) {
          for (const [k, v] of Object.entries(resolved.fields)) {
            if (k === "recipient_name") continue;
            if (allowedFieldSet.size === 0 || allowedFieldSet.has(k)) {
              fields[k] = v;
            }
          }
        }
        if (resolved.recipients) {
          for (const [rk, ids] of Object.entries(resolved.recipients)) {
            if (staffOnlyTrigger && CUSTOMER_RECIPIENT_KEYS.has(rk)) continue;
            recipients[rk] = ids;
          }
        }
        if (resolved.orderPublicId) {
          orderPublicId = resolved.orderPublicId;
        }
        if (resolved.filePublicId) {
          filePublicId = resolved.filePublicId;
        }
      }
    }

    if (input.snapshot.sampleFields) {
      for (const [k, v] of Object.entries(input.snapshot.sampleFields)) {
        if (k === "recipient_name") continue;
        fields[k] = v;
      }
    }

    if (input.snapshot.actorUserId && !recipients.actor) {
      recipients.actor = [input.snapshot.actorUserId];
    }

    if (
      orderPublicId &&
      ULID_PATTERN.test(orderPublicId) &&
      (!fields.order_reference || (!staffOnlyTrigger && !recipients.order_owner))
    ) {
      const orderRef = await deps.services.orders?.getOrderRefByPublicId?.(orderPublicId, db);
      if (orderRef) {
        if (fields.order_public_id === undefined) {
          fields.order_public_id = orderRef.publicId;
        }
        if (fields.order_reference === undefined) {
          fields.order_reference = orderRef.reference;
        }
        if (fields.order_status_label === undefined) {
          fields.order_status_label = orderRef.statusKey;
        }
        if (fields.order_link === undefined) {
          fields.order_link = new URL(
            `/orders/${orderRef.publicId}`,
            deps.config.canonicalOrigin,
          ).href;
        }
        if (!staffOnlyTrigger && !recipients.order_owner) {
          recipients.order_owner = [orderRef.ownerUserId];
        }
        if (!recipients.order_assignee) {
          recipients.order_assignee = [];
        }
      }
    }

    if (
      !orderPublicId &&
      typeof fields.order_public_id === "string" &&
      ULID_PATTERN.test(fields.order_public_id)
    ) {
      orderPublicId = fields.order_public_id;
    }
    if (
      !filePublicId &&
      typeof fields.file_public_id === "string" &&
      ULID_PATTERN.test(fields.file_public_id)
    ) {
      filePublicId = fields.file_public_id;
    }

    return {
      fields,
      recipients,
      orderPublicId,
      filePublicId,
      staffOnlyTrigger,
    };
  }

  /* --------------------------------------------------- Enqueue run helper */

  function encryptRunSnapshot(runPublicId: string, snapshot: TransientRunSnapshot): string {
    return crypto.encrypt(
      JSON.stringify(snapshot),
      `automation_runs.context_snapshot:${runPublicId}`,
    );
  }

  function decryptRunSnapshot(runPublicId: string, enc: string | null): TransientRunSnapshot {
    if (!enc) return {};
    const raw = crypto.decrypt(enc, `automation_runs.context_snapshot:${runPublicId}`);
    return JSON.parse(raw) as TransientRunSnapshot;
  }

  async function createQueuedRunInTx(
    tx: Tx,
    params: {
      automationRow: typeof automations.$inferSelect;
      versionRow: typeof automationVersions.$inferSelect;
      triggerMode: AutomationTriggerMode;
      triggerKey: string | null;
      triggerEventId: string | null;
      orderPublicId?: string | null;
      stageStepKey?: string | null;
      triggeredByUserId?: number | null;
      dedupKey: string;
      isTest: boolean;
      snapshot: TransientRunSnapshot;
    },
  ): Promise<{ created: boolean; runPublicId: string; jobId: string }> {
    const [existing] = await tx
      .select({ publicId: automationRuns.publicId, jobPublicId: automationRuns.jobPublicId })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, params.automationRow.id),
          eq(automationRuns.dedupKey, params.dedupKey),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        created: false,
        runPublicId: existing.publicId,
        jobId: existing.jobPublicId ?? "",
      };
    }

    const now = clock.now();
    const runPublicId = ulid(now.getTime());
    const correlationId = automationCorrelationId(runPublicId);
    const contextSnapshotEnc = encryptRunSnapshot(runPublicId, params.snapshot);
    const persistedActions = parseJsonSafe<PersistedActionStep[]>(
      params.versionRow.actionsJson,
      [],
    );

    const resolvedOrderPublicId =
      params.orderPublicId !== undefined
        ? params.orderPublicId
        : params.snapshot.orderPublicId && ULID_PATTERN.test(params.snapshot.orderPublicId)
          ? params.snapshot.orderPublicId
          : null;

    let runId: number;
    try {
      const [ins] = await tx.insert(automationRuns).values({
        publicId: runPublicId,
        automationId: params.automationRow.id,
        automationPublicId: params.automationRow.publicId,
        automationName: params.automationRow.name,
        automationVersion: params.versionRow.version,
        triggerMode: params.triggerMode,
        triggerKey: params.triggerKey,
        triggerEventId: params.triggerEventId,
        orderPublicId: resolvedOrderPublicId,
        stageStepKey: params.stageStepKey ?? null,
        triggeredByUserId: params.triggeredByUserId ?? null,
        dedupKey: params.dedupKey,
        correlationId,
        isTest: params.isTest,
        state: "queued",
        reasonCode: null,
        evaluatedFieldsJson: "{}",
        contextSnapshotEnc,
        jobPublicId: null,
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now,
      });
      runId = Number(ins.insertId);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const [dup] = await tx
          .select({ publicId: automationRuns.publicId, jobPublicId: automationRuns.jobPublicId })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.automationId, params.automationRow.id),
              eq(automationRuns.dedupKey, params.dedupKey),
            ),
          )
          .limit(1);
        return {
          created: false,
          runPublicId: dup?.publicId ?? runPublicId,
          jobId: dup?.jobPublicId ?? "",
        };
      }
      throw err;
    }

    const stepValues = persistedActions.map((step, idx) => ({
      publicId: ulid(now.getTime() + idx + 1),
      runId,
      stepIndex: idx,
      stepKey: step.stepKey,
      actionKey: step.actionKey,
      state: "pending" as const,
      attemptCount: 0,
      reasonCode: null,
      safeSummary: null,
      safeCountsJson: null,
      externalRef: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
    }));

    if (stepValues.length > 0) {
      await tx.insert(automationRunSteps).values(stepValues);
    }

    const { jobId } = await jobs.enqueue<ExecuteRunJobPayload>(
      JOB_EXECUTE_RUN,
      { runPublicId },
      {
        idempotencyKey: `auto:exec:${runPublicId}`,
        correlationId,
        maxAttempts: 3,
      },
      tx,
    );

    await tx
      .update(automationRuns)
      .set({ jobPublicId: jobId })
      .where(eq(automationRuns.id, runId));

    return { created: true, runPublicId, jobId };
  }

  /* --------------------------------------------------- Worker job handlers */

  async function handleEvaluateEventJob(
    job: ClaimedJob<EvaluateEventJobPayload>,
  ): Promise<JobResult> {
    job.signal.throwIfAborted();
    const { event } = job.payload;

    // Loop protection at worker entry boundary (defense-in-depth alongside AuditTap).
    if (isAutomationOrigin(job.correlationId) || isAutomationOrigin(event.correlationId)) {
      return { outcome: "completed", safeCounts: { suppressed_loop: 1 } };
    }

    const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);
    if (!cfg.enabled) {
      return { outcome: "completed", safeCounts: { matched: 0 } };
    }

    const matchedEntries = entriesMatchingTapEvent(event);
    if (matchedEntries.length === 0) {
      return { outcome: "completed", safeCounts: { matched: 0 } };
    }

    const entryByKey = new Map(matchedEntries.map((e) => [e.key, e]));
    const candidateRows = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.enabled, true),
          eq(automations.triggerMode, "event"),
          inArray(automations.triggerKey, [...entryByKey.keys()]),
        ),
      )
      .orderBy(asc(automations.sortOrder), asc(automations.id));

    if (candidateRows.length === 0) {
      return { outcome: "completed", safeCounts: { matched: 0 } };
    }

    const attrOrderPublicId =
      typeof event.attributes.order_public_id === "string" &&
      ULID_PATTERN.test(event.attributes.order_public_id)
        ? event.attributes.order_public_id
        : null;
    const inferredOrderPublicId =
      event.resource?.type === "order" &&
      typeof event.resource.publicId === "string" &&
      ULID_PATTERN.test(event.resource.publicId)
        ? event.resource.publicId
        : attrOrderPublicId;

    let queuedRuns = 0;
    for (const autoRow of candidateRows) {
      job.signal.throwIfAborted();
      const entry = autoRow.triggerKey ? entryByKey.get(autoRow.triggerKey) : undefined;
      if (!entry) continue;

      await db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        const [verRow] = await tx
          .select()
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.automationId, autoRow.id),
              eq(automationVersions.version, autoRow.version),
            ),
          )
          .limit(1);
        if (!verRow) return;

        const snapshot: TransientRunSnapshot = {
          event,
          parentCorrelationId: event.correlationId,
          orderPublicId: inferredOrderPublicId,
          filePublicId: event.resource?.type === "file" ? event.resource.publicId : null,
        };

        const res = await createQueuedRunInTx(tx, {
          automationRow: autoRow,
          versionRow: verRow,
          triggerMode: "event",
          triggerKey: entry.key,
          triggerEventId: event.eventId,
          orderPublicId: inferredOrderPublicId,
          dedupKey: `event:${event.eventId}`,
          isTest: false,
          snapshot,
        });
        if (res.created) queuedRuns += 1;
      });
    }

    return { outcome: "completed", safeCounts: { queued_runs: queuedRuns } };
  }

  async function checkRateLimitsAndStartRunInTx(
    tx: Tx,
    autoRow: typeof automations.$inferSelect,
    runRow: typeof automationRuns.$inferSelect,
    evaluatedFieldsJson: string,
    cfg: AutomationSettingsView,
  ): Promise<{ allowed: true } | { allowed: false; reasonCode: string }> {
    await tx
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.id, autoRow.id))
      .for("update");

    const now = clock.now();
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const oneHourAgo = new Date(now.getTime() - 3_600_000);

    const [globalRow] = await tx
      .select({ total: count(automationRuns.id) })
      .from(automationRuns)
      .where(and(isNotNull(automationRuns.startedAt), gte(automationRuns.startedAt, oneMinuteAgo)));
    if (Number(globalRow?.total ?? 0) >= cfg.globalRunsPerMinute) {
      return { allowed: false, reasonCode: "AUTOMATION_GLOBAL_RATE_LIMITED" };
    }

    const hourlyCap = Math.min(autoRow.maxRunsPerHour, cfg.maxPerAutomationRunsPerHour);
    const [perAutoRow] = await tx
      .select({ total: count(automationRuns.id) })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, autoRow.id),
          isNotNull(automationRuns.startedAt),
          gte(automationRuns.startedAt, oneHourAgo),
        ),
      );
    if (Number(perAutoRow?.total ?? 0) >= hourlyCap) {
      return { allowed: false, reasonCode: "AUTOMATION_RATE_LIMITED" };
    }

    await tx
      .update(automationRuns)
      .set({
        state: "running",
        evaluatedFieldsJson,
        startedAt: runRow.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(automationRuns.id, runRow.id));

    return { allowed: true };
  }

  async function finalizeRunInTx(
    tx: Tx,
    autoRow: typeof automations.$inferSelect | null,
    runRow: typeof automationRuns.$inferSelect,
    finalState: AutomationRunState,
    reasonCode: string | null,
    evaluatedFieldsJson?: string,
    parentCorrelationId?: string | null,
  ): Promise<void> {
    const now = clock.now();
    const started = runRow.startedAt ?? now;
    const durationMs = Math.max(0, now.getTime() - started.getTime());

    await tx
      .update(automationRuns)
      .set({
        state: finalState,
        reasonCode,
        ...(evaluatedFieldsJson !== undefined ? { evaluatedFieldsJson } : {}),
        contextSnapshotEnc: null,
        finishedAt: now,
        durationMs,
        updatedAt: now,
      })
      .where(eq(automationRuns.id, runRow.id));

    if (autoRow) {
      await tx
        .update(automations)
        .set({
          lastRunId: runRow.id,
          updatedAt: now,
        })
        .where(eq(automations.id, autoRow.id));
    }

    if (
      finalState === "completed" ||
      finalState === "failed" ||
      finalState === "partial_unknown" ||
      finalState === "rate_limited"
    ) {
      const eventName =
        finalState === "completed"
          ? "automation.run.completed"
          : finalState === "rate_limited"
            ? "automation.run.rate_limited"
            : finalState === "partial_unknown"
              ? "automation.run.unknown"
              : "automation.run.failed";
      const outcome =
        finalState === "completed"
          ? "completed"
          : finalState === "rate_limited"
            ? "refused"
            : finalState === "partial_unknown"
              ? "unknown"
              : "failed";
      await audit.record(
        {
          category: "system",
          eventName,
          action: "execute",
          outcome,
          severity:
            finalState === "failed" || finalState === "partial_unknown" ? "WARN" : "INFO",
          ...(reasonCode ? { reasonCode } : {}),
          actor: { role: "system" },
          resource: {
            type: "automation",
            publicId: autoRow?.publicId ?? runRow.automationPublicId,
          },
          correlationId: runRow.correlationId,
          ...(parentCorrelationId ? { parentCorrelationId } : {}),
          durationMs,
          attributes: {
            run_public_id: runRow.publicId,
            trigger_mode: runRow.triggerMode,
            automation_version: runRow.automationVersion,
          },
        },
        tx,
      );

      if (
        !runRow.isTest &&
        (finalState === "failed" || finalState === "partial_unknown") &&
        deps.services.opsAlerts?.emit
      ) {
        await deps.services.opsAlerts.emit(
          {
            source: "automation",
            severity: "error",
            dedupKey: `automation_run_fail:${runRow.publicId}`,
            correlationId: runRow.correlationId,
            code:
              finalState === "partial_unknown"
                ? "AUTOMATION_RUN_AMBIGUOUS"
                : "AUTOMATION_RUN_FAILED",
            title: sanitizeOpsAlertCopy(
              `Automation "${autoRow?.name ?? runRow.automationName}" ${finalState === "partial_unknown" ? "ended with unknown outcome" : "failed"}`,
              120,
            ),
            text: sanitizeOpsAlertCopy(
              `Automation run ${runRow.publicId} finished in state ${finalState}${reasonCode ? ` (${reasonCode})` : ""}.`,
              500,
            ),
            ...(runRow.orderPublicId && ULID_PATTERN.test(runRow.orderPublicId)
              ? { orderPublicId: runRow.orderPublicId }
              : {}),
            runPublicId: runRow.publicId,
          },
          tx,
        );
      }
    }
  }

  async function handleExecuteRunJob(
    job: ClaimedJob<ExecuteRunJobPayload>,
  ): Promise<JobResult> {
    job.signal.throwIfAborted();
    const { runPublicId } = job.payload;

    const [runRow] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.publicId, runPublicId))
      .limit(1);
    if (!runRow) {
      return { outcome: "completed", safeCounts: { missing_run: 1 } };
    }

    if (
      runRow.state === "completed" ||
      runRow.state === "skipped_conditions" ||
      runRow.state === "rate_limited" ||
      runRow.state === "failed" ||
      runRow.state === "partial_unknown" ||
      runRow.state === "canceled"
    ) {
      return { outcome: "completed", safeCounts: { already_terminal: 1 } };
    }

    const snapshot = decryptRunSnapshot(runRow.publicId, runRow.contextSnapshotEnc);
    const runCorrelationId = runRow.correlationId.startsWith(AUTOMATION_ORIGIN_PREFIX)
      ? runRow.correlationId
      : automationCorrelationId(runRow.publicId);

    return runWithRequestContext(
      newRequestContext("worker", {
        correlationId: runCorrelationId,
        ...(snapshot.parentCorrelationId
          ? { parentCorrelationId: snapshot.parentCorrelationId }
          : {}),
      }),
      async (): Promise<JobResult> => {
        const [autoRow] = await db
          .select()
          .from(automations)
          .where(eq(automations.id, runRow.automationId))
          .limit(1);
        const [verRow] = await db
          .select()
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.automationId, runRow.automationId),
              eq(automationVersions.version, runRow.automationVersion),
            ),
          )
          .limit(1);
        if (!autoRow || !verRow) {
          return { outcome: "completed" };
        }

        const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);
        if (!cfg.enabled || (!autoRow.enabled && !runRow.isTest)) {
          await db.transaction(async (tx) => {
            await job.assertStillOwned(tx);
            await tx
              .update(automationRunSteps)
              .set({
                state: "skipped",
                reasonCode: "AUTOMATION_DISABLED",
                updatedAt: clock.now(),
              })
              .where(
                and(
                  eq(automationRunSteps.runId, runRow.id),
                  eq(automationRunSteps.state, "pending"),
                ),
              );
            await finalizeRunInTx(
              tx,
              autoRow,
              runRow,
              "canceled",
              "AUTOMATION_DISABLED",
              undefined,
              snapshot.parentCorrelationId,
            );
          });
          return { outcome: "completed" };
        }

        const resolvedCtx = await resolveFullTriggerContext({
          triggerMode: runRow.triggerMode,
          triggerKey: runRow.triggerKey,
          snapshot,
          signal: job.signal,
        });
        const evaluatedFieldsJson = JSON.stringify(resolvedCtx.fields);
        const conditionsTree = parseJsonSafe<AutomationConditionTree>(
          verRow.conditionsJson,
          EMPTY_CONDITION_TREE,
        );

        if (runRow.state === "queued") {
          const condEval = evaluateConditionTree(conditionsTree, resolvedCtx.fields);
          if (!condEval.matched) {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              await tx
                .update(automationRunSteps)
                .set({
                  state: "skipped",
                  reasonCode: "CONDITIONS_NOT_MET",
                  updatedAt: clock.now(),
                })
                .where(eq(automationRunSteps.runId, runRow.id));
              await finalizeRunInTx(
                tx,
                autoRow,
                runRow,
                "skipped_conditions",
                "CONDITIONS_NOT_MET",
                evaluatedFieldsJson,
                snapshot.parentCorrelationId,
              );
            });
            return { outcome: "completed", safeCounts: { skipped_conditions: 1 } };
          }

          const rateDecision = await db.transaction(async (tx) => {
            await job.assertStillOwned(tx);
            const decision = await checkRateLimitsAndStartRunInTx(
              tx,
              autoRow,
              runRow,
              evaluatedFieldsJson,
              cfg,
            );
            if (!decision.allowed) {
              await tx
                .update(automationRunSteps)
                .set({
                  state: "skipped",
                  reasonCode: decision.reasonCode,
                  updatedAt: clock.now(),
                })
                .where(eq(automationRunSteps.runId, runRow.id));
              await finalizeRunInTx(
                tx,
                autoRow,
                runRow,
                "rate_limited",
                decision.reasonCode,
                evaluatedFieldsJson,
                snapshot.parentCorrelationId,
              );
            }
            return decision;
          });

          if (!rateDecision.allowed) {
            return { outcome: "completed", safeCounts: { rate_limited: 1 } };
          }
        }

        const stepRows = await db
          .select()
          .from(automationRunSteps)
          .where(eq(automationRunSteps.runId, runRow.id))
          .orderBy(asc(automationRunSteps.stepIndex));

        const secretRows = await db
          .select()
          .from(automationSecrets)
          .where(eq(automationSecrets.automationId, autoRow.id));
        const secretsByStep = new Map<string, Record<string, string>>();
        for (const sRow of secretRows) {
          const map = secretsByStep.get(sRow.stepKey) ?? {};
          map[sRow.fieldKey] = crypto.decrypt(
            sRow.secretEnc,
            `automation_secrets.secret_enc:${sRow.publicId}`,
          );
          secretsByStep.set(sRow.stepKey, map);
        }

        const persistedActions = parseJsonSafe<PersistedActionStep[]>(verRow.actionsJson, []);
        const persistedByStepKey = new Map(persistedActions.map((a) => [a.stepKey, a]));

        for (const stepRow of stepRows) {
          job.signal.throwIfAborted();
          if (stepRow.state === "completed" || stepRow.state === "skipped") {
            continue;
          }

          const persistedStep = persistedByStepKey.get(stepRow.stepKey);
          if (
            isProhibitedActionKey(stepRow.actionKey) ||
            (persistedStep ? isProhibitedActionKey(persistedStep.actionKey) : false)
          ) {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              const now = clock.now();
              await tx
                .update(automationRunSteps)
                .set({
                  state: "failed",
                  reasonCode: "ACTION_PROHIBITED",
                  safeSummary:
                    "Prohibited action blocked: automations cannot change order status or permissions.",
                  finishedAt: now,
                  updatedAt: now,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
              await tx
                .update(automationRunSteps)
                .set({ state: "skipped", reasonCode: "PRIOR_STEP_FAILED", updatedAt: now })
                .where(
                  and(
                    eq(automationRunSteps.runId, runRow.id),
                    eq(automationRunSteps.state, "pending"),
                  ),
                );
              await finalizeRunInTx(
                tx,
                autoRow,
                runRow,
                "failed",
                "ACTION_PROHIBITED",
                evaluatedFieldsJson,
                snapshot.parentCorrelationId,
              );
            });
            return { outcome: "completed" };
          }

          const actionDef = actionMap.get(stepRow.actionKey);
          if (!persistedStep || !actionDef) {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              const now = clock.now();
              await tx
                .update(automationRunSteps)
                .set({
                  state: "failed",
                  reasonCode: "ACTION_NOT_REGISTERED",
                  safeSummary: "Action is no longer registered.",
                  finishedAt: now,
                  updatedAt: now,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
              await tx
                .update(automationRunSteps)
                .set({ state: "skipped", reasonCode: "PRIOR_STEP_FAILED", updatedAt: now })
                .where(
                  and(
                    eq(automationRunSteps.runId, runRow.id),
                    eq(automationRunSteps.state, "pending"),
                  ),
                );
              await finalizeRunInTx(
                tx,
                autoRow,
                runRow,
                "failed",
                "ACTION_NOT_REGISTERED",
                evaluatedFieldsJson,
                snapshot.parentCorrelationId,
              );
            });
            return { outcome: "completed" };
          }

          // Lease-loss protection (`retrySafe: false`, e.g. `webhook.call`): never dispatch twice!
          if (stepRow.state === "dispatching" && !actionDef.retrySafe) {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              const now = clock.now();
              await tx
                .update(automationRunSteps)
                .set({
                  state: "unknown",
                  reasonCode: "WEBHOOK_LEASE_LOST_IN_FLIGHT",
                  safeSummary:
                    "Worker lease expired after dispatch started; step marked unknown without retrying.",
                  finishedAt: now,
                  updatedAt: now,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
              await tx
                .update(automationRunSteps)
                .set({ state: "skipped", reasonCode: "PRIOR_STEP_UNKNOWN", updatedAt: now })
                .where(
                  and(
                    eq(automationRunSteps.runId, runRow.id),
                    eq(automationRunSteps.state, "pending"),
                  ),
                );
              await finalizeRunInTx(
                tx,
                autoRow,
                runRow,
                "partial_unknown",
                "WEBHOOK_LEASE_LOST_IN_FLIGHT",
                evaluatedFieldsJson,
                snapshot.parentCorrelationId,
              );
            });
            return { outcome: "completed" };
          }

          // J-A01 runtime enforcement using trusted catalogue metadata (`resolvedCtx.staffOnlyTrigger`).
          if (
            resolvedCtx.staffOnlyTrigger &&
            (!STAFF_ONLY_ALLOWED_ACTION_KEYS.has(actionDef.key) ||
              actionDef.forbidOnStaffOnlyTrigger)
          ) {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              const now = clock.now();
              await tx
                .update(automationRunSteps)
                .set({
                  state: "failed",
                  reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
                  safeSummary: "Action blocked by staff-only trigger policy.",
                  finishedAt: now,
                  updatedAt: now,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
              await tx
                .update(automationRunSteps)
                .set({ state: "skipped", reasonCode: "PRIOR_STEP_FAILED", updatedAt: now })
                .where(
                  and(
                    eq(automationRunSteps.runId, runRow.id),
                    eq(automationRunSteps.state, "pending"),
                  ),
                );
              await finalizeRunInTx(
                tx,
                autoRow,
                runRow,
                "failed",
                "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
                evaluatedFieldsJson,
                snapshot.parentCorrelationId,
              );
            });
            return { outcome: "completed" };
          }

          const stepStartedAt = clock.now();
          const nextAttempt = stepRow.attemptCount + 1;
          const stepIdempotencyKey = `auto:${runRow.publicId}:step:${stepRow.stepKey}`;

          let actionResult: AutomationActionRunResult;
          try {
            const parsedConfig = actionDef.configSchema.parse(persistedStep.config);
            const rawSecrets = secretsByStep.get(stepRow.stepKey) ?? {};
            const parsedSecrets = actionDef.secretsSchema
              ? actionDef.secretsSchema.parse(rawSecrets)
              : {};

            const actionCtx: AutomationActionRunContext = {
              automationPublicId: autoRow.publicId,
              automationVersion: verRow.version,
              runPublicId: runRow.publicId,
              stepIndex: stepRow.stepIndex,
              stepKey: stepRow.stepKey,
              idempotencyKey: stepIdempotencyKey,
              correlationId: runCorrelationId,
              triggerMode: runRow.triggerMode,
              triggerKey: runRow.triggerKey,
              triggerEventId: runRow.triggerEventId,
              config: parsedConfig as Record<string, unknown>,
              secrets: parsedSecrets,
              fields: resolvedCtx.fields,
              recipients: resolvedCtx.recipients,
              orderPublicId: resolvedCtx.orderPublicId,
              filePublicId: resolvedCtx.filePublicId,
              staffOnlyTrigger: resolvedCtx.staffOnlyTrigger,
              dryRun: false,
              assertStillOwned: (tx) => job.assertStillOwned(tx),
              signal: job.signal,
              deps: {
                db,
                clock,
                logger,
                audit,
                crypto,
                settings,
                mailer: deps.mailer,
                jobs,
                services: deps.services,
              },
            };

            if (!actionDef.retrySafe) {
              attachWebhookBeforeSendFence(actionCtx, async () => {
                await db.transaction(async (tx) => {
                  await job.assertStillOwned(tx);
                  const [freshStep] = await tx
                    .select({ state: automationRunSteps.state })
                    .from(automationRunSteps)
                    .where(eq(automationRunSteps.id, stepRow.id))
                    .for("update");
                  if (!freshStep || freshStep.state !== "pending") {
                    throw conflict(
                      "STEP_ALREADY_DISPATCHED",
                      "Step was already dispatched by another worker.",
                    );
                  }
                  await tx
                    .update(automationRunSteps)
                    .set({
                      state: "dispatching",
                      attemptCount: nextAttempt,
                      startedAt: stepRow.startedAt ?? stepStartedAt,
                      updatedAt: clock.now(),
                    })
                    .where(eq(automationRunSteps.id, stepRow.id));
                });
              });
            } else {
              await db.transaction(async (tx) => {
                await job.assertStillOwned(tx);
                await tx
                  .update(automationRunSteps)
                  .set({
                    attemptCount: nextAttempt,
                    startedAt: stepRow.startedAt ?? stepStartedAt,
                    updatedAt: clock.now(),
                  })
                  .where(eq(automationRunSteps.id, stepRow.id));
              });
            }

            actionResult = await actionDef.run(actionCtx);
          } catch (err) {
            const dErr = err instanceof DomainError ? err : null;
            logger.warn("automation action threw error", {
              automationPublicId: autoRow.publicId,
              runPublicId: runRow.publicId,
              actionKey: actionDef.key,
              reasonCode: dErr?.reasonCode ?? "ACTION_EXCEPTION",
            });
            actionResult = {
              outcome: "failed",
              retryable: Boolean(
                actionDef.retrySafe &&
                  (!dErr || dErr.code === "UNAVAILABLE" || dErr.code === "RATE_LIMITED"),
              ),
              reasonCode: dErr?.reasonCode ?? "ACTION_EXCEPTION",
              safeSummary: dErr?.safeMessage ?? "Action failed with an unexpected error.",
            };
          }

          const stepFinishedAt = clock.now();
          const durationMs = Math.max(0, stepFinishedAt.getTime() - stepStartedAt.getTime());

          if (actionResult.outcome === "completed") {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              await tx
                .update(automationRunSteps)
                .set({
                  state: "completed",
                  attemptCount: nextAttempt,
                  reasonCode: null,
                  safeSummary: actionResult.safeSummary
                    ? actionResult.safeSummary.slice(0, 255)
                    : null,
                  safeCountsJson: actionResult.safeCounts
                    ? JSON.stringify(actionResult.safeCounts)
                    : null,
                  externalRef: actionResult.externalRef
                    ? actionResult.externalRef.slice(0, 120)
                    : null,
                  startedAt: stepRow.startedAt ?? stepStartedAt,
                  finishedAt: stepFinishedAt,
                  durationMs,
                  updatedAt: stepFinishedAt,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
            });
            continue;
          }

          if (actionResult.outcome === "skipped") {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              await tx
                .update(automationRunSteps)
                .set({
                  state: "skipped",
                  attemptCount: nextAttempt,
                  reasonCode: actionResult.reasonCode,
                  safeSummary: actionResult.safeSummary
                    ? actionResult.safeSummary.slice(0, 255)
                    : null,
                  startedAt: stepRow.startedAt ?? stepStartedAt,
                  finishedAt: stepFinishedAt,
                  durationMs,
                  updatedAt: stepFinishedAt,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
            });
            continue;
          }

          if (actionResult.outcome === "unknown") {
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              await tx
                .update(automationRunSteps)
                .set({
                  state: "unknown",
                  attemptCount: nextAttempt,
                  reasonCode: actionResult.reasonCode,
                  safeSummary: actionResult.safeSummary
                    ? actionResult.safeSummary.slice(0, 255)
                    : null,
                  startedAt: stepRow.startedAt ?? stepStartedAt,
                  finishedAt: stepFinishedAt,
                  durationMs,
                  updatedAt: stepFinishedAt,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
              await tx
                .update(automationRunSteps)
                .set({
                  state: "skipped",
                  reasonCode: "PRIOR_STEP_UNKNOWN",
                  updatedAt: stepFinishedAt,
                })
                .where(
                  and(
                    eq(automationRunSteps.runId, runRow.id),
                    eq(automationRunSteps.state, "pending"),
                  ),
                );
              await finalizeRunInTx(
                tx,
                autoRow,
                runRow,
                "partial_unknown",
                actionResult.reasonCode,
                evaluatedFieldsJson,
                snapshot.parentCorrelationId,
              );
            });
            return { outcome: "completed" };
          }

          if (
            actionResult.retryable &&
            actionDef.retrySafe &&
            nextAttempt < MAX_STEP_ATTEMPTS
          ) {
            const backoffMs = computeRetryBackoffMs(nextAttempt);
            const runAt = new Date(stepFinishedAt.getTime() + backoffMs);
            await db.transaction(async (tx) => {
              await job.assertStillOwned(tx);
              await tx
                .update(automationRunSteps)
                .set({
                  state: "pending",
                  attemptCount: nextAttempt,
                  reasonCode: actionResult.reasonCode,
                  safeSummary: actionResult.safeSummary
                    ? actionResult.safeSummary.slice(0, 255)
                    : null,
                  durationMs,
                  updatedAt: stepFinishedAt,
                })
                .where(eq(automationRunSteps.id, stepRow.id));
              await jobs.enqueue<ExecuteRunJobPayload>(
                JOB_EXECUTE_RUN,
                { runPublicId: runRow.publicId },
                {
                  idempotencyKey: `auto:retry:${runRow.publicId}:${stepRow.stepKey}:${nextAttempt}`,
                  runAt,
                  correlationId: runCorrelationId,
                  maxAttempts: 3,
                },
                tx,
              );
            });
            return { outcome: "completed", safeCounts: { scheduled_retry: 1 } };
          }

          await db.transaction(async (tx) => {
            await job.assertStillOwned(tx);
            await tx
              .update(automationRunSteps)
              .set({
                state: "failed",
                attemptCount: nextAttempt,
                reasonCode: actionResult.reasonCode,
                safeSummary: actionResult.safeSummary
                  ? actionResult.safeSummary.slice(0, 255)
                  : null,
                startedAt: stepRow.startedAt ?? stepStartedAt,
                finishedAt: stepFinishedAt,
                durationMs,
                updatedAt: stepFinishedAt,
              })
              .where(eq(automationRunSteps.id, stepRow.id));
            await tx
              .update(automationRunSteps)
              .set({
                state: "skipped",
                reasonCode: "PRIOR_STEP_FAILED",
                updatedAt: stepFinishedAt,
              })
              .where(
                and(
                  eq(automationRunSteps.runId, runRow.id),
                  eq(automationRunSteps.state, "pending"),
                ),
              );
            await finalizeRunInTx(
              tx,
              autoRow,
              runRow,
              "failed",
              actionResult.reasonCode,
              evaluatedFieldsJson,
              snapshot.parentCorrelationId,
            );
          });
          return { outcome: "completed" };
        }

        await db.transaction(async (tx) => {
          await job.assertStillOwned(tx);
          await finalizeRunInTx(
            tx,
            autoRow,
            runRow,
            "completed",
            null,
            evaluatedFieldsJson,
            snapshot.parentCorrelationId,
          );
        });
        return { outcome: "completed", safeCounts: { completed_runs: 1 } };
      },
    );
  }

  async function handleScheduleTickJob(job: ClaimedJob<unknown>): Promise<JobResult> {
    job.signal.throwIfAborted();
    await refreshTapCache();
    const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);
    if (!cfg.enabled) {
      return { outcome: "completed", safeCounts: { scheduled_runs: 0 } };
    }

    const now = clock.now();
    const dueRows = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.enabled, true),
          eq(automations.triggerMode, "schedule"),
          isNotNull(automations.nextScheduledAt),
          lte(automations.nextScheduledAt, now),
        ),
      )
      .orderBy(asc(automations.nextScheduledAt), asc(automations.id))
      .limit(AUTOMATION_MAX_ACTIVE_SCHEDULES);

    let enqueued = 0;
    for (const autoRow of dueRows) {
      job.signal.throwIfAborted();
      const intervalMin = Math.max(
        AUTOMATION_MIN_SCHEDULE_MINUTES,
        autoRow.scheduleEveryMinutes ?? 60,
      );
      await db.transaction(async (tx) => {
        await job.assertStillOwned(tx);
        const [locked] = await tx
          .select()
          .from(automations)
          .where(eq(automations.id, autoRow.id))
          .for("update");
        if (
          !locked ||
          !locked.enabled ||
          locked.triggerMode !== "schedule" ||
          !locked.nextScheduledAt ||
          locked.nextScheduledAt.getTime() > now.getTime()
        ) {
          return;
        }

        const slotMinute = Math.floor(locked.nextScheduledAt.getTime() / 60_000);
        const nextDue = new Date(now.getTime() + intervalMin * 60_000);
        await tx
          .update(automations)
          .set({ nextScheduledAt: nextDue, updatedAt: now })
          .where(eq(automations.id, locked.id));

        const [verRow] = await tx
          .select()
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.automationId, locked.id),
              eq(automationVersions.version, locked.version),
            ),
          )
          .limit(1);
        if (!verRow) return;

        const created = await createQueuedRunInTx(tx, {
          automationRow: locked,
          versionRow: verRow,
          triggerMode: "schedule",
          triggerKey: null,
          triggerEventId: null,
          dedupKey: `sched:${slotMinute}`,
          isTest: false,
          snapshot: {},
        });
        if (created.created) enqueued += 1;
      });
    }

    return { outcome: "completed", safeCounts: { scheduled_runs: enqueued } };
  }

  async function handlePurgeRunsJob(job: ClaimedJob<unknown>): Promise<JobResult> {
    job.signal.throwIfAborted();
    const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);
    const cutoff = new Date(clock.now().getTime() - cfg.runRetentionDays * 86_400_000);

    const oldRuns = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(
        and(
          lt(automationRuns.queuedAt, cutoff),
          inArray(automationRuns.state, [
            "completed",
            "skipped_conditions",
            "rate_limited",
            "failed",
            "partial_unknown",
            "canceled",
          ]),
        ),
      )
      .orderBy(asc(automationRuns.id))
      .limit(200);

    const oldStageRuns = await db
      .select({ id: orderStageRuns.id })
      .from(orderStageRuns)
      .where(lt(orderStageRuns.finishedAt, cutoff))
      .orderBy(asc(orderStageRuns.id))
      .limit(200);

    const oldCompJobs = await db
      .select({ id: orderCompletionJobs.id })
      .from(orderCompletionJobs)
      .where(
        and(
          isNotNull(orderCompletionJobs.completedAt),
          lt(orderCompletionJobs.completedAt, cutoff),
          inArray(orderCompletionJobs.state, ["applied", "superseded", "canceled", "failed"]),
        ),
      )
      .orderBy(asc(orderCompletionJobs.id))
      .limit(200);

    if (oldRuns.length === 0 && oldStageRuns.length === 0 && oldCompJobs.length === 0) {
      return { outcome: "completed", safeCounts: { purged_runs: 0 } };
    }

    const ids = oldRuns.map((r) => r.id);
    const stageRunIds = oldStageRuns.map((r) => r.id);
    const compJobIds = oldCompJobs.map((r) => r.id);
    await db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      if (ids.length > 0) {
        await tx.delete(automationRunSteps).where(inArray(automationRunSteps.runId, ids));
        await tx.delete(automationRuns).where(inArray(automationRuns.id, ids));
      }
      if (stageRunIds.length > 0) {
        await tx.delete(orderStageRuns).where(inArray(orderStageRuns.id, stageRunIds));
      }
      if (compJobIds.length > 0) {
        await tx.delete(orderCompletionJobs).where(inArray(orderCompletionJobs.id, compJobIds));
      }
    });

    return {
      outcome: "completed",
      safeCounts: {
        purged_runs: ids.length,
        purged_stage_runs: stageRunIds.length,
        purged_completion_jobs: compJobIds.length,
      },
    };
  }

  jobs.register(JOB_EVALUATE_EVENT, handleEvaluateEventJob, { retrySafe: true });
  jobs.register(JOB_EXECUTE_RUN, handleExecuteRunJob, { retrySafe: true });
  jobs.register(JOB_SCHEDULE_TICK, handleScheduleTickJob, { retrySafe: true });
  jobs.register(JOB_PURGE_RUNS, handlePurgeRunsJob, { retrySafe: true });
  jobs.register(
    JOB_APPLY_COMPLETION,
    (job: ClaimedJob<ApplyCompletionJobPayload>) => handleApplyCompletionJob(deps, job),
    { retrySafe: true },
  );

  jobs.registerSchedule({
    name: "automations.schedule_tick",
    type: JOB_SCHEDULE_TICK,
    everyMs: 60_000,
  });
  jobs.registerSchedule({
    name: "automations.purge_runs",
    type: JOB_PURGE_RUNS,
    everyMs: 86_400_000,
  });

  /* --------------------------------------------------- Public API methods */

  async function getCatalogue(principal: SessionPrincipal): Promise<AutomationCatalogueView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.read");
    const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);

    const actions = [...actionMap.values()].map((a) => ({
      key: a.key,
      label: a.label,
      description: a.description,
      category: a.category,
      owner: a.owner,
      configFields: a.configFields,
      requiresOrderContext: Boolean(a.requiresOrderContext),
      forbidOnStaffOnlyTrigger: Boolean(a.forbidOnStaffOnlyTrigger),
      supportedTriggerModes: a.supportedTriggerModes ?? (["event", "manual", "schedule"] as const),
      retrySafe: a.retrySafe,
    }));

    const pickerOptions = await buildCataloguePickerOptions(deps, principal);

    return {
      globallyEnabled: cfg.enabled,
      stageBundlesEnabled: cfg.stageBundlesEnabled,
      limits: {
        globalRunsPerMinute: cfg.globalRunsPerMinute,
        defaultPerAutomationRunsPerHour: cfg.defaultPerAutomationRunsPerHour,
        maxPerAutomationRunsPerHour: cfg.maxPerAutomationRunsPerHour,
        maxActionsPerAutomation: AUTOMATION_MAX_ACTIONS,
        maxConditionGroups: AUTOMATION_MAX_CONDITION_GROUPS,
        maxConditionsPerGroup: AUTOMATION_MAX_CONDITIONS_PER_GROUP,
        minScheduleMinutes: AUTOMATION_MIN_SCHEDULE_MINUTES,
        maxScheduleMinutes: AUTOMATION_MAX_SCHEDULE_MINUTES,
        maxActiveSchedules: AUTOMATION_MAX_ACTIVE_SCHEDULES,
      },
      triggers: allTriggerEntries(),
      actions,
      operatorsByFieldType: OPERATORS_BY_FIELD_TYPE,
      starterRecipes: STARTER_RECIPES,
      pickerOptions,
    };
  }

  async function getSettings(principal: SessionPrincipal): Promise<AutomationSettingsView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.read");
    return readSetting(settings, AUTOMATIONS_CONFIG);
  }

  async function updateSettings(
    principal: SessionPrincipal,
    patch: Partial<AutomationSettingsView>,
  ): Promise<AutomationSettingsView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const current = await readSetting(settings, AUTOMATIONS_CONFIG, tx);
      const merged = automationsConfigSchema.safeParse({ ...current, ...patch });
      if (!merged.success) {
        throw validation("AUTOMATION_INVALID_SETTINGS", "Automation settings are out of range.");
      }
      if (merged.data.defaultPerAutomationRunsPerHour > merged.data.maxPerAutomationRunsPerHour) {
        throw validation(
          "AUTOMATION_INVALID_SETTINGS",
          "Default hourly limit cannot exceed maximum hourly limit.",
        );
      }
      await writeSetting(settings, AUTOMATIONS_CONFIG, merged.data, tx);
      await audit.record(
        {
          category: "admin",
          eventName: "automation.settings.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation_settings" },
          attributes: {
            enabled: merged.data.enabled,
            stage_bundles_enabled: merged.data.stageBundlesEnabled,
            global_runs_per_minute: merged.data.globalRunsPerMinute,
            default_runs_per_hour: merged.data.defaultPerAutomationRunsPerHour,
            max_runs_per_hour: merged.data.maxPerAutomationRunsPerHour,
            run_retention_days: merged.data.runRetentionDays,
          },
        },
        tx,
      );
      await refreshTapCache(tx);
      return merged.data;
    });
  }

  async function nextSortOrderInTx(tx: Tx): Promise<number> {
    const [row] = await tx
      .select({ maxSort: sql<number | null>`MAX(${automations.sortOrder})` })
      .from(automations);
    return (Number(row?.maxSort ?? 0) || 0) + 10;
  }

  async function list(
    principal: SessionPrincipal,
    input: {
      cursor?: string;
      limit?: number;
      enabled?: boolean;
      triggerMode?: AutomationTriggerMode;
      query?: string;
    },
  ): Promise<{ items: AutomationSummaryView[]; nextCursor: string | null }> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.read");
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const afterId = decodeIdCursor(input.cursor);
    const q = input.query?.trim().toLowerCase() ?? "";

    let afterAnchor: { id: number; sortOrder: number } | undefined;
    if (afterId !== undefined) {
      const [anchorRow] = await db
        .select({ id: automations.id, sortOrder: automations.sortOrder })
        .from(automations)
        .where(eq(automations.id, afterId))
        .limit(1);
      afterAnchor = anchorRow
        ? { id: anchorRow.id, sortOrder: anchorRow.sortOrder }
        : { id: afterId, sortOrder: Number.MAX_SAFE_INTEGER };
    }

    const rows = await db
      .select()
      .from(automations)
      .where(
        and(
          input.enabled !== undefined ? eq(automations.enabled, input.enabled) : undefined,
          input.triggerMode !== undefined
            ? eq(automations.triggerMode, input.triggerMode)
            : undefined,
          afterAnchor !== undefined
            ? or(
                gt(automations.sortOrder, afterAnchor.sortOrder),
                and(
                  eq(automations.sortOrder, afterAnchor.sortOrder),
                  gt(automations.id, afterAnchor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(automations.sortOrder), asc(automations.id))
      .limit(q ? 200 : limit + 1);

    const filtered = q
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.description?.toLowerCase().includes(q) ?? false) ||
            (r.triggerKey?.toLowerCase().includes(q) ?? false),
        )
      : rows;

    const slice = filtered.slice(0, limit);
    const nextCursor =
      filtered.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;
    const lastRunIds = slice
      .map((r) => r.lastRunId)
      .filter((id): id is number => typeof id === "number" && id > 0);
    const lastRunMap = await loadLastRunMap(db, lastRunIds);

    return {
      items: slice.map((r) => rowToSummaryView(r, lastRunMap)),
      nextCursor,
    };
  }

  async function get(
    principal: SessionPrincipal,
    input: { publicId: string },
  ): Promise<AutomationDetailView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.read");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("AUTOMATION_NOT_FOUND");
    }
    const [row] = await db
      .select()
      .from(automations)
      .where(eq(automations.publicId, input.publicId))
      .limit(1);
    if (!row) throw notFound("AUTOMATION_NOT_FOUND");
    return buildDetailView(db, row);
  }

  async function listVersions(
    principal: SessionPrincipal,
    input: { publicId: string; limit?: number },
  ): Promise<{ items: AutomationVersionView[] }> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.read");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("AUTOMATION_NOT_FOUND");
    }
    const [autoRow] = await db
      .select()
      .from(automations)
      .where(eq(automations.publicId, input.publicId))
      .limit(1);
    if (!autoRow) throw notFound("AUTOMATION_NOT_FOUND");

    const verRows = await db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, autoRow.id))
      .orderBy(desc(automationVersions.version))
      .limit(Math.min(Math.max(input.limit ?? 25, 1), 100));

    const creatorIds = [
      ...new Set(
        verRows
          .map((v) => v.createdByUserId)
          .filter((id): id is number => typeof id === "number" && id > 0),
      ),
    ];
    const creatorRows =
      creatorIds.length > 0
        ? await db
            .select({ id: users.id, publicId: users.publicId })
            .from(users)
            .where(inArray(users.id, creatorIds))
        : [];
    const creatorPublicById = new Map(creatorRows.map((u) => [u.id, u.publicId]));

    const secretRows = await db
      .select({
        stepKey: automationSecrets.stepKey,
        fieldKey: automationSecrets.fieldKey,
        last4: automationSecrets.last4,
      })
      .from(automationSecrets)
      .where(eq(automationSecrets.automationId, autoRow.id));

    return {
      items: verRows.map((v) => {
        const persistedActions = parseJsonSafe<PersistedActionStep[]>(v.actionsJson, []);
        const statusByStep = buildSecretStatusMap(persistedActions, secretRows);
        const trigger = parseJsonSafe<AutomationTriggerConfig>(
          v.triggerJson,
          rowToTriggerConfig(autoRow),
        );
        const conditions = parseJsonSafe<AutomationConditionTree>(
          v.conditionsJson,
          EMPTY_CONDITION_TREE,
        );
        const canvasLayout = parseJsonSafe<AutomationCanvasLayout | null>(v.canvasLayoutJson, null);
        return {
          version: v.version,
          trigger,
          conditions,
          actions: persistedActions.map((step) => ({
            stepKey: step.stepKey,
            actionKey: step.actionKey,
            label: step.label,
            config: step.config,
            secretStatus: statusByStep.get(step.stepKey) ?? {},
          })),
          canvasLayout,
          createdByUserPublicId: v.createdByUserId
            ? (creatorPublicById.get(v.createdByUserId) ?? null)
            : null,
          createdAt: v.createdAt,
        };
      }),
    };
  }

  async function create(
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
  ): Promise<AutomationDetailView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const cfg = await readSetting(settings, AUTOMATIONS_CONFIG, tx);

      const validated = validateAutomationDefinition({
        name: input.name,
        description: input.description,
        maxRunsPerHour: input.maxRunsPerHour,
        cfg,
        trigger: input.trigger,
        conditions: input.conditions,
        actions: input.actions,
        canvasLayout: input.canvasLayout,
      });

      const enabled = Boolean(input.enabled);
      if (enabled && validated.triggerMode === "schedule") {
        await assertScheduleQuotaInTx(tx);
      }

      const now = clock.now();
      const autoPublicId = ulid(now.getTime());
      const nextScheduledAt =
        enabled && validated.triggerMode === "schedule" && validated.scheduleEveryMinutes
          ? new Date(now.getTime() + validated.scheduleEveryMinutes * 60_000)
          : null;
      const sanitizedLayout = sanitizeCanvasLayout(input.canvasLayout);
      const conditionsJson = JSON.stringify(validated.conditions);
      const actionsJson = JSON.stringify(validated.persistedActions);
      const canvasLayoutJson = sanitizedLayout ? JSON.stringify(sanitizedLayout) : null;

      const sortOrder = await nextSortOrderInTx(tx);
      const [autoIns] = await tx.insert(automations).values({
        publicId: autoPublicId,
        name: validated.normalizedName,
        description: validated.normalizedDescription,
        enabled,
        sortOrder,
        version: 1,
        triggerMode: validated.triggerMode,
        triggerKey: validated.triggerKey,
        triggerEventName: validated.triggerEventName,
        scheduleEveryMinutes: validated.scheduleEveryMinutes,
        nextScheduledAt,
        manualRequireOrder: validated.manualRequireOrder,
        maxRunsPerHour: validated.maxRunsPerHour,
        conditionsJson,
        actionsJson,
        canvasLayoutJson,
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
        lastRunId: null,
        createdAt: now,
        updatedAt: now,
      });
      const automationId = Number(autoIns.insertId);

      await tx.insert(automationVersions).values({
        publicId: ulid(now.getTime() + 1),
        automationId,
        version: 1,
        triggerJson: JSON.stringify(validated.triggerConfig),
        conditionsJson,
        actionsJson,
        canvasLayoutJson,
        createdByUserId: principal.userId,
        createdAt: now,
      });

      let rotatedFields = 0;
      for (const mut of validated.secretMutations) {
        if (mut.op === "set" && mut.value) {
          const secPublicId = ulid(now.getTime() + 2 + rotatedFields);
          const last4 = mut.value.slice(-4);
          const secretEnc = crypto.encrypt(
            mut.value,
            `automation_secrets.secret_enc:${secPublicId}`,
          );
          await tx.insert(automationSecrets).values({
            publicId: secPublicId,
            automationId,
            stepKey: mut.stepKey,
            fieldKey: mut.fieldKey,
            secretEnc,
            last4,
            createdAt: now,
            updatedAt: now,
          });
          rotatedFields += 1;
        }
      }

      await audit.record(
        {
          category: "admin",
          eventName: "automation.created",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation", publicId: autoPublicId },
          safeCounts: {
            actions: validated.persistedActions.length,
            rotated_fields: rotatedFields,
          },
          attributes: {
            trigger_mode: validated.triggerMode,
            enabled,
          },
        },
        tx,
      );

      await refreshTapCache(tx);

      const [createdRow] = await tx
        .select()
        .from(automations)
        .where(eq(automations.id, automationId))
        .limit(1);
      return buildDetailView(tx, createdRow!);
    });
  }

  async function update(
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
  ): Promise<AutomationDetailView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("AUTOMATION_NOT_FOUND");
    }

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const [existing] = await tx
        .select()
        .from(automations)
        .where(eq(automations.publicId, input.publicId))
        .for("update");
      if (!existing) throw notFound("AUTOMATION_NOT_FOUND");
      if (existing.version !== input.expectedVersion) {
        throw conflict(
          "VERSION_CONFLICT",
          "This automation was modified by another administrator. Reload and try again.",
        );
      }

      const existingSecrets = await tx
        .select()
        .from(automationSecrets)
        .where(eq(automationSecrets.automationId, existing.id));
      const existingSecretFieldsByStep = new Map<string, Set<string>>();
      for (const s of existingSecrets) {
        const set = existingSecretFieldsByStep.get(s.stepKey) ?? new Set<string>();
        set.add(s.fieldKey);
        existingSecretFieldsByStep.set(s.stepKey, set);
      }

      const currentActions = parseJsonSafe<PersistedActionStep[]>(existing.actionsJson, []);
      const fallbackActions: AutomationActionStepInput[] = currentActions.map((a) => ({
        stepKey: a.stepKey,
        actionKey: a.actionKey,
        ...(a.label ? { label: a.label } : {}),
        config: a.config,
      }));
      const currentConditions = parseJsonSafe<AutomationConditionTree>(
        existing.conditionsJson,
        EMPTY_CONDITION_TREE,
      );
      const currentLayout = parseJsonSafe<AutomationCanvasLayout | null>(
        existing.canvasLayoutJson,
        null,
      );

      const cfg = await readSetting(settings, AUTOMATIONS_CONFIG, tx);
      const validated = validateAutomationDefinition({
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        maxRunsPerHour: input.maxRunsPerHour ?? existing.maxRunsPerHour,
        cfg,
        trigger: input.trigger ?? rowToTriggerConfig(existing),
        conditions: input.conditions ?? currentConditions,
        actions: input.actions ?? fallbackActions,
        canvasLayout: input.canvasLayout !== undefined ? input.canvasLayout : currentLayout,
        existingSecretFieldsByStep,
      });

      const nextEnabled = input.enabled !== undefined ? input.enabled : existing.enabled;
      if (nextEnabled && validated.triggerMode === "schedule") {
        await assertScheduleQuotaInTx(tx, existing.id);
      }

      const now = clock.now();
      const nextVersion = existing.version + 1;
      const nextScheduledAt =
        nextEnabled && validated.triggerMode === "schedule" && validated.scheduleEveryMinutes
          ? new Date(now.getTime() + validated.scheduleEveryMinutes * 60_000)
          : null;
      const sanitizedLayout = sanitizeCanvasLayout(
        input.canvasLayout !== undefined ? input.canvasLayout : currentLayout,
      );
      const conditionsJson = JSON.stringify(validated.conditions);
      const actionsJson = JSON.stringify(validated.persistedActions);
      const canvasLayoutJson = sanitizedLayout ? JSON.stringify(sanitizedLayout) : null;

      await tx.insert(automationVersions).values({
        publicId: ulid(now.getTime()),
        automationId: existing.id,
        version: nextVersion,
        triggerJson: JSON.stringify(validated.triggerConfig),
        conditionsJson,
        actionsJson,
        canvasLayoutJson,
        createdByUserId: principal.userId,
        createdAt: now,
      });

      const keptStepKeys = new Set(validated.persistedActions.map((a) => a.stepKey));
      for (const s of existingSecrets) {
        if (!keptStepKeys.has(s.stepKey)) {
          await tx.delete(automationSecrets).where(eq(automationSecrets.id, s.id));
        }
      }

      let rotatedFields = 0;
      for (const mut of validated.secretMutations) {
        const match = existingSecrets.find(
          (e) => e.stepKey === mut.stepKey && e.fieldKey === mut.fieldKey,
        );
        if (mut.op === "clear") {
          if (match) {
            await tx.delete(automationSecrets).where(eq(automationSecrets.id, match.id));
          }
          continue;
        }
        if (mut.op === "set" && mut.value) {
          const last4 = mut.value.slice(-4);
          if (match) {
            const secretEnc = crypto.encrypt(
              mut.value,
              `automation_secrets.secret_enc:${match.publicId}`,
            );
            await tx
              .update(automationSecrets)
              .set({ secretEnc, last4, updatedAt: now })
              .where(eq(automationSecrets.id, match.id));
          } else {
            const secPublicId = ulid(now.getTime() + 1 + rotatedFields);
            const secretEnc = crypto.encrypt(
              mut.value,
              `automation_secrets.secret_enc:${secPublicId}`,
            );
            await tx.insert(automationSecrets).values({
              publicId: secPublicId,
              automationId: existing.id,
              stepKey: mut.stepKey,
              fieldKey: mut.fieldKey,
              secretEnc,
              last4,
              createdAt: now,
              updatedAt: now,
            });
          }
          rotatedFields += 1;
        }
      }

      await tx
        .update(automations)
        .set({
          name: validated.normalizedName,
          description: validated.normalizedDescription,
          enabled: nextEnabled,
          version: nextVersion,
          triggerMode: validated.triggerMode,
          triggerKey: validated.triggerKey,
          triggerEventName: validated.triggerEventName,
          scheduleEveryMinutes: validated.scheduleEveryMinutes,
          nextScheduledAt,
          manualRequireOrder: validated.manualRequireOrder,
          maxRunsPerHour: validated.maxRunsPerHour,
          conditionsJson,
          actionsJson,
          canvasLayoutJson,
          updatedByUserId: principal.userId,
          updatedAt: now,
        })
        .where(eq(automations.id, existing.id));

      await audit.record(
        {
          category: "admin",
          eventName: "automation.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation", publicId: existing.publicId },
          safeCounts: {
            actions: validated.persistedActions.length,
            rotated_fields: rotatedFields,
          },
          attributes: {
            trigger_mode: validated.triggerMode,
            version_number: nextVersion,
          },
        },
        tx,
      );

      await refreshTapCache(tx);

      const [updatedRow] = await tx
        .select()
        .from(automations)
        .where(eq(automations.id, existing.id))
        .limit(1);
      return buildDetailView(tx, updatedRow!);
    });
  }

  async function setEnabled(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; enabled: boolean },
  ): Promise<AutomationDetailView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("AUTOMATION_NOT_FOUND");
    }

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const [existing] = await tx
        .select()
        .from(automations)
        .where(eq(automations.publicId, input.publicId))
        .for("update");
      if (!existing) throw notFound("AUTOMATION_NOT_FOUND");
      if (existing.version !== input.expectedVersion) {
        throw conflict(
          "VERSION_CONFLICT",
          "This automation was modified by another administrator. Reload and try again.",
        );
      }

      if (input.enabled) {
        if (existing.triggerMode === "schedule") {
          await assertScheduleQuotaInTx(tx, existing.id);
        }
        const persistedSteps = parseJsonSafe<PersistedActionStep[]>(existing.actionsJson, []);
        const secretRows = await tx
          .select()
          .from(automationSecrets)
          .where(eq(automationSecrets.automationId, existing.id));
        const configuredByStep = new Map<string, Set<string>>();
        for (const s of secretRows) {
          const set = configuredByStep.get(s.stepKey) ?? new Set<string>();
          set.add(s.fieldKey);
          configuredByStep.set(s.stepKey, set);
        }
        for (const step of persistedSteps) {
          const def = actionMap.get(step.actionKey);
          for (const field of def?.configFields ?? []) {
            if ((field.type === "secret" || field.secret) && field.required) {
              if (!configuredByStep.get(step.stepKey)?.has(field.key)) {
                throw validation(
                  "AUTOMATION_SECRET_REQUIRED",
                  `Configure secret '${field.label}' before enabling this automation.`,
                );
              }
            }
          }
        }
      }

      const now = clock.now();
      const nextVersion = existing.version + 1;
      const nextScheduledAt =
        input.enabled && existing.triggerMode === "schedule" && existing.scheduleEveryMinutes
          ? new Date(now.getTime() + existing.scheduleEveryMinutes * 60_000)
          : null;

      await tx.insert(automationVersions).values({
        publicId: ulid(now.getTime()),
        automationId: existing.id,
        version: nextVersion,
        triggerJson: JSON.stringify(rowToTriggerConfig(existing)),
        conditionsJson: existing.conditionsJson,
        actionsJson: existing.actionsJson,
        canvasLayoutJson: existing.canvasLayoutJson,
        createdByUserId: principal.userId,
        createdAt: now,
      });

      await tx
        .update(automations)
        .set({
          enabled: input.enabled,
          nextScheduledAt,
          updatedByUserId: principal.userId,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(automations.id, existing.id));

      await audit.record(
        {
          category: "admin",
          eventName: input.enabled ? "automation.enabled" : "automation.disabled",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation", publicId: existing.publicId },
          attributes: { enabled: input.enabled },
        },
        tx,
      );

      await refreshTapCache(tx);

      const [updatedRow] = await tx
        .select()
        .from(automations)
        .where(eq(automations.id, existing.id))
        .limit(1);
      return buildDetailView(tx, updatedRow!);
    });
  }

  async function duplicate(
    principal: SessionPrincipal,
    input: { publicId: string; name?: string },
  ): Promise<AutomationDetailView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("AUTOMATION_NOT_FOUND");
    }

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const [source] = await tx
        .select()
        .from(automations)
        .where(eq(automations.publicId, input.publicId))
        .limit(1);
      if (!source) throw notFound("AUTOMATION_NOT_FOUND");

      const copyName = (input.name?.trim() || `${source.name} (copy)`).slice(0, 120);
      const now = clock.now();
      const copyPublicId = ulid(now.getTime());

      const sortOrder = await nextSortOrderInTx(tx);
      const [ins] = await tx.insert(automations).values({
        publicId: copyPublicId,
        name: copyName,
        description: source.description,
        enabled: false,
        sortOrder,
        version: 1,
        triggerMode: source.triggerMode,
        triggerKey: source.triggerKey,
        triggerEventName: source.triggerEventName,
        scheduleEveryMinutes: source.scheduleEveryMinutes,
        nextScheduledAt: null,
        manualRequireOrder: source.manualRequireOrder,
        maxRunsPerHour: source.maxRunsPerHour,
        conditionsJson: source.conditionsJson,
        actionsJson: source.actionsJson,
        canvasLayoutJson: source.canvasLayoutJson,
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
        lastRunId: null,
        createdAt: now,
        updatedAt: now,
      });
      const copyId = Number(ins.insertId);

      await tx.insert(automationVersions).values({
        publicId: ulid(now.getTime() + 1),
        automationId: copyId,
        version: 1,
        triggerJson: JSON.stringify(rowToTriggerConfig(source)),
        conditionsJson: source.conditionsJson,
        actionsJson: source.actionsJson,
        canvasLayoutJson: source.canvasLayoutJson,
        createdByUserId: principal.userId,
        createdAt: now,
      });

      await audit.record(
        {
          category: "admin",
          eventName: "automation.duplicated",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation", publicId: copyPublicId },
          attributes: { source_public_id: source.publicId },
        },
        tx,
      );

      const [createdRow] = await tx
        .select()
        .from(automations)
        .where(eq(automations.id, copyId))
        .limit(1);
      return buildDetailView(tx, createdRow!);
    });
  }

  async function remove(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number },
  ): Promise<{ deleted: true }> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("AUTOMATION_NOT_FOUND");
    }

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const [existing] = await tx
        .select()
        .from(automations)
        .where(eq(automations.publicId, input.publicId))
        .for("update");
      if (!existing) throw notFound("AUTOMATION_NOT_FOUND");
      if (existing.version !== input.expectedVersion) {
        throw conflict(
          "VERSION_CONFLICT",
          "This automation was modified by another administrator. Reload and try again.",
        );
      }

      const runIdsRows = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(eq(automationRuns.automationId, existing.id));
      if (runIdsRows.length > 0) {
        await tx.delete(automationRunSteps).where(
          inArray(
            automationRunSteps.runId,
            runIdsRows.map((r) => r.id),
          ),
        );
      }
      await tx.delete(automationRuns).where(eq(automationRuns.automationId, existing.id));
      await tx.delete(automationSecrets).where(eq(automationSecrets.automationId, existing.id));
      await tx.delete(automationVersions).where(eq(automationVersions.automationId, existing.id));
      await tx.delete(automations).where(eq(automations.id, existing.id));

      await audit.record(
        {
          category: "admin",
          eventName: "automation.deleted",
          action: "delete",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation", publicId: existing.publicId },
        },
        tx,
      );

      await refreshTapCache(tx);
      return { deleted: true };
    });
  }

  async function reorder(
    principal: SessionPrincipal,
    input: { orderedPublicIds: readonly string[] },
  ): Promise<{ orderedPublicIds: string[] }> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");
    if (input.orderedPublicIds.length > 500) {
      throw validation("TOO_MANY_AUTOMATIONS", "Cannot reorder more than 500 rules at once.");
    }
    const seen = new Set<string>();
    for (const pid of input.orderedPublicIds) {
      if (!ULID_PATTERN.test(pid)) {
        throw validation("INVALID_AUTOMATION_ID", "Automation identifier is invalid.");
      }
      if (seen.has(pid)) {
        throw validation("DUPLICATE_AUTOMATION_ID", "Duplicate automation identifier in order.");
      }
      seen.add(pid);
    }

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const allRows = await tx
        .select({
          id: automations.id,
          publicId: automations.publicId,
          sortOrder: automations.sortOrder,
        })
        .from(automations)
        .orderBy(asc(automations.sortOrder), asc(automations.id))
        .for("update");

      const rowByPublicId = new Map(allRows.map((r) => [r.publicId, r]));
      for (const pid of input.orderedPublicIds) {
        if (!rowByPublicId.has(pid)) {
          throw notFound("AUTOMATION_NOT_FOUND");
        }
      }

      const orderedRows: typeof allRows = [];
      for (const pid of input.orderedPublicIds) {
        orderedRows.push(rowByPublicId.get(pid)!);
      }
      for (const r of allRows) {
        if (!seen.has(r.publicId)) {
          orderedRows.push(r);
        }
      }

      const now = clock.now();
      for (let idx = 0; idx < orderedRows.length; idx += 1) {
        const target = orderedRows[idx]!;
        const nextSort = (idx + 1) * 10;
        if (target.sortOrder !== nextSort) {
          await tx
            .update(automations)
            .set({
              sortOrder: nextSort,
              updatedByUserId: principal.userId,
              updatedAt: now,
            })
            .where(eq(automations.id, target.id));
        }
      }

      const finalIds = orderedRows.map((r) => r.publicId);
      await audit.record(
        {
          category: "admin",
          eventName: "automation.rules.reordered",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation" },
          safeCounts: { rule_count: finalIds.length },
        },
        tx,
      );

      return { orderedPublicIds: finalIds };
    });
  }

  async function triggerManual(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      orderPublicId?: string | null;
      sampleFields?: Record<string, AutomationScalarValue>;
    },
  ): Promise<{ runPublicId: string; jobId: string }> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("AUTOMATION_NOT_FOUND");
    }
    if (input.orderPublicId && !ULID_PATTERN.test(input.orderPublicId)) {
      throw validation("INVALID_ORDER_ID", "Order identifier is invalid.");
    }

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const cfg = await readSetting(settings, AUTOMATIONS_CONFIG, tx);
      if (!cfg.enabled) {
        throw new DomainError(
          "NOT_CONFIGURED",
          "AUTOMATIONS_DISABLED",
          "Enable automations in settings before running manually.",
        );
      }

      const [autoRow] = await tx
        .select()
        .from(automations)
        .where(eq(automations.publicId, input.publicId))
        .for("update");
      if (!autoRow) throw notFound("AUTOMATION_NOT_FOUND");
      if (!autoRow.enabled) {
        throw validation(
          "AUTOMATION_NOT_ENABLED",
          "Enable this automation before running it manually.",
        );
      }
      if (autoRow.triggerMode !== "manual") {
        throw validation(
          "AUTOMATION_NOT_MANUAL",
          "Only manual-trigger automations can be started with triggerManual.",
        );
      }
      if (autoRow.manualRequireOrder && !input.orderPublicId) {
        throw validation(
          "ORDER_ID_REQUIRED",
          "This manual automation requires an order identifier.",
        );
      }
      if (input.orderPublicId) {
        const orderRef = await deps.services.orders?.getOrderRefByPublicId?.(
          input.orderPublicId,
          tx,
        );
        if (!orderRef) {
          throw notFound("ORDER_NOT_FOUND");
        }
      }

      const [verRow] = await tx
        .select()
        .from(automationVersions)
        .where(
          and(
            eq(automationVersions.automationId, autoRow.id),
            eq(automationVersions.version, autoRow.version),
          ),
        )
        .limit(1);
      if (!verRow) throw notFound("AUTOMATION_VERSION_NOT_FOUND");

      const manualDedup = `manual:${ulid(clock.now().getTime())}`;
      const queued = await createQueuedRunInTx(tx, {
        automationRow: autoRow,
        versionRow: verRow,
        triggerMode: "manual",
        triggerKey: null,
        triggerEventId: null,
        orderPublicId: input.orderPublicId ?? null,
        triggeredByUserId: principal.userId,
        dedupKey: manualDedup,
        isTest: false,
        snapshot: {
          orderPublicId: input.orderPublicId ?? null,
          actorUserId: principal.userId,
          sampleFields: input.sampleFields ?? null,
        },
      });

      await audit.record(
        {
          category: "admin",
          eventName: "automation.manual.triggered",
          action: "execute",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation", publicId: autoRow.publicId },
          ...(input.orderPublicId ? { orderPublicId: input.orderPublicId } : {}),
          correlationId: automationCorrelationId(queued.runPublicId),
          attributes: {
            run_public_id: queued.runPublicId,
            ...(input.orderPublicId ? { order_public_id: input.orderPublicId } : {}),
          },
        },
        tx,
      );

      return { runPublicId: queued.runPublicId, jobId: queued.jobId };
    });
  }

  async function testRun(
    principal: SessionPrincipal,
    input: {
      publicId?: string;
      trigger: AutomationTriggerConfig;
      conditions?: AutomationConditionTree;
      actions: readonly AutomationActionStepInput[];
      sampleFields?: Record<string, AutomationScalarValue>;
      orderPublicId?: string | null;
      executeLive?: boolean;
    },
  ): Promise<AutomationTestRunResult> {
    const requiredCap = input.executeLive ? "automations.manage" : "automations.read";
    await assertAutomationsCapabilityPreflight(deps, principal, requiredCap);

    let existingAuto: typeof automations.$inferSelect | undefined;
    const existingSecretFieldsByStep = new Map<string, Set<string>>();
    if (input.publicId) {
      if (!ULID_PATTERN.test(input.publicId)) {
        throw notFound("AUTOMATION_NOT_FOUND");
      }
      const [row] = await db
        .select()
        .from(automations)
        .where(eq(automations.publicId, input.publicId))
        .limit(1);
      if (!row) throw notFound("AUTOMATION_NOT_FOUND");
      existingAuto = row;
      const secs = await db
        .select()
        .from(automationSecrets)
        .where(eq(automationSecrets.automationId, row.id));
      for (const s of secs) {
        const set = existingSecretFieldsByStep.get(s.stepKey) ?? new Set<string>();
        set.add(s.fieldKey);
        existingSecretFieldsByStep.set(s.stepKey, set);
      }
    }

    const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);
    const validated = validateAutomationDefinition({
      name: "Test draft",
      cfg,
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      existingSecretFieldsByStep,
    });

    const resolvedCtx = await resolveFullTriggerContext({
      triggerMode: validated.triggerMode,
      triggerKey: validated.triggerKey,
      snapshot: {
        orderPublicId: input.orderPublicId ?? null,
        sampleFields: input.sampleFields ?? null,
      },
      signal: AbortSignal.timeout(10_000),
    });

    const condEval = evaluateConditionTree(validated.conditions, resolvedCtx.fields);
    const plannedSteps = validated.persistedActions.map((step, stepIndex) => {
      if (!condEval.matched) {
        return {
          stepIndex,
          stepKey: step.stepKey,
          actionKey: step.actionKey,
          wouldRun: false,
          previewSummary: "Skipped because conditions did not match.",
        };
      }
      const def = actionMap.get(step.actionKey)!;
      let summary = `${def.label}: validated configuration.`;
      if (step.actionKey === "email.send_template") {
        const subj = renderPlainTemplate(String(step.config.subject ?? ""), resolvedCtx.fields, {
          singleLine: true,
        });
        summary = `Would queue e-mail with subject "${subj.slice(0, 80)}".`;
      } else if (step.actionKey === "notification.send_in_app") {
        const title = renderPlainTemplate(String(step.config.title ?? ""), resolvedCtx.fields, {
          singleLine: true,
        });
        summary = `Would send in-app notification "${title.slice(0, 80)}".`;
      } else if (step.actionKey === "support.create_ticket") {
        const subj = renderPlainTemplate(String(step.config.subject ?? ""), resolvedCtx.fields, {
          singleLine: true,
        });
        summary = `Would open support ticket "${subj.slice(0, 80)}".`;
      } else if (step.actionKey === "webhook.call") {
        const fList = (step.config.payloadFields as string[] | undefined) ?? [];
        summary = `Would POST allowlisted fields (${fList.join(", ") || "none"}) to configured HTTPS endpoint.`;
      }
      return {
        stepIndex,
        stepKey: step.stepKey,
        actionKey: step.actionKey,
        wouldRun: true,
        previewSummary: summary,
      };
    });

    if (!input.executeLive) {
      await db.transaction(async (tx) => {
        await assertAutomationsActorInTx(deps, principal, tx, "automations.read");
        await audit.record(
          {
            category: "admin",
            eventName: "automation.test.dry_run",
            action: "validate",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: {
              type: "automation",
              publicId: existingAuto?.publicId ?? null,
            },
            attributes: {
              conditions_matched: condEval.matched,
              trigger_mode: validated.triggerMode,
            },
          },
          tx,
        );
      });

      return {
        dryRun: true,
        conditionsMatched: condEval.matched,
        groupResults: condEval.groupResults,
        plannedSteps,
        liveRunPublicId: null,
      };
    }

    if (!existingAuto) {
      throw validation(
        "AUTOMATION_SAVE_BEFORE_LIVE_TEST",
        "Save the automation before executing a live test run.",
      );
    }
    if (!cfg.enabled) {
      throw new DomainError(
        "NOT_CONFIGURED",
        "AUTOMATIONS_DISABLED",
        "Enable automations in settings before executing a live test run.",
      );
    }

    if (!condEval.matched) {
      return {
        dryRun: false,
        conditionsMatched: false,
        groupResults: condEval.groupResults,
        plannedSteps,
        liveRunPublicId: null,
      };
    }

    const queued = await db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "automations.manage");
      const oneHourAgo = new Date(clock.now().getTime() - 3_600_000);
      const [testCountRow] = await tx
        .select({ total: count(automationRuns.id) })
        .from(automationRuns)
        .where(and(eq(automationRuns.isTest, true), gte(automationRuns.queuedAt, oneHourAgo)));
      if (Number(testCountRow?.total ?? 0) >= MAX_LIVE_TEST_RUNS_PER_HOUR) {
        throw new DomainError(
          "RATE_LIMITED",
          "LIVE_TEST_QUOTA_EXCEEDED",
          "Live test run hourly quota reached. Use dry-run preview or try later.",
        );
      }

      const [verRow] = await tx
        .select()
        .from(automationVersions)
        .where(
          and(
            eq(automationVersions.automationId, existingAuto.id),
            eq(automationVersions.version, existingAuto.version),
          ),
        )
        .limit(1);
      if (!verRow) throw notFound("AUTOMATION_VERSION_NOT_FOUND");

      const res = await createQueuedRunInTx(tx, {
        automationRow: existingAuto,
        versionRow: verRow,
        triggerMode: existingAuto.triggerMode,
        triggerKey: existingAuto.triggerKey,
        triggerEventId: null,
        orderPublicId: input.orderPublicId ?? null,
        triggeredByUserId: principal.userId,
        dedupKey: `test:${ulid(clock.now().getTime())}`,
        isTest: true,
        snapshot: {
          orderPublicId: input.orderPublicId ?? null,
          actorUserId: principal.userId,
          sampleFields: input.sampleFields ?? null,
        },
      });

      await audit.record(
        {
          category: "admin",
          eventName: "automation.test.live_queued",
          action: "execute",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "automation", publicId: existingAuto.publicId },
          correlationId: automationCorrelationId(res.runPublicId),
          attributes: { run_public_id: res.runPublicId },
        },
        tx,
      );

      return res;
    });

    return {
      dryRun: false,
      conditionsMatched: true,
      groupResults: condEval.groupResults,
      plannedSteps,
      liveRunPublicId: queued.runPublicId,
    };
  }

  async function hydrateRunViews(
    runRows: ReadonlyArray<typeof automationRuns.$inferSelect>,
  ): Promise<AutomationRunView[]> {
    if (runRows.length === 0) return [];

    const runIds = runRows.map((r) => r.id);
    const stepRows = await db
      .select()
      .from(automationRunSteps)
      .where(inArray(automationRunSteps.runId, runIds))
      .orderBy(asc(automationRunSteps.stepIndex));

    const stepsByRunId = new Map<number, AutomationRunStepView[]>();
    for (const s of stepRows) {
      const arr = stepsByRunId.get(s.runId) ?? [];
      arr.push({
        stepIndex: s.stepIndex,
        stepKey: s.stepKey,
        actionKey: s.actionKey,
        state: s.state,
        attemptCount: s.attemptCount,
        reasonCode: s.reasonCode,
        safeSummary: s.safeSummary,
        safeCounts: parseJsonSafe<Record<string, number> | null>(s.safeCountsJson, null),
        externalRef: s.externalRef,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        durationMs: s.durationMs,
      });
      stepsByRunId.set(s.runId, arr);
    }

    const actorIds = [
      ...new Set(
        runRows
          .map((r) => r.triggeredByUserId)
          .filter((uid): uid is number => typeof uid === "number" && uid > 0),
      ),
    ];
    const actorById = new Map<number, OrderStageRunActorView>();
    if (actorIds.length > 0) {
      const actorRows = await db
        .select({
          id: users.id,
          publicId: users.publicId,
          nameEnc: users.nameEnc,
          role: users.role,
        })
        .from(users)
        .where(inArray(users.id, actorIds));
      for (const a of actorRows) {
        let displayName: string = a.role;
        try {
          displayName = crypto.decrypt(a.nameEnc, `users.name:${a.publicId}`);
        } catch {
          // Keep role fallback if decryption fails in synthetic rows.
        }
        actorById.set(a.id, {
          publicId: a.publicId,
          displayName,
          role: a.role,
        });
      }
    }

    return runRows.map((r) => ({
      publicId: r.publicId,
      automationPublicId: r.automationPublicId,
      automationName: r.automationName,
      automationVersion: r.automationVersion,
      triggerMode: r.triggerMode,
      triggerKey: r.triggerKey,
      triggerEventId: r.triggerEventId,
      orderPublicId: r.orderPublicId ?? null,
      stageStepKey: r.stageStepKey ?? null,
      triggeredBy: r.triggeredByUserId ? (actorById.get(r.triggeredByUserId) ?? null) : null,
      correlationId: r.correlationId,
      isTest: r.isTest,
      state: r.state,
      reasonCode: r.reasonCode,
      evaluatedFields: parseJsonSafe<Record<string, SafeAttributeValue>>(
        r.evaluatedFieldsJson,
        {},
      ),
      steps: stepsByRunId.get(r.id) ?? [],
      queuedAt: r.queuedAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
    }));
  }

  async function listRuns(
    principal: SessionPrincipal,
    input: {
      automationPublicId?: string;
      orderPublicId?: string;
      state?: AutomationRunState;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: AutomationRunView[]; nextCursor: string | null }> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.read");
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const beforeId = decodeIdCursor(input.cursor);

    if (input.orderPublicId && !ULID_PATTERN.test(input.orderPublicId)) {
      return { items: [], nextCursor: null };
    }

    let filterAutoId: number | undefined;
    if (input.automationPublicId) {
      if (!ULID_PATTERN.test(input.automationPublicId)) {
        return { items: [], nextCursor: null };
      }
      const [autoRow] = await db
        .select({ id: automations.id })
        .from(automations)
        .where(eq(automations.publicId, input.automationPublicId))
        .limit(1);
      if (!autoRow) return { items: [], nextCursor: null };
      filterAutoId = autoRow.id;
    }

    const rows = await db
      .select()
      .from(automationRuns)
      .where(
        and(
          filterAutoId !== undefined ? eq(automationRuns.automationId, filterAutoId) : undefined,
          input.orderPublicId !== undefined
            ? eq(automationRuns.orderPublicId, input.orderPublicId)
            : undefined,
          input.state !== undefined ? eq(automationRuns.state, input.state) : undefined,
          beforeId !== undefined ? lt(automationRuns.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(automationRuns.id))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;
    const items = await hydrateRunViews(slice);
    return { items, nextCursor };
  }

  async function getRun(
    principal: SessionPrincipal,
    input: { runPublicId: string },
  ): Promise<AutomationRunView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "automations.read");
    if (!ULID_PATTERN.test(input.runPublicId)) {
      throw notFound("AUTOMATION_RUN_NOT_FOUND");
    }
    const [row] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.publicId, input.runPublicId))
      .limit(1);
    if (!row) throw notFound("AUTOMATION_RUN_NOT_FOUND");
    const [hydrated] = await hydrateRunViews([row]);
    return hydrated!;
  }

  /* --------------------------------------------------- Order stage actions (Part B T2) */

  function requireOrdersService() {
    const ordersSvc = deps.services.orders;
    if (!ordersSvc) {
      throw new DomainError(
        "UNAVAILABLE",
        "ORDERS_UNAVAILABLE",
        "Order service is temporarily unavailable.",
      );
    }
    return ordersSvc;
  }

  function automationBindsToWorkflowStep(
    autoRow: typeof automations.$inferSelect,
    versionRow: typeof automationVersions.$inferSelect,
    step: { key: string; kind: "initial" | "active" | "terminal" },
  ): boolean {
    if (!autoRow.enabled || autoRow.triggerMode !== "event") {
      return false;
    }
    if (autoRow.triggerKey === "order.created") {
      return step.kind === "initial";
    }
    if (autoRow.triggerKey === "order.status_changed") {
      const conditionsTree = parseJsonSafe<AutomationConditionTree>(
        versionRow.conditionsJson,
        EMPTY_CONDITION_TREE,
      );
      return conditionsBindSpecificallyToStep(conditionsTree, step.key);
    }
    return false;
  }

  function toBoundAutomationView(
    autoRow: typeof automations.$inferSelect,
    versionRow: typeof automationVersions.$inferSelect,
  ): OrderStageBoundAutomationView {
    const persistedActions = parseJsonSafe<PersistedActionStep[]>(versionRow.actionsJson, []);
    const actionLabels = persistedActions.map((step) => {
      if (step.label && step.label.trim().length > 0) return step.label.trim();
      const registered = actionMap.get(step.actionKey);
      return registered?.label ?? step.actionKey;
    });
    return {
      publicId: autoRow.publicId,
      name: autoRow.name,
      description: autoRow.description ?? null,
      version: versionRow.version,
      triggerKey: autoRow.triggerKey ?? "order.status_changed",
      actionCount: persistedActions.length,
      actionLabels,
    };
  }

  async function loadLatestVersionsByAutomationId(
    dbOrTx: typeof db | Tx,
    autoRows: ReadonlyArray<typeof automations.$inferSelect>,
  ): Promise<Map<number, typeof automationVersions.$inferSelect>> {
    const byAutoId = new Map<number, typeof automationVersions.$inferSelect>();
    if (autoRows.length === 0) return byAutoId;
    const autoIds = autoRows.map((r) => r.id);
    const verRows = await dbOrTx
      .select()
      .from(automationVersions)
      .where(inArray(automationVersions.automationId, autoIds));
    const targetVersionByAutoId = new Map(autoRows.map((r) => [r.id, r.version]));
    for (const v of verRows) {
      if (targetVersionByAutoId.get(v.automationId) === v.version) {
        byAutoId.set(v.automationId, v);
      }
    }
    return byAutoId;
  }

  async function getOrderStageActions(
    principal: SessionPrincipal,
    input: { orderPublicId: string; runLimit?: number },
  ): Promise<OrderStageActionsView> {
    await assertAutomationsCapabilityPreflight(deps, principal, "orders.automations.run");
    if (!ULID_PATTERN.test(input.orderPublicId)) {
      throw validation("INVALID_ORDER_ID", "Order identifier is invalid.");
    }
    syncStaticRegistrations();

    const ordersSvc = requireOrdersService();
    const access = await ordersSvc.assertCanReadOrder(principal, input.orderPublicId);
    const bound = await ordersSvc.workflows.byVersionId(db, access.workflowVersionId);
    const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);

    const candidateAutos = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.enabled, true),
          eq(automations.triggerMode, "event"),
          inArray(automations.triggerKey, ["order.created", "order.status_changed"]),
        ),
      )
      .orderBy(asc(automations.sortOrder), asc(automations.id));

    const verByAutoId = await loadLatestVersionsByAutomationId(db, candidateAutos);

    const steps: OrderStageStepView[] = bound.definition.states.map((state) => {
      const boundViews: OrderStageBoundAutomationView[] = [];
      let configuredActionCount = 0;
      for (const autoRow of candidateAutos) {
        const verRow = verByAutoId.get(autoRow.id);
        if (!verRow) continue;
        if (automationBindsToWorkflowStep(autoRow, verRow, state)) {
          const view = toBoundAutomationView(autoRow, verRow);
          boundViews.push(view);
          configuredActionCount += view.actionCount;
        }
      }
      return {
        stepKey: state.key,
        label: state.label,
        customerLabel: state.customerLabel,
        kind: state.kind,
        tone: state.tone,
        phaseKey: state.phase ?? null,
        isCurrentOrderStep: access.statusKey === state.key,
        configuredAutomationCount: boundViews.length,
        configuredActionCount,
        automations: boundViews,
      };
    });

    const runLimit = Math.min(Math.max(input.runLimit ?? 20, 1), 50);
    const runRows = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.orderPublicId, access.publicId))
      .orderBy(desc(automationRuns.id))
      .limit(runLimit);
    const recentRuns = await hydrateRunViews(runRows);
    const phaseSection = await buildOrderPhaseBundleSection(
      deps,
      access.publicId,
      bound,
      runLimit,
    );

    return {
      orderPublicId: access.publicId,
      orderReference: access.reference,
      currentStatusKey: access.statusKey,
      currentStageKey: phaseSection.currentStageKey,
      progressPercent: phaseSection.progressPercent,
      completionRevision: phaseSection.completionRevision,
      workflowKey: bound.workflowKey,
      workflowVersionNumber: bound.versionNumber,
      workflowFormat: phaseSection.workflowFormat,
      engineEnabled: cfg.enabled,
      engineDisabledReason: cfg.enabled ? null : ENGINE_DISABLED_STAGE_MESSAGE,
      stageBundlesEnabled: cfg.stageBundlesEnabled,
      stageBundlesDisabledReason: cfg.stageBundlesEnabled ? null : STAGE_BUNDLES_DISABLED_MESSAGE,
      settingsPath: "/admin/automations",
      canManageAutomations: roleHasCapability(principal.role, "automations.manage"),
      canRunStageBundles: roleHasCapability(principal.role, "orders.stage.run"),
      canTransitionOrder: roleHasCapability(principal.role, "orders.transition"),
      canOverrideStatus: principal.role === "admin",
      canCancelCompletionJobs: principal.role === "admin",
      requiresStepUp: true,
      stages: phaseSection.stages,
      steps,
      recentStageRuns: phaseSection.recentStageRuns,
      recentCompletionJobs: phaseSection.recentCompletionJobs,
      recentRuns,
    };
  }

  async function listOrderStageRuns(
    principal: SessionPrincipal,
    input: { orderPublicId: string; cursor?: string; limit?: number },
  ): Promise<{ items: AutomationRunView[]; nextCursor: string | null }> {
    await assertAutomationsCapabilityPreflight(deps, principal, "orders.automations.run");
    if (!ULID_PATTERN.test(input.orderPublicId)) {
      throw validation("INVALID_ORDER_ID", "Order identifier is invalid.");
    }
    const ordersSvc = requireOrdersService();
    const access = await ordersSvc.assertCanReadOrder(principal, input.orderPublicId);

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const beforeId = decodeIdCursor(input.cursor);

    const rows = await db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.orderPublicId, access.publicId),
          beforeId !== undefined ? lt(automationRuns.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(automationRuns.id))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;
    const items = await hydrateRunViews(slice);
    return { items, nextCursor };
  }

  async function runForOrder(
    principal: SessionPrincipal,
    input: { orderPublicId: string; stepKey: string; idempotencyKey: string },
  ): Promise<OrderStageActionsRunResult> {
    await assertAutomationsCapabilityPreflight(deps, principal, "orders.automations.run");
    if (!ULID_PATTERN.test(input.orderPublicId)) {
      throw validation("INVALID_ORDER_ID", "Order identifier is invalid.");
    }
    const stepKey = input.stepKey.trim();
    if (!STAGE_STEP_KEY_RE.test(stepKey)) {
      throw validation("INVALID_STEP_KEY", "Workflow step key is invalid.");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (!STAGE_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw validation(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency key must be 8–64 URL-safe characters.",
      );
    }

    syncStaticRegistrations();
    const ordersSvc = requireOrdersService();
    const orderSummary = await ordersSvc.getOrderSummary(principal, input.orderPublicId);

    return db.transaction(async (tx) => {
      await assertAutomationsActorInTx(deps, principal, tx, "orders.automations.run");

      const cfg = await readSetting(settings, AUTOMATIONS_CONFIG, tx);
      if (!cfg.enabled) {
        throw new DomainError(
          "NOT_CONFIGURED",
          "AUTOMATIONS_DISABLED",
          ENGINE_DISABLED_STAGE_MESSAGE,
        );
      }

      const access = await ordersSvc.assertCanReadOrder(principal, input.orderPublicId, { tx });
      const bound = await ordersSvc.workflows.byVersionId(tx, access.workflowVersionId);
      const step = bound.definition.states.find((s) => s.key === stepKey);
      if (!step) {
        throw notFound("WORKFLOW_STEP_NOT_FOUND");
      }

      const candidateAutos = await tx
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.enabled, true),
            eq(automations.triggerMode, "event"),
            inArray(automations.triggerKey, ["order.created", "order.status_changed"]),
          ),
        )
        .orderBy(asc(automations.sortOrder), asc(automations.id))
        .for("update");

      const verByAutoId = await loadLatestVersionsByAutomationId(tx, candidateAutos);
      const boundAutos: Array<{
        autoRow: typeof automations.$inferSelect;
        verRow: typeof automationVersions.$inferSelect;
      }> = [];
      for (const autoRow of candidateAutos) {
        const verRow = verByAutoId.get(autoRow.id);
        if (!verRow) continue;
        if (automationBindsToWorkflowStep(autoRow, verRow, step)) {
          boundAutos.push({ autoRow, verRow });
        }
      }

      if (boundAutos.length === 0) {
        throw validation(
          "NO_STAGE_ACTIONS_CONFIGURED",
          `No enabled automations are bound to workflow step "${step.label}".`,
        );
      }

      const orderLink = new URL(`/orders/${access.publicId}`, deps.config.canonicalOrigin).href;
      const sampleFields: Record<string, AutomationScalarValue> = {
        order_public_id: access.publicId,
        order_reference: access.reference,
        order_status_label: step.customerLabel,
        order_link: orderLink,
        currency: orderSummary.currency,
        total_minor: orderSummary.totalMinor,
        on_behalf: false,
        from_status: access.statusKey,
        to_status: step.key,
        actor_role: principal.role,
      };

      const queuedRuns: {
        runPublicId: string;
        automationPublicId: string;
        automationName: string;
        jobId: string;
        deduplicated: boolean;
      }[] = [];
      let newlyCreatedCount = 0;

      for (const { autoRow, verRow } of boundAutos) {
        const dedupKey = `stage:${sha256Hex(
          `${access.publicId}:${step.key}:${autoRow.publicId}:${idempotencyKey}`,
        )}`;
        const queued = await createQueuedRunInTx(tx, {
          automationRow: autoRow,
          versionRow: verRow,
          triggerMode: "manual",
          triggerKey: autoRow.triggerKey,
          triggerEventId: null,
          orderPublicId: access.publicId,
          stageStepKey: step.key,
          triggeredByUserId: principal.userId,
          dedupKey,
          isTest: false,
          snapshot: {
            orderPublicId: access.publicId,
            actorUserId: principal.userId,
            sampleFields,
          },
        });
        if (queued.created) {
          newlyCreatedCount += 1;
        }
        queuedRuns.push({
          runPublicId: queued.runPublicId,
          automationPublicId: autoRow.publicId,
          automationName: autoRow.name,
          jobId: queued.jobId,
          deduplicated: !queued.created,
        });
      }

      if (newlyCreatedCount > 0) {
        const firstNewRun = queuedRuns.find((r) => !r.deduplicated) ?? queuedRuns[0]!;
        await audit.record(
          {
            category: "admin",
            eventName: "order.stage_actions.run",
            action: "execute",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order", publicId: access.publicId },
            orderPublicId: access.publicId,
            correlationId: automationCorrelationId(firstNewRun.runPublicId),
            safeCounts: {
              queued_runs: newlyCreatedCount,
              bound_automations: boundAutos.length,
            },
            attributes: {
              order_public_id: access.publicId,
              step_key: step.key,
            },
          },
          tx,
        );
      }

      return {
        orderPublicId: access.publicId,
        stepKey: step.key,
        queuedRuns,
      };
    });
  }

  /* --------------------------------------------------- Module lifecycle */

  function syncStaticRegistrations(): void {
    const latestStatic = getStaticAutomationRegistrations();
    for (const [k, t] of latestStatic.triggers.entries()) {
      triggerMap.set(k, t);
    }
    for (const [k, a] of latestStatic.actions.entries()) {
      assertAllowedActionKey(k);
      actionMap.set(k, a);
    }
  }

  function listTriggerCatalogue(): readonly TriggerCatalogueEntry[] {
    syncStaticRegistrations();
    return allTriggerEntries();
  }

  function matchingTriggersForEvent(event: AuditTapEvent): readonly TriggerCatalogueEntry[] {
    syncStaticRegistrations();
    return entriesMatchingTapEvent(event);
  }

  async function resolveTriggerEventFields(input: {
    triggerKey: string;
    event: AuditTapEvent;
    signal?: AbortSignal;
  }): Promise<{
    entry: TriggerCatalogueEntry;
    fields: Record<string, AutomationScalarValue>;
    orderPublicId: string | null;
    filePublicId: string | null;
    staffOnly: boolean;
  } | null> {
    syncStaticRegistrations();
    const entry = findTriggerEntry(input.triggerKey);
    if (!entry) return null;
    const controller = new AbortController();
    const signal = input.signal ?? controller.signal;
    const resolved = await resolveFullTriggerContext({
      triggerMode: "event",
      triggerKey: entry.key,
      snapshot: { event: input.event },
      signal,
    });
    const nonPersonalFields: Record<string, AutomationScalarValue> = {};
    const personalSet = new Set(
      entry.fields.filter((f) => f.personal).map((f) => f.key),
    );
    for (const [k, v] of Object.entries(resolved.fields)) {
      if (k === "recipient_name" || personalSet.has(k)) continue;
      nonPersonalFields[k] = v;
    }
    return {
      entry,
      fields: nonPersonalFields,
      orderPublicId: resolved.orderPublicId,
      filePublicId: resolved.filePublicId,
      staffOnly: resolved.staffOnlyTrigger,
    };
  }

  async function previewStageBundle(
    principal: SessionPrincipal,
    input: { orderPublicId: string; stageKey: string },
  ): Promise<OrderStageBundlePreviewView> {
    return previewOrderStageBundle(deps, principal, input);
  }

  async function runStageBundle(
    principal: SessionPrincipal,
    input: {
      orderPublicId: string;
      stageKey: string;
      idempotencyKey: string;
      confirmationToken: string;
      statusOverrideReason?: string | null;
    },
  ): Promise<RunOrderStageBundleResult> {
    return executeOrderStageBundle(deps, principal, input);
  }

  async function listStageBundleRuns(
    principal: SessionPrincipal,
    input: { orderPublicId: string; stageKey?: string; cursor?: string; limit?: number },
  ): Promise<{ items: OrderStageRunView[]; nextCursor: string | null }> {
    return listOrderStageBundleRuns(deps, principal, input);
  }

  async function listOrderCompletionJobs(
    principal: SessionPrincipal,
    input: {
      orderPublicId: string;
      stageKey?: string;
      state?: CompletionJobState;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: OrderCompletionJobView[]; nextCursor: string | null }> {
    return listOrderCompletionJobsForOrder(deps, principal, input);
  }

  async function cancelOrderCompletionJob(
    principal: SessionPrincipal,
    input: { completionJobPublicId: string; reason?: string | null },
  ): Promise<OrderCompletionJobView> {
    return cancelOrderCompletionJobByAdmin(deps, principal, input);
  }

  let orderListenerRegistered = false;

  return {
    registerAutomationTrigger,
    registerAutomationAction,
    listTriggerCatalogue,
    matchingTriggersForEvent,
    resolveTriggerEventFields,
    getCatalogue,
    getSettings,
    updateSettings,
    list,
    get,
    listVersions,
    create,
    update,
    setEnabled,
    duplicate,
    remove,
    reorder,
    triggerManual,
    testRun,
    listRuns,
    getRun,
    getOrderStageActions,
    listOrderStageRuns,
    runForOrder,
    previewStageBundle,
    runStageBundle,
    listStageBundleRuns,
    listOrderCompletionJobs,
    cancelOrderCompletionJob,

    init() {
      syncStaticRegistrations();
      ensureAutomationMailTemplateRegistered(deps.mailer);

      // Idempotent startup backfill of automations.sort_order = id * 10 where sort_order = 0.
      void Promise.resolve()
        .then(async () => {
          if (typeof (db as { update?: unknown }).update !== "function") return;
          await db
            .update(automations)
            .set({ sortOrder: sql`${automations.id} * 10` })
            .where(eq(automations.sortOrder, 0));
        })
        .catch(() => undefined);

      if (!orderListenerRegistered && deps.services.orders?.registerChangeListener) {
        deps.services.orders.registerChangeListener((event, tx) =>
          handleOrderChangeForCompletionJobs(deps, event, tx),
        );
        orderListenerRegistered = true;
      }

      if (!tapRegistered && deps.services.auditCenter?.registerTap) {
        deps.services.auditCenter.registerTap({
          listens(eventName: string): boolean {
            return tapGloballyEnabled && tapEnabledEventNames.has(eventName);
          },
          async onRecorded(event: AuditTapEvent, tx: Tx | undefined): Promise<void> {
            if (isAutomationOrigin(event.correlationId)) return;
            await jobs.enqueue<EvaluateEventJobPayload>(
              JOB_EVALUATE_EVENT,
              { event },
              {
                idempotencyKey: `auto:tap:${event.eventId}`,
                ...(event.correlationId ? { correlationId: event.correlationId } : {}),
                maxAttempts: 3,
              },
              tx,
            );
          },
        });
        tapRegistered = true;
      }
    },

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = clock.now();
      try {
        const cfg = await readSetting(settings, AUTOMATIONS_CONFIG);
        return [
          {
            component: "automations",
            state: "ok",
            summary: cfg.enabled ? "Automations engine enabled." : "Automations engine disabled.",
            metrics: { enabled: cfg.enabled ? 1 : 0 },
            checkedAt,
          },
        ];
      } catch {
        return [
          {
            component: "automations",
            state: "degraded",
            summary: "Automations settings could not be read.",
            checkedAt,
          },
        ];
      }
    },
  };
}
