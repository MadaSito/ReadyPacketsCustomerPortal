import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { UserRole } from "../../../shared/domain.js";
import {
  DEFAULT_STAGE_FILE_SYNC,
  DEFAULT_STAGE_FOLDERS,
} from "../../../shared/orderStageFileSync.js";
import { STAGE_COMPLETION_DELAY_MAX_MINUTES } from "../../../shared/workflowStages.js";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Db, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import { createAuditEmitter } from "../audit/emitter.js";
import { createAuditModule, type AuditModule } from "../audit/index.js";
import * as auditTables from "../audit/schema.js";
import * as complianceTables from "../compliance/schema.js";
import { createEngagementModule, type EngagementModule } from "../engagement/index.js";
import * as engagementTables from "../engagement/schema.js";
import { users, type UserStatus } from "../identity/schema.js";
import type { PublishedMailTemplate } from "../jobs/mailPorts.js";
import { createOpsAlertsModule, type OpsAlertsModule } from "../opsAlerts/index.js";
import * as opsAlertTables from "../opsAlerts/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import * as orderTables from "../orders/schema.js";
import { DEFAULT_WORKFLOW } from "../orders/workflowTypes.js";
import { platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import {
  AUTOMATIONS_CONFIG,
  JOB_APPLY_COMPLETION,
  JOB_EVALUATE_EVENT,
  JOB_EXECUTE_RUN,
  createAutomationsModule,
  type AutomationsModule,
} from "./index.js";
import { handleApplyCompletionJob } from "./completionJobs.js";
import { automationsRouter } from "./router.js";
import * as automationTables from "./schema.js";

const testSchema = {
  users,
  platformSettings,
  ...auditTables,
  ...orderTables,
  ...engagementTables,
  ...complianceTables,
  ...opsAlertTables,
  ...automationTables,
};

const appTestRouter = router({
  automations: automationsRouter,
});
const createCaller = createCallerFactory(appTestRouter);

interface SyntheticUser {
  id: number;
  publicId: string;
  email: string;
  name: string;
  role: UserRole;
  principal: SessionPrincipal;
}

let seq = 0;
function nextKey(prefix = "k"): string {
  seq += 1;
  return `${prefix}_${seq}_${Date.now()}`;
}

async function insertUser(
  h: TestHarness,
  db: Db,
  opts: {
    role?: UserRole;
    status?: UserStatus;
    name?: string;
    stepUp?: boolean;
  } = {},
): Promise<SyntheticUser> {
  seq += 1;
  const publicId = ulid(h.clock.now().getTime() + seq);
  const role = opts.role ?? "customer";
  const email = `d5.user.${seq}@synthetic.test`;
  const name = opts.name ?? `D5 Person ${seq}`;
  const customerRef = role === "customer" ? `CUST-D5-${String(seq).padStart(4, "0")}` : null;

  await db.insert(users).values({
    publicId,
    customerRef,
    role,
    status: opts.status ?? "active",
    emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
    emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
    emailVerifiedAt: h.clock.now(),
    nameEnc: h.deps.crypto.encrypt(name, `users.name:${publicId}`),
  });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.publicId, publicId));
  const principal = fakePrincipal({
    userId: row!.id,
    userPublicId: publicId,
    role,
    stepUpAt: opts.stepUp ? h.clock.now() : null,
    state: "full",
  });
  return { id: row!.id, publicId, email, name, role, principal };
}

interface CapturedStageWebhook {
  targetKey: string;
  orderPublicId: string | null;
  stageKey: string | null;
  triggerSource: "stage_bundle" | "automation_rule";
  idempotencyKey: string;
  eventKey: string;
  payload: Record<string, unknown>;
}

describe("automations module — Increment 07 D5 (Package F)", () => {
  let t: TestDb;
  let h: TestHarness;
  let auditCenter: AuditModule;
  let opsAlerts: OpsAlertsModule;
  let orders: OrdersModule;
  let engagement: EngagementModule;
  let automationsMod: AutomationsModule;

  let subscriptionPublicId: string;
  let webhookEnabled: boolean;
  let webhookConfigured: boolean;
  let templateAvailable: boolean;
  let capturedStageWebhooks: CapturedStageWebhook[];

  function callerFor(principal: SessionPrincipal | null) {
    const ctx: TrpcContext = {
      request: newRequestContext("test", { correlationId: ulid(h.clock.now().getTime()) }),
      services: h.services as Services,
      session: principal,
      transport: { issue: () => {}, clear: () => {} },
    };
    return createCaller(ctx);
  }

  async function drainAllJobs(): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      if (h.jobs.enqueued.length === 0) break;
      await h.jobs.runAll(JOB_EVALUATE_EVENT);
      await h.jobs.runAll(JOB_EXECUTE_RUN);
      await h.jobs.runAll(JOB_APPLY_COMPLETION);
    }
  }

  async function publishFormat3DefaultWorkflow(
    adminPrincipal: SessionPrincipal,
    opts?: {
      intakeStatusKey?: string;
      intakeCompletion?:
        | { kind: "fixed"; percent: number; delayMinutes: number }
        | { kind: "range"; min: number; max: number; delayMinutes: number };
      reviewStatusKey?: string;
      alertText?: string;
    },
  ) {
    const wfKey = `wf_d5_${++seq}`;
    const draft = await orders.workflows.createDraft(adminPrincipal, {
      from: "standard",
      workflowKey: wfKey,
      name: `Format 3 Workflow ${seq}`,
    });
    const fullDraft = await orders.workflows.getDraft(draft.publicId);
    const baseStates = DEFAULT_WORKFLOW.states;
    const s0 = baseStates[0]!.key; // submitted
    const s1 = baseStates[1]!.key; // in_review
    const s2 = baseStates[2]!.key; // needs_customer_input
    const restKeys = baseStates.slice(3).map((s) => s.key);
    const terminalKey = baseStates.find((s) => s.kind === "terminal")!.key;

    const { phases: _unusedPhases, ...baseDef } = fullDraft.definition;
    void _unusedPhases;
    const definition = {
      ...baseDef,
      stages: [
        {
          key: "intake_phase",
          customerLabel: "Intake Submission",
          staffLabel: "Phase 1 Intake",
          statusKeys: [s0],
          actions: {
            uploadDocuments: true,
            answerQuestions: true,
            recordAudio: false,
            uploadAudio: false,
            teamFileReview: false,
          },
          folders: { ...DEFAULT_STAGE_FOLDERS },
          fileSync: { ...DEFAULT_STAGE_FILE_SYNC },
          acknowledgement: { policy: "optional" as const },
          progression: "next" as const,
          adminTasks: ["run_automation" as const],
          completesOn: "manual" as const,
          weight: 30,
          stageActions: {
            setStatusKey: opts?.intakeStatusKey ?? s1,
            completion: opts?.intakeCompletion ?? {
              kind: "fixed" as const,
              percent: 35,
              delayMinutes: 0,
            },
            emailTemplateKey: "orders.phase_update",
            webhookTargetKey: `subscription:${subscriptionPublicId}`,
            dashboardAlert: {
              severity: "warning" as const,
              text: opts?.alertText ?? "Intake bundle executed by operator.",
            },
          },
        },
        {
          key: "review_phase",
          customerLabel: "Staff Review",
          staffLabel: "Phase 2 Review",
          statusKeys: [s1, s2],
          actions: {
            uploadDocuments: false,
            answerQuestions: false,
            recordAudio: false,
            uploadAudio: false,
            teamFileReview: true,
          },
          folders: { ...DEFAULT_STAGE_FOLDERS },
          fileSync: { ...DEFAULT_STAGE_FILE_SYNC },
          acknowledgement: { policy: "none" as const },
          progression: "next" as const,
          adminTasks: ["review_submission" as const, "run_automation" as const],
          completesOn: "manual" as const,
          weight: 35,
          stageActions: {
            // Non-adjacent jump (e.g. straight to terminal) requires admin override if not in transitions
            setStatusKey: opts?.reviewStatusKey ?? terminalKey,
            completion: {
              kind: "range" as const,
              min: 55,
              max: 75,
              delayMinutes: 20,
            },
          },
        },
        {
          key: "delivery_phase",
          customerLabel: "Final Delivery",
          staffLabel: "Phase 3 Delivery",
          statusKeys: restKeys,
          actions: {
            uploadDocuments: false,
            answerQuestions: false,
            recordAudio: false,
            uploadAudio: false,
            teamFileReview: false,
          },
          folders: { ...DEFAULT_STAGE_FOLDERS },
          fileSync: { ...DEFAULT_STAGE_FILE_SYNC },
          acknowledgement: { policy: "none" as const },
          progression: "next" as const,
          adminTasks: [],
          completesOn: "manual" as const,
          weight: 35,
          // Unconfigured stageActions on delivery_phase
        },
      ],
    };

    const saved = await orders.workflows.saveDraft(adminPrincipal, {
      draftId: draft.publicId,
      expectedVersion: draft.rowVersion,
      name: `Format 3 Workflow ${seq}`,
      definition,
    });
    expect(saved.publishable).toBe(true);

    const published = await orders.workflows.publishDraft(adminPrincipal, {
      draftId: draft.publicId,
      expectedVersion: saved.rowVersion,
      makeDefault: true,
      changeNote: "Initial format-3 publish",
    });
    const versions = await orders.workflows.listVersions(published.workflowPublicId);

    return {
      workflowPublicId: published.workflowPublicId,
      versionId: versions.versions[0]!.publicId,
      s0,
      s1,
      s2,
      terminalKey,
    };
  }

  async function placeCustomerOrder(
    adminPrincipal: SessionPrincipal,
    customerPrincipal: SessionPrincipal,
    projectName = "D5 Order",
  ) {
    const group = await orders.catalog.createGroup(adminPrincipal, {
      name: `Group ${nextKey("grp")}`,
      description: "Synthetic catalog group",
      sortOrder: 0,
      active: true,
    });
    const product = await orders.catalog.createProduct(adminPrincipal, {
      groupId: group.publicId,
      productKey: `prod-${++seq}`,
      sortOrder: 0,
      active: true,
      name: `Product ${seq}`,
      description: "Synthetic catalog product",
      features: ["Phase tracking"],
      priceMinor: 25_000,
      currency: "USD",
    });
    return orders.orders.create(customerPrincipal, {
      projectName,
      items: [{ productPublicId: product.publicId, quantity: 1 }],
      idempotencyKey: nextKey("ord"),
    });
  }

  beforeAll(async () => {
    t = await createTestDb({ schema: testSchema });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  beforeEach(async () => {
    const [tableRows] = await t.pool.query("SHOW TABLES");
    await t.pool.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const row of tableRows as Array<Record<string, string>>) {
      const tbl = Object.values(row)[0]!;
      await t.pool.query(`TRUNCATE TABLE \`${tbl}\``);
    }
    await t.pool.query("SET FOREIGN_KEY_CHECKS = 1");

    h = createTestDeps({ db: t.db });
    const durableAudit = createAuditEmitter({
      config: h.deps.config,
      db: t.db,
      clock: h.clock,
      logger: h.deps.logger,
      crypto: h.deps.crypto,
    });
    const realSettings = createSettingsStore({
      db: t.db,
      clock: h.clock,
      logger: h.deps.logger,
      crypto: h.deps.crypto,
      audit: durableAudit,
    });

    const mutableDeps = h.deps as unknown as Record<string, unknown>;
    const mutableServices = h.services as unknown as Record<string, unknown>;
    mutableDeps.audit = durableAudit;
    mutableDeps.settings = realSettings;
    mutableServices.audit = durableAudit;
    mutableServices.settings = realSettings;

    subscriptionPublicId = ulid(h.clock.now().getTime() + 999);
    webhookEnabled = true;
    webhookConfigured = true;
    templateAvailable = true;
    capturedStageWebhooks = [];

    mutableServices.identity = {
      async getUser(userId: number, opts?: { tx?: DbOrTx }) {
        const [row] = await (opts?.tx ?? t.db).select().from(users).where(eq(users.id, userId)).limit(1);
        if (!row) return null;
        return {
          id: row.id,
          publicId: row.publicId,
          customerRef: row.customerRef,
          role: row.role,
          status: row.status,
          email: h.deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`),
          name: h.deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`),
          emailVerified: row.emailVerifiedAt !== null,
        };
      },
      async getUserByPublicId(publicId: string, opts?: { tx?: DbOrTx }) {
        const [row] = await (opts?.tx ?? t.db).select().from(users).where(eq(users.publicId, publicId)).limit(1);
        if (!row) return null;
        return {
          id: row.id,
          publicId: row.publicId,
          customerRef: row.customerRef,
          role: row.role,
          status: row.status,
          email: h.deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`),
          name: h.deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`),
          emailVerified: row.emailVerifiedAt !== null,
        };
      },
      sessions: {
        assertCurrent: async (principal: SessionPrincipal, tx: Tx) => {
          const [u] = await tx.select().from(users).where(eq(users.id, principal.userId)).limit(1);
          if (!u || u.status !== "active" || u.role !== principal.role) {
            throw new DomainError(
              "UNAUTHENTICATED",
              "SESSION_NOT_CURRENT",
              "Your session is no longer active.",
            );
          }
          return {
            pendingSteps: [] as string[],
            role: u.role,
            stepUpAt: principal.stepUpAt,
            mfaVerifiedAt: principal.mfaVerifiedAt,
          };
        },
      },
    };
    mutableServices.files = {
      async listForOrder() {
        return [];
      },
    };

    const phaseTemplate: PublishedMailTemplate = {
      key: "orders.phase_update",
      vars: ["reference", "phaseLabel", "statusLabel", "link"],
      render(vars) {
        return {
          subject: `Update on ${String(vars.reference ?? "")}: ${String(vars.phaseLabel ?? "")}`,
          text: `Status is now ${String(vars.statusLabel ?? "")} (${String(vars.link ?? "")}).`,
        };
      },
    };
    h.mailer.registerTemplate({
      key: "orders.phase_update",
      vars: ["reference", "phaseLabel", "statusLabel", "link"],
      subject: (vars) => `Update on ${String(vars.reference ?? "")}: ${String(vars.phaseLabel ?? "")}`,
      text: (vars) => `Status is now ${String(vars.statusLabel ?? "")}.`,
    });

    mutableServices.mailTemplates = {
      async resolveForPhaseAction(key: string) {
        if (!templateAvailable || key !== "orders.phase_update") return null;
        return phaseTemplate;
      },
      async listForPhaseActions() {
        return templateAvailable
          ? [
              {
                templateKey: "orders.phase_update",
                name: "Phase Update Notice",
                vars: ["reference", "phaseLabel", "statusLabel", "link"],
              },
            ]
          : [];
      },
      async listForAutomations() {
        return {
          items: templateAvailable
            ? [
                {
                  templateKey: "orders.phase_update",
                  name: "Phase Update Notice",
                  category: "orders",
                  kind: "system",
                  declaredVars: [
                    { name: "reference", sensitive: false },
                    { name: "phaseLabel", sensitive: false },
                    { name: "statusLabel", sensitive: false },
                    { name: "link", sensitive: false },
                  ],
                },
              ]
            : [],
        };
      },
    };

    mutableServices.integrations = {
      egress: {
        async fetchPinned() {
          return { status: 200, headers: new Headers(), body: new Uint8Array() };
        },
      },
      workflowWebhooks: {
        async listOptions() {
          return [
            {
              targetKey: `subscription:${subscriptionPublicId}`,
              kind: "subscription" as const,
              label: "Primary Ops Subscription",
              configured: webhookConfigured,
              enabled: webhookEnabled,
              signingEnabled: true,
              subscriptionPublicId,
            },
            {
              targetKey: "production:P101",
              kind: "production" as const,
              label: "Production P101",
              configured: true,
              enabled: true,
              signingEnabled: true,
              productionWebhookId: "P101" as const,
            },
          ];
        },
        async listStageWebhookTargets() {
          return [
            {
              targetKey: `subscription:${subscriptionPublicId}`,
              kind: "subscription" as const,
              label: "Primary Ops Subscription",
              configured: webhookConfigured,
              enabled: webhookEnabled,
              signingEnabled: true,
              subscriptionPublicId,
            },
            {
              targetKey: "production:P101",
              kind: "production" as const,
              label: "Production P101",
              configured: true,
              enabled: true,
              signingEnabled: true,
              productionWebhookId: "P101" as const,
            },
          ];
        },
        async validateTargetKey(targetKey: string) {
          if (targetKey === `subscription:${subscriptionPublicId}`) {
            return {
              valid: true,
              configured: webhookConfigured,
              enabled: webhookEnabled,
              reasonCode: !webhookEnabled ? "WEBHOOK_SUBSCRIPTION_DISABLED" : null,
              message: !webhookEnabled
                ? "Webhook subscription is disabled."
                : "Target is ready.",
            };
          }
          if (targetKey === "production:P101") {
            return {
              valid: true,
              configured: true,
              enabled: true,
              reasonCode: null,
              message: "Production P101 ready.",
            };
          }
          return {
            valid: false,
            configured: false,
            enabled: false,
            reasonCode: "WEBHOOK_TARGET_NOT_FOUND",
            message: "Unknown webhook target.",
          };
        },
        async enqueueStageWebhook(input: CapturedStageWebhook) {
          if (input.targetKey === `subscription:${subscriptionPublicId}` && !webhookEnabled) {
            return {
              outcome: "disabled" as const,
              targetKey: input.targetKey,
              deliveryPublicId: null,
              dispatchPublicId: null,
              reasonCode: "WEBHOOK_SUBSCRIPTION_DISABLED",
              message: "Webhook subscription is disabled.",
            };
          }
          if (
            input.targetKey !== `subscription:${subscriptionPublicId}` &&
            input.targetKey !== "production:P101"
          ) {
            return {
              outcome: "refused" as const,
              targetKey: input.targetKey,
              deliveryPublicId: null,
              dispatchPublicId: null,
              reasonCode: "WEBHOOK_TARGET_NOT_FOUND",
              message: "Webhook target not found.",
            };
          }
          const existing = capturedStageWebhooks.find(
            (w) => w.idempotencyKey === input.idempotencyKey && w.targetKey === input.targetKey,
          );
          if (existing) {
            return {
              outcome: "already_queued_or_delivered" as const,
              targetKey: input.targetKey,
              deliveryPublicId: ulid(h.clock.now().getTime()),
              dispatchPublicId: null,
              reasonCode: null,
              message: "Webhook delivery already queued.",
            };
          }
          capturedStageWebhooks.push(input);
          return {
            outcome: "queued" as const,
            targetKey: input.targetKey,
            deliveryPublicId: ulid(h.clock.now().getTime() + capturedStageWebhooks.length),
            dispatchPublicId: null,
            reasonCode: null,
            message: "Queued signed webhook delivery.",
          };
        },
      },
    };

    auditCenter = createAuditModule(h.deps);
    mutableServices.auditCenter = auditCenter;

    opsAlerts = createOpsAlertsModule(h.deps);
    mutableServices.opsAlerts = opsAlerts;

    orders = createOrdersModule(h.deps);
    mutableServices.orders = orders;

    engagement = createEngagementModule(h.deps);
    mutableServices.engagement = engagement;

    automationsMod = createAutomationsModule(h.deps);
    mutableServices.automations = automationsMod;

    auditCenter.init?.();
    opsAlerts.init?.();
    orders.init?.();
    engagement.init?.();
    automationsMod.init?.();
  });

  it("previews and executes all 5 phase action bundle slots, persists order_stage_runs, and emits opsAlerts on partial/full failures", async () => {
    const admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
    const staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
    const customer = await insertUser(h, t.db, { role: "customer" });

    const wf = await publishFormat3DefaultWorkflow(admin.principal);
    const created = await placeCustomerOrder(admin.principal, customer.principal);

    const staffCaller = callerFor(staff.principal);
    const panel = await staffCaller.automations.orderStageActions.get({
      orderPublicId: created.publicId,
    });
    expect(panel.workflowFormat).toBe(3);
    expect(panel.stageBundlesEnabled).toBe(true);
    expect(panel.requiresStepUp).toBe(true);
    expect(panel.stages).toHaveLength(3);
    expect(panel.stages[0]!.hasConfiguredBundle).toBe(true);
    expect(panel.stages[2]!.hasConfiguredBundle).toBe(false);

    const preview = await staffCaller.automations.orderStageActions.previewBundle({
      orderPublicId: created.publicId,
      stageKey: "intake_phase",
    });
    expect(preview.slots.map((s) => s.slot)).toEqual([
      "status",
      "completion",
      "email",
      "webhook",
      "dashboard_alert",
    ]);
    expect(preview.statusTransition?.targetStatusKey).toBe(wf.s1);
    expect(preview.statusTransition?.isAllowedStandardTransition).toBe(true);
    expect(preview.statusTransition?.requiresAdminOverride).toBe(false);
    expect(preview.confirmationToken).toMatch(/^stgc1_[0-9a-f]{64}$/);

    const idemKey = nextKey("bundle");
    const runRes = await staffCaller.automations.orderStageActions.runBundle({
      orderPublicId: created.publicId,
      stageKey: "intake_phase",
      idempotencyKey: idemKey,
      confirmationToken: preview.confirmationToken,
    });

    expect(runRes.deduplicated).toBe(false);
    expect(runRes.stageRun.state).toBe("completed");
    expect(runRes.stageRun.results).toHaveLength(5);
    expect(runRes.stageRun.results.every((r) => r.outcome === "completed")).toBe(true);
    expect(runRes.completionJob?.state).toBe("applied");
    expect(runRes.completionJob?.resolvedPercent).toBe(35);

    // Verify customer email + webhook + operator dashboard alert were emitted once
    expect(h.mailer.sent.some((m) => m.template === "orders.phase_update")).toBe(true);
    expect(capturedStageWebhooks).toHaveLength(1);
    expect(capturedStageWebhooks[0]!.triggerSource).toBe("stage_bundle");

    const openAlerts = await opsAlerts.list({ state: "open" });
    expect(openAlerts.items.some((a) => a.code === "STAGE_BUNDLE_OPERATOR_ALERT")).toBe(true);

    // Partial failure when email template becomes unpublished before a fresh preview+run
    const secondOrder = await placeCustomerOrder(admin.principal, customer.principal);
    templateAvailable = false;
    const partialPreview = await staffCaller.automations.orderStageActions.previewBundle({
      orderPublicId: secondOrder.publicId,
      stageKey: "intake_phase",
    });
    expect(partialPreview.slots.find((s) => s.slot === "email")?.warning).toBeTruthy();

    const partialRes = await staffCaller.automations.orderStageActions.runBundle({
      orderPublicId: secondOrder.publicId,
      stageKey: "intake_phase",
      idempotencyKey: nextKey("partial"),
      confirmationToken: partialPreview.confirmationToken,
    });
    expect(partialRes.stageRun.state).toBe("partial_failed");
    expect(partialRes.stageRun.results.find((s) => s.slot === "email")?.outcome).toBe("failed");

    const afterPartialAlerts = await opsAlerts.list({ state: "open" });
    expect(afterPartialAlerts.items.some((a) => a.code === "STAGE_BUNDLE_PARTIAL_FAILED")).toBe(
      true,
    );
  });

  it("enforces customer denial, MFA step-up, admin-only status overrides with reason, and stageBundlesEnabled toggle", async () => {
    const admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
    const staffNoStepUp = await insertUser(h, t.db, { role: "staff", stepUp: false });
    const staffWithStepUp = await insertUser(h, t.db, { role: "staff", stepUp: true });
    const customer = await insertUser(h, t.db, { role: "customer", stepUp: true });

    await publishFormat3DefaultWorkflow(admin.principal);
    const order = await placeCustomerOrder(admin.principal, customer.principal);

    const customerCaller = callerFor(customer.principal);
    await expect(
      customerCaller.automations.orderStageActions.previewBundle({
        orderPublicId: order.publicId,
        stageKey: "intake_phase",
      }),
    ).rejects.toThrow();
    await expect(
      customerCaller.automations.orderStageActions.listBundleRuns({
        orderPublicId: order.publicId,
      }),
    ).rejects.toThrow();
    await expect(
      customerCaller.automations.orderStageActions.listCompletionJobs({
        orderPublicId: order.publicId,
      }),
    ).rejects.toThrow();
    await expect(
      customerCaller.automations.reorder({ orderedPublicIds: [] }),
    ).rejects.toThrow();

    // Staff without fresh MFA step-up can preview, but runBundle is blocked by STEP_UP_REQUIRED
    const noStepCaller = callerFor(staffNoStepUp.principal);
    const previewNoStep = await noStepCaller.automations.orderStageActions.previewBundle({
      orderPublicId: order.publicId,
      stageKey: "intake_phase",
    });
    await expect(
      noStepCaller.automations.orderStageActions.runBundle({
        orderPublicId: order.publicId,
        stageKey: "intake_phase",
        idempotencyKey: nextKey("nostep"),
        confirmationToken: previewNoStep.confirmationToken,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Review phase jumps directly from submitted -> terminal (non-adjacent override required)
    const staffCaller = callerFor(staffWithStepUp.principal);
    const overridePreviewForStaff = await staffCaller.automations.orderStageActions.previewBundle({
      orderPublicId: order.publicId,
      stageKey: "review_phase",
    });
    expect(overridePreviewForStaff.statusTransition?.requiresAdminOverride).toBe(true);
    expect(overridePreviewForStaff.canExecute).toBe(false);

    await expect(
      staffCaller.automations.orderStageActions.runBundle({
        orderPublicId: order.publicId,
        stageKey: "review_phase",
        idempotencyKey: nextKey("staffovr"),
        confirmationToken: overridePreviewForStaff.confirmationToken,
        statusOverrideReason: "Staff attempting admin override",
      }),
    ).rejects.toThrow();

    // Admin without override reason (<5 chars) is rejected; with valid reason succeeds
    const adminCaller = callerFor(admin.principal);
    const adminOverridePreview = await adminCaller.automations.orderStageActions.previewBundle({
      orderPublicId: order.publicId,
      stageKey: "review_phase",
    });
    expect(adminOverridePreview.canExecute).toBe(true);

    await expect(
      adminCaller.automations.orderStageActions.runBundle({
        orderPublicId: order.publicId,
        stageKey: "review_phase",
        idempotencyKey: nextKey("no_reason"),
        confirmationToken: adminOverridePreview.confirmationToken,
        statusOverrideReason: "ok",
      }),
    ).rejects.toThrow();

    const adminOverrideRun = await adminCaller.automations.orderStageActions.runBundle({
      orderPublicId: order.publicId,
      stageKey: "review_phase",
      idempotencyKey: nextKey("with_reason"),
      confirmationToken: adminOverridePreview.confirmationToken,
      statusOverrideReason: "Expedited executive sign-off completed.",
    });
    expect(adminOverrideRun.stageRun.state).toBe("completed");

    // Legacy stored automations.config JSON without stageBundlesEnabled defaults to true
    const legacyConfigValue = {
      enabled: true,
      globalRunsPerMinute: 120,
      defaultPerAutomationRunsPerHour: 60,
      maxPerAutomationRunsPerHour: 600,
      runRetentionDays: 90,
    };
    await t.db
      .insert(platformSettings)
      .values({
        settingKey: AUTOMATIONS_CONFIG.key,
        kind: "value",
        valueJson: legacyConfigValue,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      })
      .onDuplicateKeyUpdate({
        set: {
          valueJson: legacyConfigValue,
          updatedAt: h.clock.now(),
        },
      });

    const settingsAfterLegacy = await adminCaller.automations.settings.get();
    expect(settingsAfterLegacy.stageBundlesEnabled).toBe(true);

    // Disabling stageBundlesEnabled marks preview canExecute=false and blocks runBundle cleanly
    await adminCaller.automations.settings.update({ stageBundlesEnabled: false });
    const order2 = await placeCustomerOrder(admin.principal, customer.principal);
    const disabledPreview = await adminCaller.automations.orderStageActions.previewBundle({
      orderPublicId: order2.publicId,
      stageKey: "intake_phase",
    });
    expect(disabledPreview.canExecute).toBe(false);
    await expect(
      adminCaller.automations.orderStageActions.runBundle({
        orderPublicId: order2.publicId,
        stageKey: "intake_phase",
        idempotencyKey: nextKey("disabled_run"),
        confirmationToken: disabledPreview.confirmationToken,
      }),
    ).rejects.toThrow();
  });

  it("enforces pinned workflow immutability, confirmationToken staleness, idempotency replay, and order locks with zero side effects", async () => {
    const admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
    const staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
    const customer = await insertUser(h, t.db, { role: "customer" });

    const wf1 = await publishFormat3DefaultWorkflow(admin.principal, {
      intakeCompletion: { kind: "fixed", percent: 25, delayMinutes: 0 },
    });
    const pinnedOrder = await placeCustomerOrder(admin.principal, customer.principal);

    // Publish v2 of the workflow with 80% completion — existing pinnedOrder MUST keep 25%
    const v2Draft = await orders.workflows.createDraft(admin.principal, {
      from: "copy",
      workflowId: wf1.workflowPublicId,
      copyVersionId: wf1.versionId,
    });
    const fullV2Draft = await orders.workflows.getDraft(v2Draft.publicId);
    const v2Def = structuredClone(fullV2Draft.definition) as {
      formatVersion?: number;
      stages?: Array<Record<string, unknown> & { stageActions?: Record<string, unknown> }>;
      [k: string]: unknown;
    };
    v2Def.stages![0]!.stageActions = {
      ...v2Def.stages![0]!.stageActions,
      completion: { kind: "fixed", percent: 80, delayMinutes: 0 },
    };
    const savedV2 = await orders.workflows.saveDraft(admin.principal, {
      draftId: v2Draft.publicId,
      expectedVersion: v2Draft.rowVersion,
      name: "Workflow v2",
      definition: v2Def,
    });
    await orders.workflows.publishDraft(admin.principal, {
      draftId: v2Draft.publicId,
      expectedVersion: savedV2.rowVersion,
      makeDefault: true,
    });

    const staffCaller = callerFor(staff.principal);
    const adminCaller = callerFor(admin.principal);

    // Unconfigured & unknown stages are rejected
    await expect(
      staffCaller.automations.orderStageActions.previewBundle({
        orderPublicId: pinnedOrder.publicId,
        stageKey: "delivery_phase",
      }),
    ).rejects.toThrow();
    await expect(
      staffCaller.automations.orderStageActions.previewBundle({
        orderPublicId: pinnedOrder.publicId,
        stageKey: "nonexistent_stage",
      }),
    ).rejects.toThrow();

    // Preview on pinnedOrder shows 25% (from pinned v1, NOT v2's 80%)
    const preview = await staffCaller.automations.orderStageActions.previewBundle({
      orderPublicId: pinnedOrder.publicId,
      stageKey: "intake_phase",
    });
    expect(preview.slots.find((s) => s.slot === "completion")?.summary).toContain("25%");

    // Cross-actor token misuse is rejected with STALE_STAGE_CONFIRMATION and zero side effects
    await expect(
      adminCaller.automations.orderStageActions.runBundle({
        orderPublicId: pinnedOrder.publicId,
        stageKey: "intake_phase",
        idempotencyKey: nextKey("wrong_actor"),
        confirmationToken: preview.confirmationToken,
      }),
    ).rejects.toThrow();
    expect(capturedStageWebhooks).toHaveLength(0);

    // Slot availability change (webhook subscription disabled after preview) invalidates confirmationToken!
    webhookEnabled = false;
    await expect(
      staffCaller.automations.orderStageActions.runBundle({
        orderPublicId: pinnedOrder.publicId,
        stageKey: "intake_phase",
        idempotencyKey: nextKey("stale_wh"),
        confirmationToken: preview.confirmationToken,
      }),
    ).rejects.toThrow();
    expect(capturedStageWebhooks).toHaveLength(0);
    webhookEnabled = true;

    // Concurrent order lock (`legal_hold`) after preview blocks execution with LOCKED and zero side effects
    await t.db
      .update(orderTables.orders)
      .set({ lockState: "legal_hold" })
      .where(eq(orderTables.orders.publicId, pinnedOrder.publicId));

    await expect(
      staffCaller.automations.orderStageActions.runBundle({
        orderPublicId: pinnedOrder.publicId,
        stageKey: "intake_phase",
        idempotencyKey: nextKey("locked_run"),
        confirmationToken: preview.confirmationToken,
      }),
    ).rejects.toThrow();
    expect(capturedStageWebhooks).toHaveLength(0);

    // Lift lock, execute once with fresh preview, then replay same idempotencyKey even after order moved on
    await t.db
      .update(orderTables.orders)
      .set({ lockState: "none" })
      .where(eq(orderTables.orders.publicId, pinnedOrder.publicId));

    const freshPreview = await staffCaller.automations.orderStageActions.previewBundle({
      orderPublicId: pinnedOrder.publicId,
      stageKey: "intake_phase",
    });
    const idem = nextKey("replay");
    const firstExec = await staffCaller.automations.orderStageActions.runBundle({
      orderPublicId: pinnedOrder.publicId,
      stageKey: "intake_phase",
      idempotencyKey: idem,
      confirmationToken: freshPreview.confirmationToken,
    });
    expect(firstExec.deduplicated).toBe(false);
    expect(firstExec.completionJob?.resolvedPercent).toBe(25);
    expect(capturedStageWebhooks).toHaveLength(1);

    // Replaying the exact same idempotencyKey returns deduplicated result (order status already advanced!)
    const replayExec = await staffCaller.automations.orderStageActions.runBundle({
      orderPublicId: pinnedOrder.publicId,
      stageKey: "intake_phase",
      idempotencyKey: idem,
      confirmationToken: freshPreview.confirmationToken,
    });
    expect(replayExec.deduplicated).toBe(true);
    expect(replayExec.stageRun.publicId).toBe(firstExec.stageRun.publicId);
    expect(capturedStageWebhooks).toHaveLength(1);

    // Reusing the same idempotencyKey for a DIFFERENT stageKey on the same order throws IDEMPOTENCY_KEY_CONFLICT
    await expect(
      staffCaller.automations.orderStageActions.runBundle({
        orderPublicId: pinnedOrder.publicId,
        stageKey: "review_phase",
        idempotencyKey: idem,
        confirmationToken: freshPreview.confirmationToken,
      }),
    ).rejects.toThrow();

    // Trying a NEW idempotencyKey with the now-stale confirmationToken is declined with STALE_STAGE_CONFIRMATION
    await expect(
      staffCaller.automations.orderStageActions.runBundle({
        orderPublicId: pinnedOrder.publicId,
        stageKey: "intake_phase",
        idempotencyKey: nextKey("stale_after_move"),
        confirmationToken: freshPreview.confirmationToken,
      }),
    ).rejects.toThrow();
  });

  it("resolves range completion once via CSPRNG, fences delayed jobs, supersedes on stage leave / cancel / newer write, supports admin cancel, and alerts after 3 worker failures", async () => {
    const admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
    const staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
    const customer = await insertUser(h, t.db, { role: "customer" });

    const wf = await publishFormat3DefaultWorkflow(admin.principal, {
      intakeStatusKey: DEFAULT_WORKFLOW.states[0]!.key, // stay in intake_phase so delayed job stays in stage
      intakeCompletion: { kind: "range", min: 42, max: 58, delayMinutes: 30 },
    });

    // Case 1: Single-roll CSPRNG persisted at admission and applied without re-rolling when due
    const order1 = await placeCustomerOrder(admin.principal, customer.principal);
    const staffCaller = callerFor(staff.principal);

    // Remove status transition by previewing/running on intake_phase (same status -> no-op or let's use review_phase or rule)
    // Actually let's test delayed range via stage bundle on review_phase after moving order1 to s1!
    await orders.orders.transition(staff.principal, {
      orderId: order1.publicId,
      toStatus: wf.s1,
      expectedVersion: 1,
    });

    // Create a workflow where review_phase has delayed range completion ONLY (no status jump)
    const wfKey2 = `wf_comp_${++seq}`;
    const d2 = await orders.workflows.createDraft(admin.principal, {
      from: "standard",
      workflowKey: wfKey2,
      name: "Delayed Range Workflow",
    });
    const fullD2 = await orders.workflows.getDraft(d2.publicId);
    const { phases: _unusedPhases2, ...baseDef2 } = fullD2.definition;
    void _unusedPhases2;
    const savedD2 = await orders.workflows.saveDraft(admin.principal, {
      draftId: d2.publicId,
      expectedVersion: d2.rowVersion,
      name: "Delayed Range Workflow",
      definition: {
        ...baseDef2,
        stages: [
          {
            key: "phase_one",
            customerLabel: "Phase One",
            staffLabel: "Phase One",
            statusKeys: [wf.s0],
            actions: {
              uploadDocuments: true,
              answerQuestions: false,
              recordAudio: false,
              uploadAudio: false,
              teamFileReview: false,
            },
            folders: { ...DEFAULT_STAGE_FOLDERS },
            fileSync: { ...DEFAULT_STAGE_FILE_SYNC },
            acknowledgement: { policy: "none" as const },
            progression: "next" as const,
            adminTasks: ["run_automation" as const],
            completesOn: "manual" as const,
            weight: 50,
            stageActions: {
              completion: { kind: "range" as const, min: 40, max: 60, delayMinutes: 25 },
            },
          },
          {
            key: "phase_two",
            customerLabel: "Phase Two",
            staffLabel: "Phase Two",
            statusKeys: DEFAULT_WORKFLOW.states.slice(1).map((s) => s.key),
            actions: {
              uploadDocuments: false,
              answerQuestions: false,
              recordAudio: false,
              uploadAudio: false,
              teamFileReview: false,
            },
            folders: { ...DEFAULT_STAGE_FOLDERS },
            fileSync: { ...DEFAULT_STAGE_FILE_SYNC },
            acknowledgement: { policy: "none" as const },
            progression: "next" as const,
            adminTasks: ["run_automation" as const],
            completesOn: "manual" as const,
            weight: 50,
            stageActions: {
              completion: { kind: "fixed" as const, percent: 85, delayMinutes: 0 },
            },
          },
        ],
      },
    });
    await orders.workflows.publishDraft(admin.principal, {
      draftId: d2.publicId,
      expectedVersion: savedD2.rowVersion,
      makeDefault: true,
    });

    // Subcase A: Delayed range job applies exact drawn value when due
    const ordApply = await placeCustomerOrder(admin.principal, customer.principal);
    const prevApply = await staffCaller.automations.orderStageActions.previewBundle({
      orderPublicId: ordApply.publicId,
      stageKey: "phase_one",
    });
    const scheduledRes = await staffCaller.automations.orderStageActions.runBundle({
      orderPublicId: ordApply.publicId,
      stageKey: "phase_one",
      idempotencyKey: nextKey("sched_apply"),
      confirmationToken: prevApply.confirmationToken,
    });
    expect(scheduledRes.completionJob?.state).toBe("scheduled");
    const drawnOnce = scheduledRes.completionJob!.resolvedPercent;
    expect(drawnOnce).toBeGreaterThanOrEqual(40);
    expect(drawnOnce).toBeLessThanOrEqual(60);

    h.clock.advance(26 * 60_000);
    await h.jobs.runAll(JOB_APPLY_COMPLETION);

    const jobsAfterApply = await staffCaller.automations.orderStageActions.listCompletionJobs({
      orderPublicId: ordApply.publicId,
    });
    expect(jobsAfterApply.items[0]!.state).toBe("applied");
    expect(jobsAfterApply.items[0]!.resolvedPercent).toBe(drawnOnce);
    const [ordApplyRow] = await t.db
      .select({ completionPercent: orderTables.orders.completionPercent })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, ordApply.publicId));
    expect(ordApplyRow!.completionPercent).toBe(drawnOnce);

    // Refresh MFA step-up after 26-minute clock advance
    staff.principal = { ...staff.principal, stepUpAt: h.clock.now() };
    admin.principal = { ...admin.principal, stepUpAt: h.clock.now() };
    const staffFresh = callerFor(staff.principal);

    // Subcase B: Leaving the stage supersedes scheduled stage completion job (STAGE_LEFT)
    const ordLeave = await placeCustomerOrder(admin.principal, customer.principal);
    const prevLeave = await staffFresh.automations.orderStageActions.previewBundle({
      orderPublicId: ordLeave.publicId,
      stageKey: "phase_one",
    });
    await staffFresh.automations.orderStageActions.runBundle({
      orderPublicId: ordLeave.publicId,
      stageKey: "phase_one",
      idempotencyKey: nextKey("sched_leave"),
      confirmationToken: prevLeave.confirmationToken,
    });

    await orders.orders.transition(staff.principal, {
      orderId: ordLeave.publicId,
      toStatus: wf.s1, // moves into phase_two!
      expectedVersion: 1,
    });

    const jobsAfterLeave = await staffFresh.automations.orderStageActions.listCompletionJobs({
      orderPublicId: ordLeave.publicId,
    });
    expect(jobsAfterLeave.items[0]!.state).toBe("superseded");
    expect(jobsAfterLeave.items[0]!.reasonCode).toBe("STAGE_CHANGED");

    // Even if the queued worker job fires later, it does NOT touch completionPercent
    h.clock.advance(30 * 60_000);
    await h.jobs.runAll(JOB_APPLY_COMPLETION);
    const [ordLeaveRow] = await t.db
      .select({ completionPercent: orderTables.orders.completionPercent })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, ordLeave.publicId));
    expect(ordLeaveRow!.completionPercent).toBeNull();

    // Refresh MFA step-up after 30-minute clock advance
    staff.principal = { ...staff.principal, stepUpAt: h.clock.now() };
    admin.principal = { ...admin.principal, stepUpAt: h.clock.now() };
    const staffFresh2 = callerFor(staff.principal);
    const adminFresh2 = callerFor(admin.principal);

    // Subcase C: Admin cancelCompletionJob cancels scheduled job (staff forbidden)
    const ordCancel = await placeCustomerOrder(admin.principal, customer.principal);
    const prevCancel = await staffFresh2.automations.orderStageActions.previewBundle({
      orderPublicId: ordCancel.publicId,
      stageKey: "phase_one",
    });
    const cancelSched = await staffFresh2.automations.orderStageActions.runBundle({
      orderPublicId: ordCancel.publicId,
      stageKey: "phase_one",
      idempotencyKey: nextKey("sched_cancel"),
      confirmationToken: prevCancel.confirmationToken,
    });
    const jobPubId = cancelSched.completionJob!.publicId;

    await expect(
      staffFresh2.automations.orderStageActions.cancelCompletionJob({
        completionJobPublicId: jobPubId,
      }),
    ).rejects.toThrow();

    const canceledView = await adminFresh2.automations.orderStageActions.cancelCompletionJob({
      completionJobPublicId: jobPubId,
      reason: "Operator superseded schedule manually",
    });
    expect(canceledView.state).toBe("canceled");
    expect(canceledView.reasonCode).toBe("ADMIN_CANCELED");

    // Subcase D: 3-attempt worker failure marks job failed and emits opsAlert
    const ordFail = await placeCustomerOrder(admin.principal, customer.principal);
    const prevFail = await staffFresh2.automations.orderStageActions.previewBundle({
      orderPublicId: ordFail.publicId,
      stageKey: "phase_one",
    });
    const failSched = await staffFresh2.automations.orderStageActions.runBundle({
      orderPublicId: ordFail.publicId,
      stageKey: "phase_one",
      idempotencyKey: nextKey("sched_fail"),
      confirmationToken: prevFail.confirmationToken,
    });

    const origApply = orders.stages.applyCompletionPercent;
    (orders.stages as { applyCompletionPercent: typeof origApply }).applyCompletionPercent =
      async () => {
        throw new Error("Simulated transient DB failure");
      };

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const res = await handleApplyCompletionJob(h.deps, {
          jobId: "job_fail_sim",
          type: JOB_APPLY_COMPLETION,
          payload: { completionJobPublicId: failSched.completionJob!.publicId },
          attempt,
          fencingToken: attempt,
          correlationId: "job_fail_sim",
          signal: new AbortController().signal,
          assertStillOwned: async () => {},
        });
        expect(res.outcome).toBe("failed");
        if (res.outcome === "failed") {
          expect(res.retryable).toBe(attempt < 3);
        }
      }
    } finally {
      (orders.stages as { applyCompletionPercent: typeof origApply }).applyCompletionPercent =
        origApply;
    }

    const failedJobList = await adminFresh2.automations.orderStageActions.listCompletionJobs({
      orderPublicId: ordFail.publicId,
    });
    expect(failedJobList.items[0]!.state).toBe("failed");
    const alerts = await opsAlerts.list({ state: "open" });
    expect(alerts.items.some((a) => a.code === "COMPLETION_JOB_FAILED")).toBe(true);

    // Subcase E: Order lock (`legal_hold`) before delayed completion job fires supersedes with ORDER_LOCKED
    const ordLock = await placeCustomerOrder(admin.principal, customer.principal);
    const prevLock = await staffFresh2.automations.orderStageActions.previewBundle({
      orderPublicId: ordLock.publicId,
      stageKey: "phase_one",
    });
    const lockSched = await staffFresh2.automations.orderStageActions.runBundle({
      orderPublicId: ordLock.publicId,
      stageKey: "phase_one",
      idempotencyKey: nextKey("sched_lock"),
      confirmationToken: prevLock.confirmationToken,
    });
    await t.db
      .update(orderTables.orders)
      .set({ lockState: "legal_hold" })
      .where(eq(orderTables.orders.publicId, ordLock.publicId));

    const lockWorkerRes = await handleApplyCompletionJob(h.deps, {
      jobId: "job_lock_sim",
      type: JOB_APPLY_COMPLETION,
      payload: { completionJobPublicId: lockSched.completionJob!.publicId },
      attempt: 1,
      fencingToken: 1,
      correlationId: "job_lock_sim",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(lockWorkerRes.outcome).toBe("completed");
    const lockedJobs = await adminFresh2.automations.orderStageActions.listCompletionJobs({
      orderPublicId: ordLock.publicId,
    });
    expect(lockedJobs.items[0]!.state).toBe("superseded");
    expect(lockedJobs.items[0]!.reasonCode).toBe("ORDER_LOCKED");
    const [ordLockRow] = await t.db
      .select({ completionPercent: orderTables.orders.completionPercent })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, ordLock.publicId));
    expect(ordLockRow!.completionPercent).toBeNull();
  });

  it("backfills sort_order, reorders rules deterministically, and executes rules in (sortOrder ASC, id ASC) order", async () => {
    const admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
    const customer = await insertUser(h, t.db, { role: "customer" });
    const adminCaller = callerFor(admin.principal);

    await adminCaller.automations.settings.update({ enabled: true });

    const ruleA = await adminCaller.automations.create({
      name: "Rule Alpha",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "step_1",
          actionKey: "dashboard.create_alert",
          config: {
            severity: "warning",
            titleTemplate: "Alpha fired for {{order_reference}}",
          },
        },
      ],
    });
    const ruleB = await adminCaller.automations.create({
      name: "Rule Beta",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "step_1",
          actionKey: "dashboard.create_alert",
          config: {
            severity: "warning",
            titleTemplate: "Beta fired for {{order_reference}}",
          },
        },
      ],
    });

    // Simulate pre-Increment-07 rows with sort_order = 0 and verify startup backfill sets id * 10
    await t.db.update(automationTables.automations).set({ sortOrder: 0 });
    automationsMod.init?.();
    await new Promise((r) => setTimeout(r, 50));

    const listedAfterBackfill = await adminCaller.automations.list();
    expect(listedAfterBackfill.items.every((i) => i.sortOrder > 0)).toBe(true);
    expect(listedAfterBackfill.items.map((i) => i.publicId)).toEqual([
      ruleA.publicId,
      ruleB.publicId,
    ]);

    // Reorder so Beta runs BEFORE Alpha
    const reordered = await adminCaller.automations.reorder({
      orderedPublicIds: [ruleB.publicId, ruleA.publicId],
    });
    expect(reordered.orderedPublicIds).toEqual([ruleB.publicId, ruleA.publicId]);

    const listedAfterReorder = await adminCaller.automations.list();
    expect(listedAfterReorder.items.map((i) => i.publicId)).toEqual([
      ruleB.publicId,
      ruleA.publicId,
    ]);
    expect(listedAfterReorder.items[0]!.sortOrder).toBe(10);
    expect(listedAfterReorder.items[1]!.sortOrder).toBe(20);

    // Trigger order.created and verify runs are created in Beta -> Alpha order
    await placeCustomerOrder(admin.principal, customer.principal);
    await drainAllJobs();

    const runRows = await t.db
      .select({
        id: automationTables.automationRuns.id,
        automationName: automationTables.automationRuns.automationName,
      })
      .from(automationTables.automationRuns)
      .orderBy(asc(automationTables.automationRuns.id));

    expect(runRows.map((r) => r.automationName)).toEqual(["Rule Beta", "Rule Alpha"]);
  });

  it("validates and executes D5 built-in actions, triggers (payment.*, intake.*, order.stage_submitted), and catalogue.pickerOptions", async () => {
    const admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
    const customer = await insertUser(h, t.db, { role: "customer" });
    const adminCaller = callerFor(admin.principal);

    await publishFormat3DefaultWorkflow(admin.principal);
    await adminCaller.automations.settings.update({ enabled: true });

    // 1. Catalogue pickerOptions exposes statuses, stages, workflows, payment methods/providers, templates, webhooks, fieldOptionSources
    const catalogue = await adminCaller.automations.catalogue();
    expect(catalogue.stageBundlesEnabled).toBe(true);
    expect(catalogue.pickerOptions.statuses.length).toBeGreaterThan(0);
    expect(catalogue.pickerOptions.stages.map((s) => s.value)).toContain("intake_phase");
    expect(catalogue.pickerOptions.workflows.length).toBeGreaterThan(0);
    expect(catalogue.pickerOptions.paymentMethods.length).toBeGreaterThan(0);
    expect(catalogue.pickerOptions.paymentProviders.map((p) => p.value)).toEqual(
      expect.arrayContaining(["stripe", "square", "manual"]),
    );
    expect(catalogue.pickerOptions.webhookSubscriptions).toHaveLength(1);
    expect(catalogue.pickerOptions.webhookTargets.length).toBeGreaterThanOrEqual(2);
    expect(catalogue.pickerOptions.phaseEmailTemplates).toHaveLength(1);
    expect(catalogue.pickerOptions.fieldOptionSources.to_status).toBe("statuses");
    expect(catalogue.pickerOptions.fieldOptionSources.stage_key).toBe("stages");

    // 2. webhook.enqueue_subscription rejects raw URLs and staffOnly triggers
    await expect(
      adminCaller.automations.create({
        name: "Bad Raw URL Webhook",
        enabled: true,
        trigger: { kind: "event", triggerKey: "payment.succeeded" },
        actions: [
          {
            stepKey: "s1",
            actionKey: "webhook.enqueue_subscription",
            config: { targetKey: "https://evil.example.com/hook" },
          },
        ],
      }),
    ).rejects.toThrow();

    await expect(
      adminCaller.automations.create({
        name: "StaffOnly Forbidden Webhook",
        enabled: true,
        trigger: { kind: "event", triggerKey: "payment.failed" },
        actions: [
          {
            stepKey: "s1",
            actionKey: "webhook.enqueue_subscription",
            config: { targetKey: `subscription:${subscriptionPublicId}` },
          },
        ],
      }),
    ).rejects.toThrow();

    // 3. order.set_completion enforces STAGE_COMPLETION_DELAY_MAX_MINUTES (43,200) and staffOnly prohibition
    await expect(
      adminCaller.automations.create({
        name: "Too Long Delay",
        enabled: true,
        trigger: { kind: "event", triggerKey: "order.stage_submitted" },
        actions: [
          {
            stepKey: "s1",
            actionKey: "order.set_completion",
            config: {
              kind: "fixed",
              percent: 50,
              delayMinutes: STAGE_COMPLETION_DELAY_MAX_MINUTES + 1,
            },
          },
        ],
      }),
    ).rejects.toThrow();

    // 4. dashboard.create_alert is permitted on staffOnly trigger `payment.failed` and rejects `{{recipient_name}}` PII
    await expect(
      adminCaller.automations.create({
        name: "PII Leak Alert",
        enabled: true,
        trigger: { kind: "event", triggerKey: "order.created" },
        actions: [
          {
            stepKey: "s1",
            actionKey: "dashboard.create_alert",
            config: {
              severity: "error",
              titleTemplate: "Hello {{recipient_name}}",
            },
          },
        ],
      }),
    ).rejects.toThrow();

    await adminCaller.automations.create({
      name: "Payment Failure Ops Alert",
      enabled: true,
      trigger: { kind: "event", triggerKey: "payment.failed" },
      actions: [
        {
          stepKey: "s1",
          actionKey: "dashboard.create_alert",
          config: {
            severity: "critical",
            titleTemplate: "Payment failed via {{provider}} ({{reason_code}})",
            bodyTemplate: "Invoice {{invoice_public_id}} requires review.",
            code: "PAYMENT_FAILURE_RULE",
          },
        },
      ],
    });

    // 5. Rules for order.stage_submitted -> order.set_completion + webhook.enqueue_subscription, and intake.submitted
    await adminCaller.automations.create({
      name: "Stage Submitted Completion + Webhook",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.stage_submitted" },
      actions: [
        {
          stepKey: "s1",
          actionKey: "order.set_completion",
          config: {
            kind: "fixed",
            percent: 45,
            delayMinutes: 0,
          },
        },
        {
          stepKey: "s2",
          actionKey: "webhook.enqueue_subscription",
          config: {
            targetKey: `subscription:${subscriptionPublicId}`,
            eventKey: "order.stage.submitted",
          },
        },
      ],
    });

    await adminCaller.automations.create({
      name: "Intake Submitted Alert",
      enabled: true,
      trigger: { kind: "event", triggerKey: "intake.submitted" },
      actions: [
        {
          stepKey: "s1",
          actionKey: "dashboard.create_alert",
          config: {
            severity: "warning",
            titleTemplate: "Intake submitted for {{questionnaire_public_id}} (rev {{revision_number}})",
            code: "INTAKE_SUBMITTED_RULE",
          },
        },
      ],
    });

    await adminCaller.automations.create({
      name: "Payment Succeeded Alert",
      enabled: true,
      trigger: { kind: "event", triggerKey: "payment.succeeded" },
      actions: [
        {
          stepKey: "s1",
          actionKey: "dashboard.create_alert",
          config: {
            severity: "warning",
            titleTemplate: "Payment succeeded via {{method}} for {{order_reference}}",
            code: "PAYMENT_SUCCEEDED_RULE",
          },
        },
      ],
    });

    await adminCaller.automations.create({
      name: "Payment Refunded Alert",
      enabled: true,
      trigger: { kind: "event", triggerKey: "payment.refunded" },
      actions: [
        {
          stepKey: "s1",
          actionKey: "dashboard.create_alert",
          config: {
            severity: "warning",
            titleTemplate: "Payment refunded via {{provider}} for {{order_reference}}",
            code: "PAYMENT_REFUNDED_RULE",
          },
        },
      ],
    });

    await adminCaller.automations.create({
      name: "Intake Reviewed Alert",
      enabled: true,
      trigger: { kind: "event", triggerKey: "intake.reviewed" },
      actions: [
        {
          stepKey: "s1",
          actionKey: "dashboard.create_alert",
          config: {
            severity: "warning",
            titleTemplate: "Intake reviewed ({{decision}}) for {{order_reference}}",
            code: "INTAKE_REVIEWED_RULE",
          },
        },
      ],
    });

    const order = await placeCustomerOrder(admin.principal, customer.principal);
    await drainAllJobs();

    // Emit payment.failed, payment.succeeded, payment.refunded, intake.submitted, intake.reviewed, and order.stage.submitted
    const invPubId = ulid(h.clock.now().getTime() + 10);
    await h.deps.audit.record({
      category: "business",
      eventName: "payments.attempt.failed",
      action: "execute",
      outcome: "failed",
      severity: "WARN",
      reasonCode: "CARD_DECLINED",
      actor: { role: "system" },
      resource: { type: "payment_attempt", publicId: invPubId },
      orderPublicId: order.publicId,
      attributes: {
        invoice_public_id: invPubId,
        order_public_id: order.publicId,
        provider: "stripe",
        reason_code: "CARD_DECLINED",
      },
    });

    const payPubId = ulid(h.clock.now().getTime() + 11);
    await h.deps.audit.record({
      category: "business",
      eventName: "invoice.payment.recorded",
      action: "create",
      outcome: "completed",
      actor: { role: "system" },
      resource: { type: "invoice_payment", publicId: payPubId },
      orderPublicId: order.publicId,
      attributes: {
        invoice_public_id: invPubId,
        method: "provider_online",
        amount_minor: 25_000,
        currency: "USD",
      },
    });

    await h.deps.audit.record({
      category: "business",
      eventName: "payment.refund.succeeded",
      action: "execute",
      outcome: "completed",
      actor: { role: "system" },
      resource: { type: "payment_refund", publicId: ulid(h.clock.now().getTime() + 12) },
      orderPublicId: order.publicId,
      attributes: {
        invoice_public_id: invPubId,
        provider: "stripe",
      },
    });

    const subPubId = ulid(h.clock.now().getTime() + 13);
    const questPubId = ulid(h.clock.now().getTime() + 14);
    await h.deps.audit.record({
      category: "business",
      eventName: "intake.submission.submitted",
      action: "create",
      outcome: "completed",
      actor: { userId: customer.id, role: "customer" },
      resource: { type: "intake_submission", publicId: subPubId },
      orderPublicId: order.publicId,
      attributes: {
        questionnaire_public_id: questPubId,
        revision_number: 1,
      },
    });

    await h.deps.audit.record({
      category: "business",
      eventName: "intake.submission.reviewed",
      action: "update",
      outcome: "completed",
      actor: { userId: admin.id, role: "admin" },
      resource: { type: "intake_submission", publicId: subPubId },
      orderPublicId: order.publicId,
      attributes: {
        decision: "accepted",
        revision_number: 1,
      },
    });

    await h.deps.audit.record({
      category: "business",
      eventName: "order.stage.submitted",
      action: "transition",
      outcome: "completed",
      actor: { userId: customer.id, role: "customer" },
      resource: { type: "order", publicId: order.publicId },
      orderPublicId: order.publicId,
      attributes: {
        stage_key: "intake_phase",
        stage_index: 1,
        progress_percent: 30,
      },
    });

    await drainAllJobs();

    // Verify order completion percent became 45% from order.stage_submitted rule
    const [updatedOrd] = await t.db
      .select({ completionPercent: orderTables.orders.completionPercent })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, order.publicId));
    expect(updatedOrd!.completionPercent).toBe(45);

    // Verify webhook.enqueue_subscription dispatched with safe non-personal fields
    expect(capturedStageWebhooks).toHaveLength(1);
    expect(capturedStageWebhooks[0]!.triggerSource).toBe("automation_rule");
    expect(capturedStageWebhooks[0]!.eventKey).toBe("order.stage.submitted");

    // Verify all D5 trigger alerts were created in opsAlerts
    const openAlerts = await opsAlerts.list({ state: "open" });
    expect(openAlerts.items.some((a) => a.code === "PAYMENT_FAILURE_RULE")).toBe(true);
    expect(openAlerts.items.some((a) => a.code === "PAYMENT_SUCCEEDED_RULE")).toBe(true);
    expect(openAlerts.items.some((a) => a.code === "PAYMENT_REFUNDED_RULE")).toBe(true);
    expect(openAlerts.items.some((a) => a.code === "INTAKE_SUBMITTED_RULE")).toBe(true);
    expect(openAlerts.items.some((a) => a.code === "INTAKE_REVIEWED_RULE")).toBe(true);

    // Verify intake.submitted catalogue definition contains zero answer fields
    const intakeTrigger = catalogue.triggers.find((tr) => tr.key === "intake.submitted");
    expect(intakeTrigger).toBeDefined();
    expect(intakeTrigger!.fields.some((f) => f.key.includes("answer"))).toBe(false);
  });
});
