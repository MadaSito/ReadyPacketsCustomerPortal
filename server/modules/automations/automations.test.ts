import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps, Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Db, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import { createAuditEmitter } from "../audit/emitter.js";
import { AUTOMATION_ORIGIN_PREFIX, createAuditModule, type AuditModule } from "../audit/index.js";
import * as auditTables from "../audit/schema.js";
import { createEngagementModule, type EngagementModule } from "../engagement/index.js";
import { engagementRouter } from "../engagement/router.js";
import * as engagementTables from "../engagement/schema.js";
import { ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED } from "../engagement/settings.js";
import { users, type UserStatus } from "../identity/schema.js";
import type { EgressFetchOptions, EgressFetchResponse, EgressPurpose } from "../integrations/egress.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import * as orderTables from "../orders/schema.js";
import { writeSetting } from "../platform/index.js";
import { platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import { unfencedPurgeRunForTests, type TrashParticipant } from "../trash/ports.js";
import {
  JOB_EVALUATE_EVENT,
  JOB_EXECUTE_RUN,
  JOB_SCHEDULE_TICK,
  assertAllowedActionKey,
  createAutomationsModule,
  signAutomationWebhook,
  type AutomationActionRunContext,
  type AutomationsModule,
} from "./index.js";
import { automationsRouter } from "./router.js";
import * as automationTables from "./schema.js";

const testSchema = {
  users,
  platformSettings,
  ...auditTables,
  ...orderTables,
  ...engagementTables,
  ...automationTables,
};

const appTestRouter = router({
  automations: automationsRouter,
  engagement: engagementRouter,
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

let userSeq = 0;
let idemSeq = 0;

function nextIdem(prefix = "idem"): string {
  idemSeq += 1;
  return `${prefix}_${idemSeq}_${Date.now()}`;
}

async function insertSyntheticUser(
  h: TestHarness,
  db: Db,
  opts: {
    role?: UserRole;
    status?: UserStatus;
    name?: string;
    stepUp?: boolean;
    pendingSteps?: readonly string[];
    state?: SessionPrincipal["state"];
  } = {},
): Promise<SyntheticUser> {
  userSeq += 1;
  const publicId = ulid(h.clock.now().getTime() + userSeq);
  const role = opts.role ?? "customer";
  const email = `auto.user.${userSeq}@synthetic.test`;
  const name = opts.name ?? `Synthetic Person ${userSeq}`;
  const customerRef = role === "customer" ? `CUST-AUT-${String(userSeq).padStart(4, "0")}` : null;

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
    pendingSteps: (opts.pendingSteps ?? []) as never,
    state: opts.state ?? "full",
  });
  return { id: row!.id, publicId, email, name, role, principal };
}

interface CapturedWebhookCall {
  url: string;
  purpose: EgressPurpose;
  options: EgressFetchOptions;
}

describe("automations module (Package J)", () => {
  let t: TestDb;
  let h: TestHarness;
  let auditCenter: AuditModule;
  let orders: OrdersModule;
  let engagement: EngagementModule;
  let automationsMod: AutomationsModule;
  let trashParticipants: Map<string, TrashParticipant>;
  let capturedWebhooks: CapturedWebhookCall[];
  let nextWebhookHandler:
    | ((url: string, purpose: EgressPurpose, opts: EgressFetchOptions) => Promise<EgressFetchResponse>)
    | null;

  function callerFor(principal: SessionPrincipal | null) {
    const ctx: TrpcContext = {
      request: newRequestContext("test", { correlationId: ulid(h.clock.now().getTime()) }),
      services: h.services as Services,
      session: principal,
      transport: { issue: () => {}, clear: () => {} },
    };
    return createCaller(ctx);
  }

  async function placeCustomerOrder(
    adminPrincipal: SessionPrincipal,
    customerPrincipal: SessionPrincipal,
    priceMinor: number,
    projectName = "Packet Filing",
  ) {
    const group = await orders.catalog.createGroup(adminPrincipal, {
      name: `Group ${nextIdem("grp")}`,
      description: "Synthetic group",
      sortOrder: 0,
      active: true,
    });
    const product = await orders.catalog.createProduct(adminPrincipal, {
      groupId: group.publicId,
      productKey: `prod-${++idemSeq}`,
      sortOrder: 0,
      active: true,
      name: `Product ${idemSeq}`,
      description: "Synthetic product",
      features: ["Review"],
      priceMinor,
      currency: "USD",
    });
    return orders.orders.create(customerPrincipal, {
      projectName,
      items: [{ productPublicId: product.publicId, quantity: 1 }],
      idempotencyKey: nextIdem("ord"),
    });
  }

  async function drainAutomationJobs(): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      if (h.jobs.enqueued.length === 0) break;
      await h.jobs.runAll(JOB_EVALUATE_EVENT);
      await h.jobs.runAll(JOB_EXECUTE_RUN);
    }
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

    // Minimal identity peer used by `orders` / `engagement`
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
              "Your session is no longer active. Please sign in again.",
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

    capturedWebhooks = [];
    nextWebhookHandler = null;
    trashParticipants = new Map<string, TrashParticipant>();
    mutableServices.trash = {
      register(participant: TrashParticipant) {
        trashParticipants.set(participant.module, participant);
      },
      list() {
        return [...trashParticipants.values()];
      },
    };

    mutableServices.integrations = {
      egress: {
        async fetchPinned(
          url: string,
          purpose: EgressPurpose,
          options: EgressFetchOptions = {},
        ): Promise<EgressFetchResponse> {
          capturedWebhooks.push({ url, purpose, options });
          if (nextWebhookHandler) {
            return nextWebhookHandler(url, purpose, options);
          }
          if (options.beforeSend) {
            await options.beforeSend();
          }
          return {
            status: 202,
            headers: { "content-type": "application/json" },
            body: Buffer.from('{"ok":true}', "utf8"),
          };
        },
      },
    };

    const deps = h.deps as ModuleDeps;
    auditCenter = createAuditModule(deps);
    mutableServices.auditCenter = auditCenter;

    orders = createOrdersModule(deps);
    mutableServices.orders = orders;

    engagement = createEngagementModule(deps);
    mutableServices.engagement = engagement;

    automationsMod = createAutomationsModule(deps);
    mutableServices.automations = automationsMod;

    auditCenter.init?.();
    orders.init?.();
    engagement.init?.();
    automationsMod.init?.();
  });

  it("ships disabled by default and suppresses triggers until globally enabled", async () => {
    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const customer = await insertSyntheticUser(h, t.db, { role: "customer", name: "Alice Buyer" });
    const caller = callerFor(admin.principal);

    const initialSettings = await caller.automations.settings.get();
    expect(initialSettings.enabled).toBe(false);

    const created = await caller.automations.create({
      name: "Disabled global check",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "step_1",
          actionKey: "notification.send_in_app",
          config: {
            recipientKey: "order_owner",
            title: "Order {{order_reference}}",
            body: "Received {{order_reference}}",
          },
        },
      ],
    });
    expect(created.enabled).toBe(true);

    // Place an order while automations are globally disabled -> tap must NOT enqueue evaluation.
    await placeCustomerOrder(admin.principal, customer.principal, 5000, "Packet Alpha");
    expect(h.jobs.enqueued.filter((j) => j.type === JOB_EVALUATE_EVENT)).toHaveLength(0);
  });

  it("enforces negative authorization, step-up, remediation state, and live actor status", async () => {
    const customer = await insertSyntheticUser(h, t.db, { role: "customer" });
    const staff = await insertSyntheticUser(h, t.db, { role: "staff", stepUp: true });
    const adminNoStepUp = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: false });
    const adminRemediation = await insertSyntheticUser(h, t.db, {
      role: "admin",
      stepUp: true,
      state: "remediation",
      pendingSteps: ["mfa_enroll"],
    });
    const adminActive = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });

    await expect(callerFor(customer.principal).automations.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(callerFor(staff.principal).automations.catalogue()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(callerFor(adminRemediation.principal).automations.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Admin without step-up CAN read (`automations.read`), CANNOT mutate (`automations.manage`).
    const cat = await callerFor(adminNoStepUp.principal).automations.catalogue();
    expect(cat.triggers.length).toBeGreaterThan(5);
    await expect(
      callerFor(adminNoStepUp.principal).automations.settings.update({ enabled: true }),
    ).rejects.toThrow(/confirm your password|STEP_UP/i);

    // Suspend admin in DB while session principal still looks active -> must fail closed.
    await t.db.update(users).set({ status: "suspended" }).where(eq(users.id, adminActive.id));
    await expect(
      automationsMod.updateSettings(adminActive.principal, { enabled: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "ACTOR_NOT_ACTIVE",
    });
  });

  it("rejects prohibited action keys, template expressions, undeclared variables, and header CRLF", async () => {
    expect(() => assertAllowedActionKey("order.set_status")).toThrow();
    expect(() => assertAllowedActionKey("user.grant_permission")).toThrow();
    expect(() => assertAllowedActionKey("role.assign")).toThrow();

    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const caller = callerFor(admin.principal);

    // Mustache expression (`{{#if}}`) rejected
    await expect(
      caller.automations.create({
        name: "Bad expression",
        trigger: { kind: "event", triggerKey: "order.created" },
        actions: [
          {
            stepKey: "step_1",
            actionKey: "notification.send_in_app",
            config: {
              recipientKey: "order_owner",
              title: "Order {{#if order_reference}}yes{{/if}}",
              body: "Body",
            },
          },
        ],
      }),
    ).rejects.toThrow();

    // Undeclared variable rejected
    await expect(
      caller.automations.create({
        name: "Undeclared var",
        trigger: { kind: "event", triggerKey: "order.created" },
        actions: [
          {
            stepKey: "step_1",
            actionKey: "notification.send_in_app",
            config: {
              recipientKey: "order_owner",
              title: "Order {{nonexistent_secret}}",
              body: "Body",
            },
          },
        ],
      }),
    ).rejects.toThrow();

    // Single-line header CRLF injection rejected
    await expect(
      caller.automations.create({
        name: "Header CRLF",
        trigger: { kind: "event", triggerKey: "order.created" },
        actions: [
          {
            stepKey: "step_1",
            actionKey: "email.send_template",
            config: {
              recipientMode: "trigger",
              recipientKey: "order_owner",
              subject: "Order {{order_reference}}\r\nBcc: attacker@evil.test",
              body: "Hello",
            },
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("maintains immutable versions, optimistic locking, and write-only encrypted webhook secrets", async () => {
    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const caller = callerFor(admin.principal);
    const rawSecret = "whsec_super_secret_value_9012";

    const v1 = await caller.automations.create({
      name: "Webhook order hook",
      enabled: false,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "hook_1",
          actionKey: "webhook.call",
          config: {
            url: "https://hooks.partner.example/orders",
            payloadFields: ["order_reference", "currency"],
          },
          secrets: { signingSecret: rawSecret },
        },
      ],
    });

    expect(v1.version).toBe(1);
    expect(v1.actions[0]!.secretStatus.signingSecret).toEqual({
      configured: true,
      last4: "9012",
    });
    expect(JSON.stringify(v1)).not.toContain(rawSecret);

    // Update without re-sending secret preserves secret and increments version to 2
    const v2 = await caller.automations.update({
      publicId: v1.publicId,
      expectedVersion: 1,
      name: "Webhook order hook v2",
      actions: [
        {
          stepKey: "hook_1",
          actionKey: "webhook.call",
          config: {
            url: "https://hooks.partner.example/orders-v2",
            payloadFields: ["order_reference"],
          },
        },
      ],
    });
    expect(v2.version).toBe(2);
    expect(v2.actions[0]!.secretStatus.signingSecret).toEqual({
      configured: true,
      last4: "9012",
    });

    // Stale expectedVersion fails with CONFLICT
    await expect(
      caller.automations.update({
        publicId: v1.publicId,
        expectedVersion: 1,
        name: "Stale write",
      }),
    ).rejects.toThrow();

    const versions = await caller.automations.versions({ publicId: v1.publicId });
    expect(versions.items.map((x) => x.version)).toEqual([2, 1]);
    expect(JSON.stringify(versions)).not.toContain(rawSecret);

    // Duplicate copies config disabled at version 1 WITHOUT copying secrets
    const copy = await caller.automations.duplicate({ publicId: v1.publicId });
    expect(copy.enabled).toBe(false);
    expect(copy.version).toBe(1);
    expect(copy.actions[0]!.secretStatus.signingSecret).toEqual({
      configured: false,
      last4: null,
    });
    await expect(
      caller.automations.setEnabled({
        publicId: copy.publicId,
        expectedVersion: 1,
        enabled: true,
      }),
    ).rejects.toThrow(/secret/i);
  });

  it("evaluates conditions, executes email + in-app + support ticket in order, and prevents automation loops", async () => {
    const admin = await insertSyntheticUser(h, t.db, {
      role: "admin",
      name: "Admin Ops",
      stepUp: true,
    });
    const staff = await insertSyntheticUser(h, t.db, { role: "staff", name: "Sam Staff" });
    const customer = await insertSyntheticUser(h, t.db, {
      role: "customer",
      name: "Clara Customer",
    });
    const caller = callerFor(admin.principal);

    await caller.automations.settings.update({ enabled: true });

    const autoOrder = await caller.automations.create({
      name: "High-value order workflow",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      conditions: {
        match: "all",
        groups: [
          {
            match: "all",
            conditions: [
              { field: "currency", operator: "eq", value: "USD" },
              { field: "total_minor", operator: "gte", value: 5000 },
            ],
          },
        ],
      },
      actions: [
        {
          stepKey: "mail_1",
          actionKey: "email.send_template",
          config: {
            recipientMode: "trigger",
            recipientKey: "order_owner",
            subject: "Confirmed {{order_reference}}",
            body: "Hello {{recipient_name}}, order {{order_reference}} is confirmed.",
          },
        },
        {
          stepKey: "notif_2",
          actionKey: "notification.send_in_app",
          config: {
            recipientKey: "order_owner",
            title: "Order {{order_reference}} confirmed",
            body: "Track at {{order_link}}",
          },
        },
        {
          stepKey: "ticket_3",
          actionKey: "support.create_ticket",
          config: {
            recipientKey: "order_owner",
            category: "order",
            priority: "high",
            subject: "Onboarding check for {{order_reference}}",
            body: "Automated onboarding ticket for {{order_reference}}.",
          },
        },
      ],
    });

    // Automation B: listens on `ticket.opened` -> MUST NOT fire when `ticket_3` opens a ticket!
    const autoLoopTrap = await caller.automations.create({
      name: "Ticket opened listener (loop guard check)",
      enabled: true,
      trigger: { kind: "event", triggerKey: "ticket.opened" },
      actions: [
        {
          stepKey: "staff_alert",
          actionKey: "notification.send_in_app",
          config: {
            recipientKey: "staff",
            title: "Ticket {{ticket_number}} opened",
            body: "From human ticket only",
          },
        },
      ],
    });

    // 1) Low-value order (1500 < 5000) -> `skipped_conditions`
    await placeCustomerOrder(admin.principal, customer.principal, 1500, "Small Order");
    await drainAutomationJobs();

    const lowRuns = await caller.automations.runs.list({
      automationPublicId: autoOrder.publicId,
    });
    expect(lowRuns.items).toHaveLength(1);
    expect(lowRuns.items[0]!.state).toBe("skipped_conditions");

    // 2) High-value order (9000 >= 5000) -> `completed` across all 3 steps!
    h.mailer.sent = [];
    const bigOrder = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      9000,
      "Enterprise Order",
    );
    await drainAutomationJobs();

    const allRuns = await caller.automations.runs.list({
      automationPublicId: autoOrder.publicId,
    });
    const completedRun = allRuns.items.find((r) => r.state === "completed");
    expect(completedRun).toBeDefined();
    expect(completedRun!.correlationId.startsWith(AUTOMATION_ORIGIN_PREFIX)).toBe(true);
    expect(completedRun!.steps.map((s) => s.state)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(completedRun!.steps[2]!.externalRef).toMatch(/^TK-/);

    const autoMail = h.mailer.sent.find((m) => m.template === "automations.generic_notice");
    expect(autoMail).toBeDefined();
    expect(autoMail!.vars.subject).toContain(bigOrder.reference);
    expect(autoMail!.vars.body).toContain("Clara Customer");

    const custNotifs = await engagement.notifications.list(customer.principal);
    expect(custNotifs.items.some((n) => n.title.includes(bigOrder.reference))).toBe(true);

    // LOOP PROTECTION PROOF: `autoLoopTrap` (`ticket.opened`) has ZERO runs!
    const loopTrapRuns = await caller.automations.runs.list({
      automationPublicId: autoLoopTrap.publicId,
    });
    expect(loopTrapRuns.items).toHaveLength(0);
    const staffNotifsAfterAutoTicket = await engagement.notifications.list(staff.principal);
    expect(
      staffNotifsAfterAutoTicket.items.some((n) => n.body === "From human ticket only"),
    ).toBe(false);

    // Contrast: a human-created support ticket DOES trigger `autoLoopTrap`!
    await callerFor(customer.principal).engagement.tickets.create({
      category: "general",
      subject: "Human support question",
      body: "Need help with intake form.",
      idempotencyKey: nextIdem("tkt"),
    });
    await drainAutomationJobs();
    const humanTicketRuns = await caller.automations.runs.list({
      automationPublicId: autoLoopTrap.publicId,
    });
    expect(humanTicketRuns.items).toHaveLength(1);
    expect(humanTicketRuns.items[0]!.state).toBe("completed");
  });

  it("enforces J-A01 default-deny on staff-only triggers and hides persisted staff-only notifications after demotion", async () => {
    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const staffMember = await insertSyntheticUser(h, t.db, { role: "staff", name: "Nora Staff" });
    const customer = await insertSyntheticUser(h, t.db, {
      role: "customer",
      name: "Carl Customer",
    });
    const caller = callerFor(admin.principal);

    await caller.automations.settings.update({ enabled: true });
    await writeSetting(h.deps.settings, ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED, true);

    // 1) Outbound e-mail, webhook, support ticket, and customer recipients MUST be rejected at save time
    for (const forbiddenAction of [
      {
        stepKey: "s1",
        actionKey: "email.send_template",
        config: {
          recipientMode: "trigger",
          recipientKey: "staff",
          subject: "Internal note on {{order_reference}}",
          body: "Note added",
        },
      },
      {
        stepKey: "s1",
        actionKey: "webhook.call",
        config: { url: "https://hooks.partner.example/internal", payloadFields: [] },
        secrets: { signingSecret: "whsec_internal_secret_123456" },
      },
      {
        stepKey: "s1",
        actionKey: "support.create_ticket",
        config: {
          recipientKey: "staff",
          category: "general",
          priority: "normal",
          subject: "Internal note follow-up",
          body: "Body",
        },
      },
      {
        stepKey: "s1",
        actionKey: "notification.send_in_app",
        config: {
          recipientKey: "order_owner",
          title: "Leak to customer",
          body: "Should be blocked",
        },
      },
    ]) {
      await expect(
        caller.automations.create({
          name: `Forbidden staff-only ${forbiddenAction.actionKey}`,
          enabled: true,
          trigger: { kind: "event", triggerKey: "message.internal_note" },
          actions: [forbiddenAction],
        }),
      ).rejects.toThrow();
    }

    // 2) In-app notification to `staff` IS allowed on `message.internal_note`
    const staffAuto = await caller.automations.create({
      name: "Internal note staff alert",
      enabled: true,
      trigger: { kind: "event", triggerKey: "message.internal_note" },
      actions: [
        {
          stepKey: "in_app_staff",
          actionKey: "notification.send_in_app",
          config: {
            recipientKey: "staff",
            title: "Internal note on {{order_reference}}",
            body: "Staff-only update on {{order_reference}}",
          },
        },
      ],
    });

    const order = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      4000,
      "Confidential Review Order",
    );

    h.mailer.sent = [];
    // Post a staff-only internal note on the order
    await caller.engagement.messages.send({
      orderId: order.publicId,
      visibility: "internal",
      body: "Internal review note — never visible to customer.",
      idempotencyKey: nextIdem("msg"),
    });
    await drainAutomationJobs();

    const runs = await caller.automations.runs.list({ automationPublicId: staffAuto.publicId });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]!.state).toBe("completed");

    // Zero outbound e-mails queued for staff-only trigger!
    expect(h.mailer.sent).toHaveLength(0);

    // Customer received nothing
    expect((await engagement.notifications.list(customer.principal)).items).toHaveLength(0);

    // Active staff member sees the staff-only in-app notification
    const beforeDemotionList = await engagement.notifications.list(staffMember.principal);
    const staffNotif = beforeDemotionList.items.find((n) => n.title.includes(order.reference));
    expect(staffNotif).toBeDefined();
    expect((await engagement.notifications.unreadCount(staffMember.principal)).unreadCount).toBe(1);

    // 3) POST-DEMOTION SINGLE-STATEMENT ISOLATION (`http_security_engineer` gate):
    await t.db.update(users).set({ role: "customer" }).where(eq(users.id, staffMember.id));

    expect((await engagement.notifications.list(staffMember.principal)).items).toHaveLength(0);
    expect((await engagement.notifications.unreadCount(staffMember.principal)).unreadCount).toBe(0);
    await expect(
      engagement.notifications.markRead(staffMember.principal, staffNotif!.publicId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await engagement.notifications.markAllRead(staffMember.principal)).markedCount).toBe(0);
  });

  it("forwards canonical filePublicId and orderPublicId to registered storage actions on file.uploaded", async () => {
    const capturedContexts: Array<{
      filePublicId: string | null;
      orderPublicId: string | null;
      staffOnlyTrigger: boolean;
      correlationId: string;
    }> = [];

    automationsMod.registerAutomationAction({
      key: "storage.verify_file_context",
      label: "Verify file context",
      description: "Test action capturing filePublicId and orderPublicId.",
      category: "Storage and sync",
      owner: "storage",
      requiresOrderContext: true,
      forbidOnStaffOnlyTrigger: true,
      retrySafe: true,
      configSchema: z.strictObject({ folder: z.string().min(1) }),
      configFields: [{ key: "folder", label: "Folder", type: "string", required: true }],
      async run(ctx: AutomationActionRunContext<{ folder: string }>) {
        capturedContexts.push({
          filePublicId: ctx.filePublicId,
          orderPublicId: ctx.orderPublicId,
          staffOnlyTrigger: ctx.staffOnlyTrigger,
          correlationId: ctx.correlationId,
        });
        return { outcome: "completed", safeSummary: "Copied 1 file." };
      },
    });

    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const customer = await insertSyntheticUser(h, t.db, { role: "customer" });
    const caller = callerFor(admin.principal);
    await caller.automations.settings.update({ enabled: true });

    const order = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      3000,
      "File Forwarding Order",
    );

    await caller.automations.create({
      name: "Forward uploaded file",
      enabled: true,
      trigger: { kind: "event", triggerKey: "file.uploaded" },
      actions: [
        {
          stepKey: "copy_1",
          actionKey: "storage.verify_file_context",
          config: { folder: "/orders" },
        },
      ],
    });

    const canonicalFileId = ulid(h.clock.now().getTime() + 500);
    await h.deps.audit.record({
      category: "business",
      eventName: "file.uploaded",
      action: "create",
      outcome: "completed",
      actor: { userId: customer.id, role: "customer" },
      resource: { type: "file", publicId: canonicalFileId },
      attributes: {
        file_visibility: "customer_visible",
        file_category: "supporting",
        extension: "pdf",
        size_bytes: 4096,
        version_number: 1,
        order_public_id: order.publicId,
      },
    });
    await drainAutomationJobs();

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toMatchObject({
      filePublicId: canonicalFileId,
      orderPublicId: order.publicId,
      staffOnlyTrigger: false,
    });
    expect(capturedContexts[0]!.correlationId.startsWith(AUTOMATION_ORIGIN_PREFIX)).toBe(true);
  });

  it("deduplicates duplicate event evaluations, enforces hourly rate limits, retries transient failures, and fences ambiguous webhooks", async () => {
    let flakyAttempts = 0;
    automationsMod.registerAutomationAction({
      key: "test.flaky_step",
      label: "Flaky retryable action",
      description: "Fails once with retryable: true, then succeeds.",
      category: "Integrations",
      owner: "automations",
      retrySafe: true,
      configSchema: z.strictObject({}),
      configFields: [],
      async run() {
        flakyAttempts += 1;
        if (flakyAttempts === 1) {
          return {
            outcome: "failed",
            retryable: true,
            reasonCode: "TEMPORARY_UPSTREAM_TIMEOUT",
            safeSummary: "Temporary timeout; retry scheduled.",
          };
        }
        return { outcome: "completed", safeSummary: "Succeeded on retry." };
      },
    });

    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const caller = callerFor(admin.principal);
    await caller.automations.settings.update({ enabled: true });

    const signingSecret = "whsec_signing_key_for_hmac_verification_01";
    const auto = await caller.automations.create({
      name: "Retry + Webhook + RateLimit",
      enabled: true,
      maxRunsPerHour: 1,
      trigger: { kind: "manual", requireOrderPublicId: false },
      actions: [
        { stepKey: "flaky_1", actionKey: "test.flaky_step", config: {} },
        {
          stepKey: "hook_2",
          actionKey: "webhook.call",
          config: {
            url: "https://hooks.partner.example/manual",
            payloadFields: [],
          },
          secrets: { signingSecret },
        },
      ],
    });

    // Dry-run testRun does not execute actions or consume rate limit
    const dry = await caller.automations.testRun({
      publicId: auto.publicId,
      trigger: { kind: "manual", requireOrderPublicId: false },
      actions: [
        { stepKey: "flaky_1", actionKey: "test.flaky_step", config: {} },
        {
          stepKey: "hook_2",
          actionKey: "webhook.call",
          config: { url: "https://hooks.partner.example/manual", payloadFields: [] },
        },
      ],
      executeLive: false,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.conditionsMatched).toBe(true);
    expect(flakyAttempts).toBe(0);

    // First manual run: attempt 1 fails retryably -> schedules retry -> attempt 2 completes both steps & signs webhook!
    const firstManual = await caller.automations.triggerManual({ publicId: auto.publicId });
    await h.jobs.runAll(JOB_EXECUTE_RUN);
    expect(flakyAttempts).toBe(1);
    expect(capturedWebhooks).toHaveLength(0);

    await h.jobs.runAll(JOB_EXECUTE_RUN);
    expect(flakyAttempts).toBe(2);
    expect(capturedWebhooks).toHaveLength(1);

    const call = capturedWebhooks[0]!;
    expect(call.purpose).toBe("webhook");
    expect(call.options.requireAllowlistRule).toBe(true);
    const tsHeader = Number(call.options.headers?.["X-RP-Webhook-Timestamp"]);
    const sigHeader = call.options.headers?.["X-RP-Webhook-Signature"];
    const bodyStr = String(call.options.body);
    expect(sigHeader).toBe(signAutomationWebhook(signingSecret, tsHeader, bodyStr));
    expect(call.options.headers?.["X-RP-Automation-Origin"]).toBe("1");

    const runView = await caller.automations.runs.get({ runPublicId: firstManual.runPublicId });
    expect(runView.state).toBe("completed");
    expect(runView.steps[0]!.attemptCount).toBe(2);
    expect(runView.steps[1]!.state).toBe("completed");

    // Second manual run within the same hour (`maxRunsPerHour: 1`) -> `rate_limited`!
    const secondManual = await caller.automations.triggerManual({ publicId: auto.publicId });
    await drainAutomationJobs();
    const rateLimitedView = await caller.automations.runs.get({
      runPublicId: secondManual.runPublicId,
    });
    expect(rateLimitedView.state).toBe("rate_limited");
    expect(rateLimitedView.reasonCode).toBe("AUTOMATION_RATE_LIMITED");
    expect(capturedWebhooks).toHaveLength(1);

    // Advance clock > 1 hour, refresh step-up, and simulate post-`beforeSend` network drop on webhook -> `partial_unknown` (never retried!)
    h.clock.advance(3_700_000);
    const refreshedAdminCaller = callerFor({
      ...admin.principal,
      stepUpAt: h.clock.now(),
    });
    nextWebhookHandler = async (_url, _purpose, opts) => {
      if (opts.beforeSend) await opts.beforeSend();
      throw new Error("socket reset after bytes written");
    };

    const thirdManual = await refreshedAdminCaller.automations.triggerManual({
      publicId: auto.publicId,
    });
    await drainAutomationJobs();
    const unknownView = await refreshedAdminCaller.automations.runs.get({
      runPublicId: thirdManual.runPublicId,
    });
    expect(unknownView.state).toBe("partial_unknown");
    expect(unknownView.steps[1]!.state).toBe("unknown");
    expect(capturedWebhooks).toHaveLength(2); // Dispatched ONCE, never retried!

    // Scheduled automation tick test
    const schedAuto = await refreshedAdminCaller.automations.create({
      name: "Scheduled hourly digest",
      enabled: true,
      trigger: { kind: "schedule", everyMinutes: 15 },
      actions: [
        {
          stepKey: "admin_ping",
          actionKey: "notification.send_in_app",
          config: {
            recipientKey: "administrators",
            title: "Scheduled check",
            body: "All clear",
          },
        },
      ],
    });
    h.clock.advance(16 * 60_000);
    await h.jobs.enqueue(JOB_SCHEDULE_TICK, {});
    await h.jobs.runAll(JOB_SCHEDULE_TICK);
    await drainAutomationJobs();

    const schedRuns = await caller.automations.runs.list({
      automationPublicId: schedAuto.publicId,
    });
    expect(schedRuns.items).toHaveLength(1);
    expect(schedRuns.items[0]!.state).toBe("completed");
  });

  it("deduplicates duplicate evaluate jobs and marks lost-lease dispatching webhook steps unknown without re-sending", async () => {
    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const customer = await insertSyntheticUser(h, t.db, { role: "customer" });
    const caller = callerFor(admin.principal);
    await caller.automations.settings.update({ enabled: true });

    const auto = await caller.automations.create({
      name: "Dedup and lost-lease check",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "hook_1",
          actionKey: "webhook.call",
          config: {
            url: "https://hooks.partner.example/lease-check",
            payloadFields: ["order_reference"],
          },
          secrets: { signingSecret: "whsec_lease_check_secret_012345" },
        },
      ],
    });

    await placeCustomerOrder(admin.principal, customer.principal, 5000, "Dedup Order");
    const evalJobs = h.jobs.enqueued.filter((j) => j.type === JOB_EVALUATE_EVENT);
    expect(evalJobs).toHaveLength(1);

    // Enqueue a duplicate evaluate job with a different job idempotency key for the SAME eventId
    await h.jobs.enqueue(JOB_EVALUATE_EVENT, evalJobs[0]!.payload, {
      idempotencyKey: "dup_eval_delivery",
    });
    await h.jobs.runAll(JOB_EVALUATE_EVENT);

    // Only ONE run row was created despite duplicate evaluation!
    const queuedRuns = await caller.automations.runs.list({
      automationPublicId: auto.publicId,
    });
    expect(queuedRuns.items).toHaveLength(1);
    const runPublicId = queuedRuns.items[0]!.publicId;

    // Simulate a previous worker crashing AFTER marking the `webhook.call` step `"dispatching"`
    const [runDbRow] = await t.db
      .select({ id: automationTables.automationRuns.id })
      .from(automationTables.automationRuns)
      .where(eq(automationTables.automationRuns.publicId, runPublicId));
    await t.db
      .update(automationTables.automationRuns)
      .set({ state: "running", startedAt: h.clock.now() })
      .where(eq(automationTables.automationRuns.id, runDbRow!.id));
    await t.db
      .update(automationTables.automationRunSteps)
      .set({ state: "dispatching", attemptCount: 1, startedAt: h.clock.now() })
      .where(eq(automationTables.automationRunSteps.runId, runDbRow!.id));

    capturedWebhooks = [];
    await h.jobs.runAll(JOB_EXECUTE_RUN);

    // Lost-lease webhook step MUST NOT dispatch again; transitions to `unknown` / `partial_unknown`!
    expect(capturedWebhooks).toHaveLength(0);
    const afterReclaim = await caller.automations.runs.get({ runPublicId });
    expect(afterReclaim.state).toBe("partial_unknown");
    expect(afterReclaim.reasonCode).toBe("WEBHOOK_LEASE_LOST_IN_FLIGHT");
    expect(afterReclaim.steps[0]!.state).toBe("unknown");
  });

  it("lists workflow steps with bound automations and runs stage actions for staff with order context, idempotency, rate limits, and audit", async () => {
    const admin = await insertSyntheticUser(h, t.db, {
      role: "admin",
      name: "Ada Admin",
      stepUp: true,
    });
    const staff = await insertSyntheticUser(h, t.db, {
      role: "staff",
      name: "Sam Staff",
      stepUp: false,
    });
    const customer = await insertSyntheticUser(h, t.db, {
      role: "customer",
      name: "Casey Customer",
    });

    const adminCaller = callerFor(admin.principal);
    const staffCaller = callerFor(staff.principal);
    const customerCaller = callerFor(customer.principal);

    const order = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      12_500,
      "Stage Actions Packet",
    );
    // Clear any initial order.created tap jobs from order placement before creating automations.
    h.jobs.enqueued.length = 0;

    // 1. Enabled `order.created` -> binds ONLY to `initial` step (`submitted`).
    const createdAuto = await adminCaller.automations.create({
      name: "Initial welcome alert",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "notify_staff",
          actionKey: "notification.send_in_app",
          label: "Alert staff on intake",
          config: {
            recipientKey: "staff",
            title: "Intake ready {{order_reference}}",
            body: "Order {{order_reference}} is at {{order_status_label}}.",
          },
        },
      ],
    });

    // 2. Enabled `order.status_changed` targeting `in_review` (maxRunsPerHour: 1 to also verify rate limits).
    const reviewAuto = await adminCaller.automations.create({
      name: "Review stage customer update",
      description: "Sends customer + acting staff notice for review stage.",
      enabled: true,
      maxRunsPerHour: 1,
      trigger: { kind: "event", triggerKey: "order.status_changed" },
      conditions: {
        match: "all",
        groups: [
          {
            match: "all",
            conditions: [{ field: "to_status", operator: "eq", value: "in_review" }],
          },
        ],
      },
      actions: [
        {
          stepKey: "notify_owner",
          actionKey: "notification.send_in_app",
          label: "Notify order owner",
          config: {
            recipientKey: "order_owner",
            title: "Stage update {{order_reference}}",
            body: "Your order {{order_reference}} stage action ran for {{order_status_label}}.",
          },
        },
        {
          stepKey: "notify_actor",
          actionKey: "notification.send_in_app",
          label: "Confirm to acting staff",
          config: {
            recipientKey: "actor",
            title: "Ran review stage {{order_reference}}",
            body: "Executed by {{actor_role}}.",
          },
        },
      ],
    });

    // 3. Enabled `order.status_changed` with `in` operator targeting `in_progress` and `delivered`.
    await adminCaller.automations.create({
      name: "Production & delivery milestone",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.status_changed" },
      conditions: {
        match: "all",
        groups: [
          {
            match: "all",
            conditions: [
              { field: "to_status", operator: "in", value: ["in_progress", "delivered"] },
            ],
          },
        ],
      },
      actions: [
        {
          stepKey: "milestone_ping",
          actionKey: "notification.send_in_app",
          config: {
            recipientKey: "administrators",
            title: "Milestone {{order_reference}}",
            body: "Milestone {{to_status}}",
          },
        },
      ],
    });

    // 4. Disabled automation targeting `in_review` + unconstrained catch-all + `neq` rule -> must NOT bind.
    await adminCaller.automations.create({
      name: "Disabled review rule",
      enabled: false,
      trigger: { kind: "event", triggerKey: "order.status_changed" },
      conditions: {
        match: "all",
        groups: [
          {
            match: "all",
            conditions: [{ field: "to_status", operator: "eq", value: "in_review" }],
          },
        ],
      },
      actions: [
        {
          stepKey: "noop",
          actionKey: "notification.send_in_app",
          config: { recipientKey: "administrators", title: "Disabled", body: "Disabled" },
        },
      ],
    });
    await adminCaller.automations.create({
      name: "Global status catch-all",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.status_changed" },
      actions: [
        {
          stepKey: "catch_all",
          actionKey: "notification.send_in_app",
          config: { recipientKey: "administrators", title: "Any", body: "Any" },
        },
      ],
    });
    await adminCaller.automations.create({
      name: "Non-canceled catch-all",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.status_changed" },
      conditions: {
        match: "all",
        groups: [
          {
            match: "all",
            conditions: [{ field: "to_status", operator: "neq", value: "canceled" }],
          },
        ],
      },
      actions: [
        {
          stepKey: "not_canceled",
          actionKey: "notification.send_in_app",
          config: { recipientKey: "administrators", title: "Not canceled", body: "Not canceled" },
        },
      ],
    });

    // While engine is disabled (default): staff can inspect stage actions and sees clear engineDisabledReason.
    const disabledView = await staffCaller.automations.orderStageActions.get({
      orderPublicId: order.publicId,
    });
    expect(disabledView.engineEnabled).toBe(false);
    expect(disabledView.engineDisabledReason).toContain("Automations engine is turned off");
    expect(disabledView.canManageAutomations).toBe(false);
    expect(disabledView.currentStatusKey).toBe("submitted");

    const submittedStep = disabledView.steps.find((s) => s.stepKey === "submitted")!;
    expect(submittedStep.isCurrentOrderStep).toBe(true);
    expect(submittedStep.automations.map((a) => a.publicId)).toEqual([createdAuto.publicId]);

    const reviewStep = disabledView.steps.find((s) => s.stepKey === "in_review")!;
    expect(reviewStep.configuredAutomationCount).toBe(1);
    expect(reviewStep.configuredActionCount).toBe(2);
    expect(reviewStep.automations[0]!.publicId).toBe(reviewAuto.publicId);
    expect(reviewStep.automations[0]!.actionLabels).toEqual([
      "Notify order owner",
      "Confirm to acting staff",
    ]);

    const deliveredStep = disabledView.steps.find((s) => s.stepKey === "delivered")!;
    expect(deliveredStep.configuredAutomationCount).toBe(1);
    const canceledStep = disabledView.steps.find((s) => s.stepKey === "canceled")!;
    expect(canceledStep.configuredAutomationCount).toBe(0);

    // Engine-disabled check refuses `runForOrder` with PRECONDITION_FAILED / AUTOMATIONS_DISABLED.
    await expect(
      staffCaller.automations.orderStageActions.runForOrder({
        orderPublicId: order.publicId,
        stepKey: "in_review",
        idempotencyKey: "idem-disabled-0001",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Enable the automations engine as admin.
    await adminCaller.automations.settings.update({ enabled: true });
    const adminView = await adminCaller.automations.orderStageActions.get({
      orderPublicId: order.publicId,
    });
    expect(adminView.engineEnabled).toBe(true);
    expect(adminView.engineDisabledReason).toBeNull();
    expect(adminView.canManageAutomations).toBe(true);

    // Staff runs `in_review` stage actions WITHOUT step-up.
    const firstRun = await staffCaller.automations.orderStageActions.runForOrder({
      orderPublicId: order.publicId,
      stepKey: "in_review",
      idempotencyKey: "stage-idem-review-01",
    });
    expect(firstRun.orderPublicId).toBe(order.publicId);
    expect(firstRun.stepKey).toBe("in_review");
    expect(firstRun.queuedRuns).toHaveLength(1);
    expect(firstRun.queuedRuns[0]!.deduplicated).toBe(false);

    // Repeating with the same idempotencyKey deduplicates without queuing a second run or duplicate audit row.
    const dupRun = await staffCaller.automations.orderStageActions.runForOrder({
      orderPublicId: order.publicId,
      stepKey: "in_review",
      idempotencyKey: "stage-idem-review-01",
    });
    expect(dupRun.queuedRuns).toHaveLength(1);
    expect(dupRun.queuedRuns[0]!.deduplicated).toBe(true);
    expect(dupRun.queuedRuns[0]!.runPublicId).toBe(firstRun.queuedRuns[0]!.runPublicId);

    await drainAutomationJobs();

    // Verify run history row is tagged with orderPublicId, stageStepKey, and acting staff user.
    const runsPage = await staffCaller.automations.orderStageActions.listRuns({
      orderPublicId: order.publicId,
    });
    expect(runsPage.items).toHaveLength(1);
    expect(runsPage.items[0]!.publicId).toBe(firstRun.queuedRuns[0]!.runPublicId);
    expect(runsPage.items[0]!.state).toBe("completed");
    expect(runsPage.items[0]!.orderPublicId).toBe(order.publicId);
    expect(runsPage.items[0]!.stageStepKey).toBe("in_review");
    expect(runsPage.items[0]!.triggeredBy).toEqual({
      publicId: staff.publicId,
      displayName: "Sam Staff",
      role: "staff",
    });

    // Verify order context & recipients executed cleanly through the engine (without changing order status!).
    const refreshedOrder = await orders.getOrderSummary(staff.principal, order.publicId);
    expect(refreshedOrder.statusKey).toBe("submitted");

    const customerNotifs = await customerCaller.engagement.notifications.list({});
    expect(
      customerNotifs.items.some(
        (n) =>
          n.title.includes(order.reference) &&
          n.body.includes("Being reviewed"),
      ),
    ).toBe(true);
    const staffNotifs = await staffCaller.engagement.notifications.list({});
    expect(
      staffNotifs.items.some(
        (n) => n.title.includes(order.reference) && n.body.includes("Executed by staff."),
      ),
    ).toBe(true);

    // Verify `order.stage_actions.run` appears in staff Order history under `automation` and is hidden from customers.
    const staffHistory = await auditCenter.orderActivity(staff.principal, {
      orderPublicId: order.publicId,
      category: "automation",
    });
    expect(staffHistory.view).toBe("staff");
    if (staffHistory.view === "staff") {
      const stageAudit = staffHistory.items.filter(
        (item) => item.eventName === "order.stage_actions.run",
      );
      expect(stageAudit).toHaveLength(1);
      expect(stageAudit[0]!.details.step_key).toBe("in_review");
    }
    const customerHistory = await auditCenter.orderActivity(customer.principal, {
      orderPublicId: order.publicId,
    });
    expect(customerHistory.items.some((i) => i.category === "automation")).toBe(false);

    // Existing per-automation hourly limit (`maxRunsPerHour: 1`) still governs stage-action runs!
    const rateLimitedRun = await staffCaller.automations.orderStageActions.runForOrder({
      orderPublicId: order.publicId,
      stepKey: "in_review",
      idempotencyKey: "stage-idem-review-02",
    });
    expect(rateLimitedRun.queuedRuns[0]!.deduplicated).toBe(false);
    await drainAutomationJobs();

    const afterSecond = await staffCaller.automations.orderStageActions.listRuns({
      orderPublicId: order.publicId,
    });
    expect(afterSecond.items).toHaveLength(2);
    expect(afterSecond.items[0]!.state).toBe("rate_limited");
    expect(afterSecond.items[0]!.reasonCode).toBe("AUTOMATION_RATE_LIMITED");
  });

  it("enforces customer permission boundary on orderStageActions router and service methods", async () => {
    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const customer = await insertSyntheticUser(h, t.db, { role: "customer" });
    const order = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      9_000,
      "Customer Boundary Order",
    );

    const customerCaller = callerFor(customer.principal);

    await expect(
      customerCaller.automations.orderStageActions.get({ orderPublicId: order.publicId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      customerCaller.automations.orderStageActions.listRuns({ orderPublicId: order.publicId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      customerCaller.automations.orderStageActions.runForOrder({
        orderPublicId: order.publicId,
        stepKey: "submitted",
        idempotencyKey: "cust-denied-0001",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Direct service-layer boundary checks also fail closed with AUTOMATIONS_FORBIDDEN + durable denial audit.
    await expect(
      automationsMod.getOrderStageActions(customer.principal, { orderPublicId: order.publicId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "AUTOMATIONS_FORBIDDEN",
    });
    await expect(
      automationsMod.runForOrder(customer.principal, {
        orderPublicId: order.publicId,
        stepKey: "submitted",
        idempotencyKey: "cust-denied-0002",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "AUTOMATIONS_FORBIDDEN",
    });
  });

  it("proves a stage-action run cannot change order status or permissions even if persisted step rows are tampered", async () => {
    const admin = await insertSyntheticUser(h, t.db, { role: "admin", stepUp: true });
    const staff = await insertSyntheticUser(h, t.db, { role: "staff" });
    const customer = await insertSyntheticUser(h, t.db, { role: "customer" });

    const adminCaller = callerFor(admin.principal);
    const staffCaller = callerFor(staff.principal);
    await adminCaller.automations.settings.update({ enabled: true });

    const order = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      15_000,
      "Immutable Status & Role Proof",
    );
    h.jobs.enqueued.length = 0;

    // Layer 1: Registration and create/update reject status-changing and permission-changing action keys.
    expect(() => assertAllowedActionKey("order.status.set")).toThrow(/prohibited/i);
    expect(() => assertAllowedActionKey("order.transition")).toThrow(/prohibited/i);
    expect(() => assertAllowedActionKey("identity.role.assign")).toThrow(/prohibited/i);
    expect(() => assertAllowedActionKey("identity.permission.grant")).toThrow(/prohibited/i);

    expect(() =>
      automationsMod.registerAutomationAction({
        key: "order.status.set",
        label: "Illegal status mutator",
        description: "Must never register",
        category: "Messaging",
        owner: "automations",
        requiresOrderContext: false,
        forbidOnStaffOnlyTrigger: false,
        retrySafe: true,
        configFields: [],
        configSchema: z.object({}),
        async run() {
          return { outcome: "completed" };
        },
      }),
    ).toThrow(/prohibited/i);

    await expect(
      adminCaller.automations.create({
        name: "Illegal status stage action",
        enabled: true,
        trigger: { kind: "event", triggerKey: "order.created" },
        actions: [{ stepKey: "mut_status", actionKey: "order.status.set", config: {} }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      adminCaller.automations.create({
        name: "Illegal role stage action",
        enabled: true,
        trigger: { kind: "event", triggerKey: "order.created" },
        actions: [{ stepKey: "mut_role", actionKey: "identity.role.assign", config: {} }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Layer 2: Even if a valid stage-bound automation's persisted version/run-step rows are tampered in DB
    // before the worker executes a `runForOrder` job, the worker blocks execution with `ACTION_PROHIBITED`
    // and leaves order status and user roles untouched.
    const stageAuto = await adminCaller.automations.create({
      name: "Stage action tampered at rest",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.status_changed" },
      conditions: {
        match: "all",
        groups: [
          {
            match: "all",
            conditions: [{ field: "to_status", operator: "eq", value: "in_review" }],
          },
        ],
      },
      actions: [
        {
          stepKey: "step_status",
          actionKey: "notification.send_in_app",
          config: { recipientKey: "administrators", title: "Safe", body: "Safe" },
        },
        {
          stepKey: "step_role",
          actionKey: "notification.send_in_app",
          config: { recipientKey: "administrators", title: "Safe 2", body: "Safe 2" },
        },
      ],
    });

    const stageRun = await staffCaller.automations.orderStageActions.runForOrder({
      orderPublicId: order.publicId,
      stepKey: "in_review",
      idempotencyKey: "tamper-proof-0001",
    });
    const runPublicId = stageRun.queuedRuns[0]!.runPublicId;

    const [autoDbRow] = await t.db
      .select({ id: automationTables.automations.id })
      .from(automationTables.automations)
      .where(eq(automationTables.automations.publicId, stageAuto.publicId));
    const [runDbRow] = await t.db
      .select({ id: automationTables.automationRuns.id })
      .from(automationTables.automationRuns)
      .where(eq(automationTables.automationRuns.publicId, runPublicId));

    await t.db
      .update(automationTables.automationVersions)
      .set({
        actionsJson: JSON.stringify([
          { stepKey: "step_status", actionKey: "order.status.set", label: null, config: { to: "completed" } },
          { stepKey: "step_role", actionKey: "identity.role.assign", label: null, config: { role: "admin" } },
        ]),
      })
      .where(eq(automationTables.automationVersions.automationId, autoDbRow!.id));

    await t.db
      .update(automationTables.automationRunSteps)
      .set({ actionKey: "order.status.set" })
      .where(eq(automationTables.automationRunSteps.runId, runDbRow!.id));

    await drainAutomationJobs();

    const finishedRun = await adminCaller.automations.runs.get({ runPublicId });
    expect(finishedRun.state).toBe("failed");
    expect(finishedRun.reasonCode).toBe("ACTION_PROHIBITED");
    expect(finishedRun.steps[0]!.state).toBe("failed");
    expect(finishedRun.steps[0]!.reasonCode).toBe("ACTION_PROHIBITED");
    expect(finishedRun.steps[1]!.state).toBe("skipped");
    expect(finishedRun.steps[1]!.reasonCode).toBe("PRIOR_STEP_FAILED");

    // Verify neither order status nor customer/staff roles changed in MySQL.
    const [orderRowAfter] = await t.db
      .select({ statusKey: orderTables.orders.statusKey })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, order.publicId));
    expect(orderRowAfter!.statusKey).toBe("submitted");

    const [customerRowAfter] = await t.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, customer.id));
    const [staffRowAfter] = await t.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, staff.id));
    expect(customerRowAfter!.role).toBe("customer");
    expect(staffRowAfter!.role).toBe("staff");
  });

  it("Increment 09: registers automations TrashParticipant synchronously, resolves preferredName greeting, and passes orderId to mailer.enqueue", async () => {
    const participant = trashParticipants.get("automations");
    expect(participant).toBeDefined();
    expect(participant?.module).toBe("automations");

    const admin = await insertSyntheticUser(h, t.db, {
      role: "admin",
      stepUp: true,
      name: "Admin Operator",
    });
    const customer = await insertSyntheticUser(h, t.db, {
      role: "customer",
      name: "Zeus Greene",
    });
    // Store structured first/preferred name parts on customer.
    await t.db
      .update(users)
      .set({
        firstNameEnc: h.deps.crypto.encrypt("Zeus", `users.first_name:${customer.publicId}`),
        preferredNameEnc: h.deps.crypto.encrypt("Zee", `users.preferred_name:${customer.publicId}`),
      })
      .where(eq(users.id, customer.id));

    const caller = callerFor(admin.principal);
    await caller.automations.settings.update({ enabled: true });

    const capturedOrderIds: Array<number | undefined> = [];
    const origEnqueue = h.deps.mailer.enqueue.bind(h.deps.mailer);
    h.deps.mailer.enqueue = async (msg, tx) => {
      capturedOrderIds.push(msg.orderId);
      return origEnqueue(msg, tx);
    };

    await caller.automations.create({
      name: "Greeting + orderId check",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "mail_1",
          actionKey: "email.send_template",
          config: {
            recipientMode: "trigger",
            recipientKey: "order_owner",
            subject: "Welcome {{order_reference}}",
            body: "Hi {{recipient_name}}, your project {{order_reference}} is in.",
          },
        },
      ],
    });

    h.mailer.sent = [];
    const placed = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      4000,
      "Ice Queen",
    );
    await drainAutomationJobs();

    const [orderRow] = await t.db
      .select({ id: orderTables.orders.id })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, placed.publicId));

    const autoMail = h.mailer.sent.find((m) => m.template === "automations.generic_notice");
    expect(autoMail).toBeDefined();
    expect(autoMail!.vars.body).toContain("Hi Zee,");
    expect(capturedOrderIds).toContain(orderRow!.id);
  });

  it("Increment 09 D2.2 & D2.8: suppresses triggers for trashed orders/customers, halts mid-flight queued runs at worker fence, and hides trashed runs from lists/detail", async () => {
    const admin = await insertSyntheticUser(h, t.db, {
      role: "admin",
      stepUp: true,
      name: "Admin Operator",
    });
    const customer = await insertSyntheticUser(h, t.db, {
      role: "customer",
      name: "Zeus Greene",
    });
    const caller = callerFor(admin.principal);
    await caller.automations.settings.update({ enabled: true });

    const createdAuto = await caller.automations.create({
      name: "Order placed notice",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "mail_1",
          actionKey: "email.send_template",
          config: {
            recipientMode: "trigger",
            recipientKey: "order_owner",
            subject: "Order {{order_reference}}",
            body: "Hello {{recipient_name}}",
          },
        },
      ],
    });

    // Case 1: Order is placed and evaluated (`JOB_EVALUATE_EVENT` queues run), then order is trashed
    // BEFORE `JOB_EXECUTE_RUN` executes -> worker fence cancels run without sending mail, and run is hidden!
    const order1 = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      5000,
      "Ice Queen",
    );
    await h.jobs.runAll(JOB_EVALUATE_EVENT);

    const beforeTrashList = await caller.automations.runs.list({
      automationPublicId: createdAuto.publicId,
    });
    expect(beforeTrashList.items).toHaveLength(1);
    const queuedRunPublicId = beforeTrashList.items[0]!.publicId;

    h.mailer.sent = [];
    await t.db
      .update(orderTables.orders)
      .set({ trashedAt: h.clock.now(), trashBatchId: ulid() })
      .where(eq(orderTables.orders.publicId, order1.publicId));

    await h.jobs.runAll(JOB_EXECUTE_RUN);
    expect(h.mailer.sent.filter((m) => m.template === "automations.generic_notice")).toHaveLength(0);

    // D2.2 visibility: trashed order's run is absent from `runs.list` and returns NOT_FOUND on `runs.get`.
    const afterTrashList = await caller.automations.runs.list({
      automationPublicId: createdAuto.publicId,
    });
    expect(afterTrashList.items).toHaveLength(0);
    await expect(
      caller.automations.runs.get({ runPublicId: queuedRunPublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Case 2: Event arrives after customer is already trashed -> `JOB_EVALUATE_EVENT` queues ZERO runs.
    const order2 = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      5000,
      "Second Filing",
    );
    await t.db
      .update(users)
      .set({ trashedAt: h.clock.now(), trashBatchId: ulid() })
      .where(eq(users.id, customer.id));

    await drainAutomationJobs();
    const [order2Run] = await t.db
      .select()
      .from(automationTables.automationRuns)
      .where(eq(automationTables.automationRuns.orderPublicId, order2.publicId));
    expect(order2Run).toBeUndefined();
  });

  it("Increment 09 D2.6 & D2.8: purge participant enforces assertCurrentInTx fence, leaves data intact on PURGE_FENCE_LOST, and erases run payloads idempotently", async () => {
    const participant = trashParticipants.get("automations")!;
    expect(participant).toBeDefined();

    const admin = await insertSyntheticUser(h, t.db, {
      role: "admin",
      stepUp: true,
      name: "Admin Operator",
    });
    const customer = await insertSyntheticUser(h, t.db, {
      role: "customer",
      name: "Zeus Greene",
    });
    const caller = callerFor(admin.principal);
    await caller.automations.settings.update({ enabled: true });

    await caller.automations.create({
      name: "Purge payload test",
      enabled: true,
      trigger: { kind: "event", triggerKey: "order.created" },
      actions: [
        {
          stepKey: "notif_1",
          actionKey: "notification.send_in_app",
          config: {
            recipientKey: "order_owner",
            title: "Order {{order_reference}}",
            body: "Created for {{recipient_name}}",
          },
        },
      ],
    });

    const placed = await placeCustomerOrder(
      admin.principal,
      customer.principal,
      3000,
      "Ice Queen",
    );
    await drainAutomationJobs();

    const [orderRow] = await t.db
      .select({ id: orderTables.orders.id, publicId: orderTables.orders.publicId })
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, placed.publicId));
    const [runBefore] = await t.db
      .select()
      .from(automationTables.automationRuns)
      .where(eq(automationTables.automationRuns.orderPublicId, placed.publicId));
    expect(runBefore).toBeDefined();
    expect(runBefore!.evaluatedFieldsJson).not.toBe("{}");

    // Seed an order stage run row to verify order-scoped cleanup on purge.
    await t.db.insert(automationTables.orderStageRuns).values({
      publicId: ulid(),
      orderId: orderRow!.id,
      orderPublicId: orderRow!.publicId,
      workflowVersionId: 1,
      stageKey: "in_review",
      stageLabel: "In Review",
      triggeredByUserId: admin.id,
      idempotencyKey: "stage-idem-1",
      correlationId: ulid(),
      state: "completed",
      bundleSnapshotJson: "[]",
      resultsJson: "[]",
      finishedAt: h.clock.now(),
    });

    const batchId = ulid();
    const entity = {
      kind: "order" as const,
      id: orderRow!.id,
      publicId: orderRow!.publicId,
      batchId,
    };

    const summaryBefore = await participant.summarize!(entity);
    expect(summaryBefore.automationRuns).toBeGreaterThanOrEqual(1);
    expect(summaryBefore.stageRuns).toBe(1);

    // 1) Throwing fence (`PURGE_FENCE_LOST`) MUST abort and leave all data unchanged!
    const lostFenceRun = unfencedPurgeRunForTests("run-lost-fence", {
      async assertCurrentInTx() {
        throw new DomainError("CONFLICT", "PURGE_FENCE_LOST", "Purge run ownership lost.");
      },
    });
    await expect(participant.purge!(entity, lostFenceRun)).rejects.toMatchObject({
      reasonCode: "PURGE_FENCE_LOST",
    });

    const [runAfterFailedFence] = await t.db
      .select()
      .from(automationTables.automationRuns)
      .where(eq(automationTables.automationRuns.id, runBefore!.id));
    expect(runAfterFailedFence!.evaluatedFieldsJson).not.toBe("{}");
    const stageAfterFailedFence = await t.db
      .select()
      .from(automationTables.orderStageRuns)
      .where(eq(automationTables.orderStageRuns.orderId, orderRow!.id));
    expect(stageAfterFailedFence).toHaveLength(1);

    // 2) Valid purge run erases payload copies, clears step summaries/refs, and deletes stage runs idempotently.
    const validRun = unfencedPurgeRunForTests("run-valid-1");
    const purgeRes1 = await participant.purge!(entity, validRun);
    expect(purgeRes1.deleted.automationRunPayloads).toBeGreaterThanOrEqual(1);
    expect(purgeRes1.deleted.stageRuns).toBe(1);

    const [runAfterPurge] = await t.db
      .select()
      .from(automationTables.automationRuns)
      .where(eq(automationTables.automationRuns.id, runBefore!.id));
    expect(runAfterPurge!.evaluatedFieldsJson).toBe("{}");
    expect(runAfterPurge!.contextSnapshotEnc).toBeNull();

    const stepsAfterPurge = await t.db
      .select()
      .from(automationTables.automationRunSteps)
      .where(eq(automationTables.automationRunSteps.runId, runBefore!.id));
    expect(stepsAfterPurge.every((s) => s.safeSummary === null && s.externalRef === null)).toBe(
      true,
    );

    const stageAfterPurge = await t.db
      .select()
      .from(automationTables.orderStageRuns)
      .where(eq(automationTables.orderStageRuns.orderId, orderRow!.id));
    expect(stageAfterPurge).toHaveLength(0);

    // 3) Re-running purge is idempotent (`deleted: {}`).
    const purgeRes2 = await participant.purge!(entity, unfencedPurgeRunForTests("run-valid-2"));
    expect(purgeRes2.deleted).toEqual({});
  });
});
