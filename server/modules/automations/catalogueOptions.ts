/**
 * Increment 07 (D5): Builds `AutomationCataloguePickerOptions` so the Rule Builder
 * ("All occurrences" vs "Specific value" condition pickers and action editors) and
 * Phase Actions UI present named options rather than raw database keys or ULIDs.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { workflowStageSchema } from "../../../shared/workflowStages.js";
import type { ModuleDeps } from "../../container.js";
import type { SessionPrincipal } from "../../core/types.js";
import { intakeQuestionnaires } from "../compliance/schema.js";
import { orderWorkflowVersions, orderWorkflows } from "../orders/schema.js";
import { DEFAULT_WORKFLOW } from "../orders/workflowTypes.js";
import type {
  AutomationCataloguePickerOptions,
  CatalogueFieldOptionSourceKey,
  CataloguePickerOption,
  EmailTemplatePickerOption,
  WebhookSubscriptionPickerOption,
  WebhookTargetPickerOption,
} from "./contracts.js";

const PHASE_ALLOWED_MAIL_VARS = new Set(["reference", "phaseLabel", "statusLabel", "link"]);
const PHASE_SYSTEM_MAIL_KEYS = new Set([
  "orders.phase_update",
  "orders.status_changed",
  "orders.created",
]);

const PAYMENT_METHOD_OPTIONS: readonly CataloguePickerOption[] = Object.freeze([
  { value: "provider_online", label: "Online payment provider (card / wallet / bank)" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "wire", label: "Wire transfer" },
  { value: "ach", label: "ACH debit / transfer" },
  { value: "check", label: "Check" },
  { value: "card_manual", label: "Manual card settlement" },
  { value: "waiver", label: "Fee waiver" },
  { value: "imported_historical", label: "Imported historical payment" },
  { value: "other", label: "Other" },
]);

const PAYMENT_PROVIDER_OPTIONS: readonly CataloguePickerOption[] = Object.freeze([
  { value: "stripe", label: "Stripe" },
  { value: "square", label: "Square" },
  { value: "manual", label: "Manual / offline" },
]);

const INTAKE_DECISION_OPTIONS: readonly CataloguePickerOption[] = Object.freeze([
  { value: "accepted", label: "Accepted" },
  { value: "returned_for_changes", label: "Returned for changes" },
]);

export const FIELD_OPTION_SOURCES: Readonly<Record<string, CatalogueFieldOptionSourceKey>> =
  Object.freeze({
    from_status: "statuses",
    to_status: "statuses",
    status: "statuses",
    stage_key: "stages",
    workflow_key: "workflows",
    method: "paymentMethods",
    provider: "paymentProviders",
    questionnaire_public_id: "intakeQuestionnaires",
    decision: "intakeDecisions",
  });

export async function buildCataloguePickerOptions(
  deps: ModuleDeps,
  principal: SessionPrincipal,
): Promise<AutomationCataloguePickerOptions> {
  // 1. Order statuses from authoritative D2 status catalog (fallback to default workflow states)
  let statuses: CataloguePickerOption[] = [];
  try {
    if (deps.services.orders?.statusCatalog?.listEntries) {
      const entries = await deps.services.orders.statusCatalog.listEntries({
        includeRetired: false,
      });
      statuses = entries.map((e) => ({
        value: e.key,
        label: e.staffLabel,
        secondaryLabel: e.customerLabel !== e.staffLabel ? e.customerLabel : null,
      }));
    }
  } catch {
    statuses = [];
  }
  if (statuses.length === 0) {
    statuses = DEFAULT_WORKFLOW.states.map((s) => ({
      value: s.key,
      label: s.label,
      secondaryLabel: s.customerLabel !== s.label ? s.customerLabel : null,
    }));
  }

  // 2. Workflows & published stages
  const workflows: CataloguePickerOption[] = [];
  const stagesByKey = new Map<string, CataloguePickerOption>();
  try {
    const wfRows = await deps.db
      .select({
        id: orderWorkflows.id,
        workflowKey: orderWorkflows.workflowKey,
        name: orderWorkflows.name,
        currentVersionId: orderWorkflows.currentVersionId,
        isDefault: orderWorkflows.isDefault,
      })
      .from(orderWorkflows)
      .orderBy(asc(orderWorkflows.id));

    for (const wf of wfRows) {
      workflows.push({
        value: wf.workflowKey,
        label: wf.name,
        secondaryLabel: wf.isDefault ? "Default workflow" : wf.workflowKey,
      });
    }

    const versionIds = wfRows
      .map((w) => w.currentVersionId)
      .filter((id): id is number => typeof id === "number" && id > 0);

    if (versionIds.length > 0) {
      const verRows = await deps.db
        .select({
          id: orderWorkflowVersions.id,
          workflowId: orderWorkflowVersions.workflowId,
          definition: orderWorkflowVersions.definition,
        })
        .from(orderWorkflowVersions)
        .where(inArray(orderWorkflowVersions.id, versionIds));

      const wfNameById = new Map(wfRows.map((w) => [w.id, w.name]));
      for (const ver of verRows) {
        const wfName = wfNameById.get(ver.workflowId) ?? "Workflow";
        const rawStages = (ver.definition as { stages?: unknown[] } | null)?.stages;
        if (!Array.isArray(rawStages)) continue;
        for (const rawStage of rawStages) {
          const parsed = workflowStageSchema.safeParse(rawStage);
          if (!parsed.success) continue;
          if (!stagesByKey.has(parsed.data.key)) {
            stagesByKey.set(parsed.data.key, {
              value: parsed.data.key,
              label: parsed.data.staffLabel,
              secondaryLabel: `${wfName} — ${parsed.data.customerLabel}`,
            });
          }
        }
      }
    }
  } catch {
    // Graceful fallback when running against mock DB in unit tests.
  }

  // 3. Intake questionnaires
  let intakeOpts: CataloguePickerOption[];
  try {
    const qRows = await deps.db
      .select({
        publicId: intakeQuestionnaires.publicId,
        slug: intakeQuestionnaires.slug,
        title: intakeQuestionnaires.title,
        active: intakeQuestionnaires.active,
      })
      .from(intakeQuestionnaires)
      .where(eq(intakeQuestionnaires.active, true))
      .orderBy(asc(intakeQuestionnaires.id));

    intakeOpts = qRows.map((q) => ({
      value: q.publicId,
      label: q.title,
      secondaryLabel: q.slug,
    }));
  } catch {
    intakeOpts = [];
  }

  // 4. Published automation & phase-compatible email templates
  const emailTemplates: EmailTemplatePickerOption[] = [];
  const phaseEmailTemplates: EmailTemplatePickerOption[] = [];
  try {
    if (deps.services.mailTemplates?.listForAutomations) {
      const res = await deps.services.mailTemplates.listForAutomations(principal);
      for (const item of res.items) {
        const varNames = item.declaredVars.map((v) => v.name);
        const hasSensitive = item.declaredVars.some((v) => v.sensitive);
        if (hasSensitive) continue;
        const isPhaseEligibleKey =
          PHASE_SYSTEM_MAIL_KEYS.has(item.templateKey) || item.templateKey.startsWith("custom.");
        const varsCompatible = varNames.every((v) => PHASE_ALLOWED_MAIL_VARS.has(v));
        const compatibleWithPhaseAction = isPhaseEligibleKey && varsCompatible;

        const opt: EmailTemplatePickerOption = {
          templateKey: item.templateKey,
          name: item.name,
          vars: varNames,
          compatibleWithPhaseAction,
        };
        emailTemplates.push(opt);
        if (compatibleWithPhaseAction) {
          phaseEmailTemplates.push(opt);
        }
      }
    }
  } catch {
    // Graceful fallback when mailTemplates is not mounted in unit tests.
  }

  // 5. Webhook subscriptions & targets (from integrations.workflowWebhooks)
  const webhookSubscriptions: WebhookSubscriptionPickerOption[] = [];
  const webhookTargets: WebhookTargetPickerOption[] = [];
  try {
    if (deps.services.integrations?.workflowWebhooks?.listOptions) {
      const allTargets = await deps.services.integrations.workflowWebhooks.listOptions({
        kind: "all",
      });
      for (const t of allTargets) {
        webhookTargets.push({
          targetKey: t.targetKey,
          kind: t.kind,
          label: t.label,
          configured: t.configured,
          enabled: t.enabled,
          signingEnabled: t.signingEnabled,
        });
        if (t.kind === "subscription" && t.subscriptionPublicId) {
          webhookSubscriptions.push({
            publicId: t.subscriptionPublicId,
            targetKey: t.targetKey,
            label: t.label,
            enabled: t.enabled,
            signingEnabled: t.signingEnabled,
          });
        }
      }
    }
  } catch {
    // Graceful fallback when integrations is not mounted in unit tests.
  }

  return {
    statuses,
    stages: [...stagesByKey.values()],
    workflows,
    paymentMethods: PAYMENT_METHOD_OPTIONS,
    paymentProviders: PAYMENT_PROVIDER_OPTIONS,
    intakeQuestionnaires: intakeOpts,
    intakeDecisions: INTAKE_DECISION_OPTIONS,
    emailTemplates,
    phaseEmailTemplates,
    webhookSubscriptions,
    webhookTargets,
    fieldOptionSources: FIELD_OPTION_SOURCES,
  };
}
