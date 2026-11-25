/**
 * Increment 07 (D7) — Workflow Phase Webhooks & Lifecycle Auto-Queue Service
 * (`services.integrations.workflowWebhooks`).
 *
 * Enforces:
 *  - Safe option listing (`production:P101..P401` + named outbound subscriptions) with zero URL or secret exposure
 *  - Strict `STAGE_WEBHOOK_TARGET` validation at workflow draft save, publish, and automation rule save
 *  - Portable target resolution (`production:P101..P401` or `subscription:<name>`) for workflow import
 *  - Structured non-throwing `enqueueStageWebhook(input, tx)` so refused preconditions (`P101_NOT_DELIVERED`,
 *    `PHASE1_INTAKE_NOT_LOCKED`, `PRODUCTION_WEBHOOKS_NOT_ENABLED`, `WEBHOOKS_DISABLED`, etc.) record durable
 *    outcomes without rolling back a customer's payment confirmation or phase submission
 *  - Per-workflow opt-in lifecycle auto-queue via durable `AuditTap`:
 *      1. `order.payment_state.changed` (`to_state === "paid"`, skipping `PAYMENT_BACKFILL`) -> `P101`
 *      2. `order.stage.submitted` (matching the workflow's intake `submit_lock` phase) -> `P201`
 */
import { roleHasCapability } from "../../../../shared/capabilities.js";
import { STAGE_WEBHOOK_TARGET } from "../../../../shared/workflowStages.js";
import type { ModuleDeps } from "../../../container.js";
import { DomainError, forbidden, notFound, validation } from "../../../core/errors.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../../core/types.js";
import type { AuditTap, AuditTapEvent } from "../../audit/tap.js";
import { readSetting, writeSetting } from "../../platform/index.js";
import { assertIntegrationsManageInTx, assertIntegrationsManagePreflight } from "../authz.js";
import { PRODUCTION_PHASES, type ProductionPhase, type ProductionWebhookService } from "../production/index.js";
import {
  hasNoHeaderInjection,
  INTEGRATIONS_PRODUCTION_CONFIG,
  INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE,
} from "../settings.js";
import type { WebhooksService } from "../webhooks/index.js";
import type {
  EnqueueStageWebhookInput,
  EnqueueStageWebhookResult,
  ListWorkflowWebhookOptionsInput,
  WorkflowLifecycleAutoQueuePolicy,
  WorkflowWebhookOptionView,
  WorkflowWebhooksService,
  WorkflowWebhookValidationResult,
} from "./types.js";

const PRODUCTION_PHASE_LABELS: Record<ProductionPhase, string> = {
  P101: "Phase I — Intake Production (P101)",
  P201: "Phase II — Packet Assembly (P201)",
  P301: "Phase III — Quality & Review (P301)",
  P401: "Phase IV — Release & Delivery (P401)",
};

const LIFECYCLE_TAP_EVENTS = new Set<string>([
  "order.payment_state.changed",
  "order.stage.submitted",
]);

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{8,120}$/;

function parseTargetKey(
  raw: string,
):
  | { kind: "production"; phase: ProductionPhase; normalizedKey: string }
  | { kind: "subscription"; subscriptionPublicId: string; normalizedKey: string }
  | null {
  const trimmed = raw.trim();
  if (!STAGE_WEBHOOK_TARGET.test(trimmed)) return null;
  if (trimmed.startsWith("production:")) {
    const phase = trimmed.slice("production:".length) as ProductionPhase;
    if (!PRODUCTION_PHASES.includes(phase)) return null;
    return { kind: "production", phase, normalizedKey: trimmed };
  }
  if (trimmed.startsWith("subscription:")) {
    const subscriptionPublicId = trimmed.slice("subscription:".length);
    return { kind: "subscription", subscriptionPublicId, normalizedKey: trimmed };
  }
  return null;
}

function assertCanReadWorkflowWebhookOptions(principal: SessionPrincipal | null | undefined): void {
  if (!principal) {
    throw new DomainError("UNAUTHENTICATED", "SESSION_REQUIRED", "Authentication is required.");
  }
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  const allowed =
    roleHasCapability(principal.role, "workflows.manage") ||
    roleHasCapability(principal.role, "automations.read") ||
    roleHasCapability(principal.role, "orders.stage.run") ||
    roleHasCapability(principal.role, "integrations.manage") ||
    roleHasCapability(principal.role, "webhooks.manage");
  if (!allowed) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
}

export interface CreateWorkflowWebhooksServiceOptions {
  production: ProductionWebhookService;
  webhooks: WebhooksService;
}

export function createWorkflowWebhooksService(
  deps: ModuleDeps,
  ports: CreateWorkflowWebhooksServiceOptions,
): WorkflowWebhooksService & { init(): void; readonly auditTap: AuditTap } {
  const { production, webhooks } = ports;
  let tapRegistered = false;

  async function runEnqueueInTx(
    input: EnqueueStageWebhookInput,
    tx: Tx,
  ): Promise<EnqueueStageWebhookResult> {
    const idempotencyKey = input.idempotencyKey?.trim() ?? "";
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey) || !hasNoHeaderInjection(idempotencyKey)) {
      return {
        outcome: "refused_precondition",
        kind: null,
        deliveryPublicId: null,
        dispatchPublicId: null,
        reasonCode: "INVALID_IDEMPOTENCY_KEY",
        message: "Webhook idempotency key must be 8 to 120 printable ASCII characters.",
      };
    }

    const parsed = parseTargetKey(input.targetKey ?? "");
    if (!parsed) {
      return {
        outcome: "refused_precondition",
        kind: null,
        deliveryPublicId: null,
        dispatchPublicId: null,
        reasonCode: "STAGE_WEBHOOK_TARGET_INVALID",
        message: "Webhook target must be production:P101..P401 or subscription:<ULID>.",
      };
    }

    if (parsed.kind === "production") {
      const orderPublicId = input.orderPublicId?.trim() ?? "";
      if (!orderPublicId) {
        return {
          outcome: "refused_precondition",
          kind: "production",
          deliveryPublicId: null,
          dispatchPublicId: null,
          reasonCode: "ORDER_REQUIRED_FOR_PRODUCTION_WEBHOOK",
          message: `Production webhook ${parsed.phase} requires an order context.`,
        };
      }

      const prodRes = await production.enqueueWorkflowDispatch(
        {
          phase: parsed.phase,
          orderPublicId,
          stageKey: input.stageKey ?? null,
          triggerSource: input.triggerSource,
          idempotencyKey,
          correlationId: input.correlationId,
          actor: null,
          releaseStatus: input.releaseStatus ?? null,
          bypassPaymentStageCheck: input.triggerSource === "lifecycle_payment_confirmed",
        },
        tx,
      );

      return {
        outcome: prodRes.outcome,
        kind: "production",
        deliveryPublicId: prodRes.dispatchPublicId,
        dispatchPublicId: prodRes.dispatchPublicId,
        reasonCode: prodRes.reasonCode,
        message:
          prodRes.message ??
          (prodRes.outcome === "queued"
            ? `Queued ${parsed.phase} production webhook dispatch.`
            : `${parsed.phase} production webhook outcome: ${prodRes.outcome}.`),
      };
    }

    const subRes = await webhooks.enqueueWorkflowSubscription(
      {
        subscriptionPublicId: parsed.subscriptionPublicId,
        orderPublicId: input.orderPublicId?.trim() || null,
        stageKey: input.stageKey ?? null,
        triggerSource: input.triggerSource,
        idempotencyKey,
        correlationId: input.correlationId,
        actor: null,
        actorPublicId: input.actorPublicId ?? null,
        eventKey: input.eventKey ?? null,
        payload: input.payload ?? {},
      },
      tx,
    );

    return {
      outcome: subRes.outcome,
      kind: "subscription",
      deliveryPublicId: subRes.deliveryPublicId,
      dispatchPublicId: subRes.deliveryPublicId,
      reasonCode: subRes.reasonCode,
      message:
        subRes.message ??
        (subRes.outcome === "queued"
          ? "Queued outbound subscription webhook delivery."
          : `Subscription webhook outcome: ${subRes.outcome}.`),
    };
  }

  const auditTap: AuditTap = {
    listens(eventName: string): boolean {
      return LIFECYCLE_TAP_EVENTS.has(eventName);
    },

    async onRecorded(event: AuditTapEvent, tx: Tx | undefined): Promise<void> {
      if (!tx || event.outcome !== "completed") return;
      const orderPublicId =
        event.resource?.type === "order" && event.resource.publicId
          ? event.resource.publicId
          : typeof event.attributes.order_public_id === "string"
            ? event.attributes.order_public_id
            : null;
      if (!orderPublicId) return;

      if (event.eventName === "order.payment_state.changed") {
        // Never fire retroactively on migration/startup payment backfill (`stageStartup.ts`).
        if (event.reasonCode === "PAYMENT_BACKFILL" || event.attributes.ref === "backfill") {
          return;
        }
        if (event.attributes.to_state !== "paid") {
          return;
        }
        const autoCfg = await production.getWorkflowAutoQueueForOrderInTx(orderPublicId, tx);
        if (!autoCfg.p101OnPaymentConfirmed) {
          return;
        }
        await production.enqueueWorkflowDispatch(
          {
            phase: "P101",
            orderPublicId,
            stageKey: null,
            triggerSource: "lifecycle_payment_confirmed",
            idempotencyKey: `lifecycle:p101:${orderPublicId}`,
            correlationId: event.correlationId ?? undefined,
            actor: null,
            releaseStatus: "payment_confirmed",
            bypassPaymentStageCheck: true,
          },
          tx,
        );
        return;
      }

      if (event.eventName === "order.stage.submitted") {
        const submittedStageKey =
          typeof event.attributes.stage_key === "string" ? event.attributes.stage_key : null;
        if (!submittedStageKey) return;
        const autoCfg = await production.getWorkflowAutoQueueForOrderInTx(orderPublicId, tx);
        if (!autoCfg.p201OnPhase1Locked) {
          return;
        }
        if (autoCfg.intakeStageKey && submittedStageKey !== autoCfg.intakeStageKey) {
          return;
        }
        await production.enqueueWorkflowDispatch(
          {
            phase: "P201",
            orderPublicId,
            stageKey: submittedStageKey,
            triggerSource: "lifecycle_phase1_locked",
            idempotencyKey: `lifecycle:p201:${orderPublicId}:${submittedStageKey}`,
            correlationId: event.correlationId ?? undefined,
            actor: null,
          },
          tx,
        );
      }
    },
  };

  return {
    auditTap,

    init(): void {
      if (!tapRegistered && deps.services.auditCenter?.registerTap) {
        deps.services.auditCenter.registerTap(auditTap);
        tapRegistered = true;
      }
    },

    async listOptionsForActor(
      principal: SessionPrincipal | null | undefined,
      input?: ListWorkflowWebhookOptionsInput,
    ): Promise<WorkflowWebhookOptionView[]> {
      assertCanReadWorkflowWebhookOptions(principal);
      return this.listOptions(input);
    },

    async listOptions(
      input?: ListWorkflowWebhookOptionsInput,
      tx?: DbOrTx,
    ): Promise<WorkflowWebhookOptionView[]> {
      const filterKind = input?.kind ?? "all";
      const options: WorkflowWebhookOptionView[] = [];

      if (filterKind === "all" || filterKind === "production") {
        const [prodCfg, ...phaseStatuses] = await Promise.all([
          readSetting(deps.settings, INTEGRATIONS_PRODUCTION_CONFIG, tx as Tx | undefined),
          ...PRODUCTION_PHASES.map((phase) =>
            production.getTargetStatus(phase, tx as Tx | undefined),
          ),
        ]);
        for (let i = 0; i < PRODUCTION_PHASES.length; i += 1) {
          const phase = PRODUCTION_PHASES[i]!;
          const st = phaseStatuses[i]!;
          const targetKey = `production:${phase}`;
          const configured = st.configured && st.endpointConfigured;
          options.push({
            targetKey,
            kind: "production",
            phase,
            subscriptionPublicId: null,
            label: PRODUCTION_PHASE_LABELS[phase],
            configured,
            enabled: st.enabled && configured,
            signingEnabled: prodCfg.signingEnabled,
            portableRef: targetKey,
          });
        }
      }

      if (filterKind === "all" || filterKind === "subscription") {
        const subs = await webhooks.listSubscriptionTargetsForPicker(tx);
        for (const sub of subs) {
          options.push({
            targetKey: `subscription:${sub.publicId}`,
            kind: "subscription",
            phase: null,
            subscriptionPublicId: sub.publicId,
            label: sub.name,
            configured: true,
            enabled: sub.webhooksEnabled && sub.status === "active",
            signingEnabled: sub.signingEnabled,
            portableRef: `subscription:${sub.name}`,
          });
        }
      }

      return options;
    },

    async validateTargetKey(
      targetKey: string | null | undefined,
      tx?: DbOrTx,
    ): Promise<WorkflowWebhookValidationResult> {
      if (targetKey === null || targetKey === undefined || targetKey.trim() === "") {
        return {
          valid: true,
          normalizedKey: null,
          kind: null,
          exists: true,
          configured: true,
          enabled: true,
          reasonCode: null,
          message: null,
          portableRef: null,
        };
      }

      const parsed = parseTargetKey(targetKey);
      if (!parsed) {
        return {
          valid: false,
          normalizedKey: null,
          kind: null,
          exists: false,
          configured: false,
          enabled: false,
          reasonCode: "STAGE_WEBHOOK_TARGET_INVALID",
          message: "Choose a valid production phase webhook (P101–P401) or outbound subscription.",
          portableRef: null,
        };
      }

      if (parsed.kind === "production") {
        const st = await production.getTargetStatus(parsed.phase, tx as Tx | undefined);
        const configured = st.configured && st.endpointConfigured;
        const enabled = st.enabled && configured;
        let reasonCode: string | null = null;
        let message: string | null = null;
        if (!st.endpointConfigured) {
          reasonCode = `${parsed.phase}_ENDPOINT_NOT_CONFIGURED`;
          message = `${PRODUCTION_PHASE_LABELS[parsed.phase]} destination URL is not configured in Integrations -> Production.`;
        } else if (!st.configured) {
          reasonCode = "PRODUCTION_CONFIG_INCOMPLETE";
          message = "Production webhook parameters are incomplete in Integrations -> Production.";
        } else if (!st.enabled) {
          reasonCode = "PRODUCTION_DISABLED";
          message = "Production webhooks are currently disabled in Integrations -> Production.";
        }
        return {
          valid: true,
          normalizedKey: parsed.normalizedKey,
          kind: "production",
          exists: true,
          configured,
          enabled,
          reasonCode,
          message,
          portableRef: parsed.normalizedKey,
        };
      }

      const sub = await webhooks.getSubscriptionTargetStatus(parsed.subscriptionPublicId, tx);
      if (!sub.exists) {
        return {
          valid: false,
          normalizedKey: parsed.normalizedKey,
          kind: "subscription",
          exists: false,
          configured: false,
          enabled: false,
          reasonCode: "STAGE_WEBHOOK_TARGET_NOT_FOUND",
          message: "The selected outbound webhook subscription no longer exists.",
          portableRef: null,
        };
      }

      const enabled = sub.webhooksEnabled && sub.status === "active";
      let reasonCode: string | null = null;
      let message: string | null = null;
      if (!sub.webhooksEnabled) {
        reasonCode = "WEBHOOKS_DISABLED";
        message = "Outbound webhook subscriptions are currently disabled in Integrations -> Webhooks.";
      } else if (sub.status !== "active") {
        reasonCode = sub.status === "disabled_failing" ? "SUBSCRIPTION_DISABLED_FAILING" : "SUBSCRIPTION_PAUSED";
        message = `Webhook subscription "${sub.name}" is currently ${sub.status}.`;
      }

      return {
        valid: true,
        normalizedKey: parsed.normalizedKey,
        kind: "subscription",
        exists: true,
        configured: true,
        enabled,
        reasonCode,
        message,
        portableRef: `subscription:${sub.name ?? parsed.subscriptionPublicId}`,
      };
    },

    async resolvePortableTargetRef(
      portableRef: string | null | undefined,
      tx?: DbOrTx,
    ): Promise<{ targetKey: string | null; warningCode: string | null }> {
      if (!portableRef || portableRef.trim() === "") {
        return { targetKey: null, warningCode: null };
      }
      const trimmed = portableRef.trim();
      if (trimmed.startsWith("production:")) {
        const parsed = parseTargetKey(trimmed);
        if (parsed && parsed.kind === "production") {
          return { targetKey: parsed.normalizedKey, warningCode: null };
        }
        return { targetKey: null, warningCode: "UNKNOWN_PRODUCTION_WEBHOOK_PHASE" };
      }

      const direct = parseTargetKey(trimmed);
      if (direct && direct.kind === "subscription") {
        const check = await webhooks.getSubscriptionTargetStatus(direct.subscriptionPublicId, tx);
        if (check.exists) {
          return { targetKey: direct.normalizedKey, warningCode: null };
        }
        return { targetKey: null, warningCode: "WEBHOOK_SUBSCRIPTION_NOT_FOUND" };
      }

      const lookupName = trimmed.startsWith("subscription:")
        ? trimmed.slice("subscription:".length).trim()
        : trimmed;
      if (!lookupName) {
        return { targetKey: null, warningCode: "WEBHOOK_SUBSCRIPTION_NOT_FOUND" };
      }
      const subs = await webhooks.listSubscriptionTargetsForPicker(tx);
      const matched = subs.filter((s) => s.name.toLowerCase() === lookupName.toLowerCase());
      if (matched.length === 1) {
        return { targetKey: `subscription:${matched[0]!.publicId}`, warningCode: null };
      }
      if (matched.length > 1) {
        return { targetKey: null, warningCode: "WEBHOOK_SUBSCRIPTION_AMBIGUOUS" };
      }
      return { targetKey: null, warningCode: "WEBHOOK_SUBSCRIPTION_NOT_FOUND" };
    },

    async enqueueStageWebhook(
      input: EnqueueStageWebhookInput,
      tx?: Tx,
    ): Promise<EnqueueStageWebhookResult> {
      if (tx) {
        return runEnqueueInTx(input, tx);
      }
      return deps.db.transaction((innerTx) => runEnqueueInTx(input, innerTx));
    },

    async listLifecycleAutoQueuePolicies(tx?: Tx): Promise<WorkflowLifecycleAutoQueuePolicy[]> {
      const map = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE, tx);
      const workflows = deps.services.orders?.workflows?.list
        ? await deps.services.orders.workflows.list()
        : [];
      if (workflows.length > 0) {
        return workflows.map((wf) => {
          const entry =
            map[wf.publicId] ??
            Object.values(map).find((v) => v.workflowKey === wf.workflowKey);
          return {
            workflowKey: wf.workflowKey,
            p101OnPaymentConfirmed: entry?.p101OnPaymentConfirmed ?? false,
            p201OnPhase1Locked: entry?.p201OnPhase1Locked ?? false,
            updatedAt: entry?.updatedAt ?? null,
          };
        });
      }
      return Object.entries(map).map(([key, entry]) => ({
        workflowKey: entry.workflowKey ?? key,
        p101OnPaymentConfirmed: entry.p101OnPaymentConfirmed,
        p201OnPhase1Locked: entry.p201OnPhase1Locked,
        updatedAt: entry.updatedAt,
      }));
    },

    async getLifecycleAutoQueuePolicy(
      workflowKey: string,
      tx?: Tx,
    ): Promise<WorkflowLifecycleAutoQueuePolicy> {
      const cleanKey = workflowKey.trim();
      const map = await readSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE, tx);
      const entry =
        Object.values(map).find((v) => v.workflowKey === cleanKey) ?? map[cleanKey];
      return {
        workflowKey: cleanKey,
        p101OnPaymentConfirmed: entry?.p101OnPaymentConfirmed ?? false,
        p201OnPhase1Locked: entry?.p201OnPhase1Locked ?? false,
        updatedAt: entry?.updatedAt ?? null,
      };
    },

    async setLifecycleAutoQueuePolicy(
      principal: SessionPrincipal | null | undefined,
      input: {
        workflowKey: string;
        p101OnPaymentConfirmed: boolean;
        p201OnPhase1Locked: boolean;
      },
    ): Promise<WorkflowLifecycleAutoQueuePolicy> {
      if (!principal) {
        throw new DomainError("UNAUTHENTICATED", "SESSION_REQUIRED", "Authentication is required.");
      }
      const cleanKey = input.workflowKey.trim();
      if (!cleanKey || cleanKey.length > 64 || !hasNoHeaderInjection(cleanKey)) {
        throw validation("INVALID_WORKFLOW_KEY", "Provide a valid workflow key.");
      }
      assertIntegrationsManagePreflight(principal, deps.clock.now());

      const workflows = deps.services.orders?.workflows?.list
        ? await deps.services.orders.workflows.list()
        : [];
      const matchedWf = workflows.find(
        (wf) => wf.workflowKey === cleanKey || wf.publicId === cleanKey,
      );
      if (workflows.length > 0 && !matchedWf) {
        throw notFound("WORKFLOW_NOT_FOUND");
      }
      const storageId = matchedWf?.publicId ?? cleanKey;
      const canonicalWorkflowKey = matchedWf?.workflowKey ?? cleanKey;

      let updatedAtIso = "";
      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const currentMap = await readSetting(
          deps.settings,
          INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE,
          tx,
        );
        updatedAtIso = deps.clock.now().toISOString();
        const nextMap = {
          ...currentMap,
          [storageId]: {
            workflowKey: canonicalWorkflowKey,
            p101OnPaymentConfirmed: input.p101OnPaymentConfirmed,
            p201OnPhase1Locked: input.p201OnPhase1Locked,
            updatedAt: updatedAtIso,
          },
        };
        await writeSetting(deps.settings, INTEGRATIONS_PRODUCTION_WORKFLOW_AUTO_QUEUE, nextMap, tx);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.production.workflow_auto_queue_updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "production_webhook",
            resource: { type: "order_workflow", publicId: storageId },
            attributes: {
              workflow_public_id: storageId,
              workflow_key: canonicalWorkflowKey,
              p101_on_payment_confirmed: input.p101OnPaymentConfirmed,
              p201_on_phase1_locked: input.p201OnPhase1Locked,
            },
          },
          tx,
        );
      });

      return {
        workflowKey: canonicalWorkflowKey,
        p101OnPaymentConfirmed: input.p101OnPaymentConfirmed,
        p201OnPhase1Locked: input.p201OnPhase1Locked,
        updatedAt: updatedAtIso,
      };
    },
  };
}
