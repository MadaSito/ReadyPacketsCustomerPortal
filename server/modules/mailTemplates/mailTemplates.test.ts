import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { MailTemplate, OutboundMail, SessionPrincipal } from "../../core/types.js";
import { registerComplianceMailTemplates } from "../compliance/mail.js";
import { registerEngagementMailTemplates } from "../engagement/mail.js";
import { IDENTITY_MAIL_TEMPLATES } from "../identity/mail.js";
import { users } from "../identity/schema.js";
import { ORDER_PHASE_UPDATE_TEMPLATE } from "../jobs/mail.js";
import type { MailTemplateStore } from "../jobs/mailPorts.js";
import { registerOrderMailTemplates } from "../orders/mail.js";
import { SEND_TEMPLATE_AUTOMATION_ACTION } from "./automationAction.js";
import { createMailTemplatesModule, type MailTemplatesModule } from "./index.js";
import { mailTemplates, mailTemplateVersions } from "./schema.js";

let tdb: TestDb;
let h: TestHarness;
let mod: MailTemplatesModule;
let registeredStore: MailTemplateStore | null;
let builtins: MailTemplate[];
let enqueuedMails: Array<{ mail: OutboundMail; correlationId: string | undefined }>;
let adminUserId: number;
let staffUserId: number;
let customerUserId: number;
let adminPrincipal: SessionPrincipal;

async function insertUser(role: "admin" | "staff" | "customer", email: string, displayName: string): Promise<number> {
  const now = h.clock.now();
  const publicId = ulid(now.getTime());
  const [res] = await tdb.db.insert(users).values({
    publicId,
    role,
    status: "active",
    emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
    emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
    nameEnc: h.deps.crypto.encrypt(displayName, `users.name:${publicId}`),
    createdAt: now,
    updatedAt: now,
  });
  return Number(res.insertId);
}

beforeAll(async () => {
  tdb = await createTestDb({ schema: { users, mailTemplates, mailTemplateVersions } });
});

afterAll(async () => {
  await tdb?.cleanup();
});

beforeEach(async () => {
  await tdb.db.delete(mailTemplateVersions);
  await tdb.db.delete(mailTemplates);
  await tdb.db.delete(users);

  h = createTestDeps({
    db: tdb.db,
    config: { canonicalOrigin: "https://portal.readypackets.test" },
  });

  builtins = [];
  registeredStore = null;
  enqueuedMails = [];

  h.deps.mailer.registerTemplate = (tpl: MailTemplate) => {
    builtins.push(tpl);
  };
  h.deps.mailer.enqueue = async (mail: OutboundMail) => {
    enqueuedMails.push({ mail, correlationId: getRequestContext()?.correlationId });
  };

  for (const tpl of IDENTITY_MAIL_TEMPLATES) h.deps.mailer.registerTemplate(tpl);
  registerOrderMailTemplates(h.deps.mailer);
  h.deps.mailer.registerTemplate(ORDER_PHASE_UPDATE_TEMPLATE);
  registerComplianceMailTemplates(h.deps.mailer);
  registerEngagementMailTemplates(h.deps.mailer);

  adminUserId = await insertUser("admin", "admin@readypackets.test", "Ada Admin");
  staffUserId = await insertUser("staff", "staff@readypackets.test", "Sam Staff");
  customerUserId = await insertUser("customer", "customer@readypackets.test", "Casey Customer");

  adminPrincipal = fakePrincipal({
    userId: adminUserId,
    role: "admin",
    stepUpAt: h.clock.now(),
  });

  h.services.jobAdmin = {
    registerMailTemplateStore(store: MailTemplateStore) {
      registeredStore = store;
    },
    getBuiltinMailTemplates() {
      return builtins.filter((t) => t.key !== "jobs.mail.verify_audit_copy");
    },
  } as unknown as TestHarness["services"]["jobAdmin"];

  mod = createMailTemplatesModule(h.deps);
  h.services.mailTemplates = mod;
  mod.init?.();
});

describe("mailTemplates module (Package D)", () => {
  it("uses the new synthetic order reference in system samples", async () => {
    const template = await mod.get(adminPrincipal, { templateKey: "orders.status_changed" });
    const expected = expect.objectContaining({ name: "reference", sampleValue: "RP-A1B2-ZEUGRE-ICEQUE-001" });
    expect(template.declaredVars).toContainEqual(expected);
    await tdb.db.update(mailTemplates).set({
      declaredVarsJson: template.declaredVars.map((spec) => spec.name === "reference" ? { ...spec, sampleValue: "RP-2026-000100" } : spec),
    }).where(eq(mailTemplates.templateKey, template.templateKey));
    expect((await mod.get(adminPrincipal, { templateKey: template.templateKey })).declaredVars).toContainEqual(expected);
  });
  it("limits phase actions to the approved contracts and compatible published custom mail", async () => {
    async function create(templateKey: string, name: string, variable: string, sensitive = false) {
      return mod.createCustom(adminPrincipal, {
        templateKey, name, category: "orders",
        declaredVars: [{ name: variable, label: "Test variable", required: true, sensitive, sampleValue: "RP-TEST" }],
        format: "text", subject: "An update", bodyText: `Review {{${variable}}}.`,
      });
    }
    const supported = await create("custom.phase_supported", "Supported phase template", "reference");
    await create("custom.phase_draft", "Unpublished phase draft", "reference");
    const unrelated = await create("custom.phase_unrelated", "Unrelated phase template", "recipient_name");
    const sensitive = await create("custom.phase_sensitive", "Sensitive phase template", "reference", true);
    for (const { templateKey, version } of [supported, unrelated, sensitive]) {
      await mod.publish(adminPrincipal, { templateKey, expectedVersion: version });
    }
    expect((await mod.listForPhaseActions(adminPrincipal)).map(({ templateKey }) => templateKey).sort()).toEqual([
      "custom.phase_supported", "orders.phase_update", "orders.status_changed",
    ]);
    expect(await mod.resolveForPhaseAction("orders.phase_update")).toMatchObject({ vars: ["reference", "link"] });
    expect(await mod.resolveForPhaseAction("custom.phase_supported")).toMatchObject({ vars: ["reference"] });
    for (const key of ["auth.password_reset", "custom.phase_draft", "custom.phase_unrelated", "custom.phase_sensitive"]) {
      expect(await mod.resolveForPhaseAction(key)).toBeNull();
    }
    await expect(mod.listForPhaseActions(fakePrincipal({ role: "staff", userId: staffUserId }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("syncs all shipped built-in system templates while excluding jobs.mail.verify_audit_copy", async () => {
    const { items } = await mod.list(adminPrincipal, {});
    const keys = items.map((i) => i.templateKey);

    expect(keys).toContain("auth.verify_email");
    expect(keys).toContain("auth.invitation");
    expect(keys).toContain("auth.password_reset");
    expect(keys).toContain("auth.password_changed");
    expect(keys).toContain("orders.confirmed");
    expect(keys).toContain("orders.status_changed");
    expect(keys).toContain("compliance.invoice_issued");
    expect(keys).toContain("compliance.invoice_paid");
    expect(keys).toContain("engagement.ticket_updated");
    expect(keys).toContain("platform.maintenance_window");
    expect(keys).not.toContain("jobs.mail.verify_audit_copy");

    expect(registeredStore).not.toBeNull();
    expect(await registeredStore!.resolve("jobs.mail.verify_audit_copy")).toBeNull();
    expect(await registeredStore!.resolve("auth.password_reset")).toBeNull();
  });

  it("enforces required sensitive variables on system template publish, supports redacted renders, and resets to default", async () => {
    const initial = await mod.get(adminPrincipal, { templateKey: "auth.password_reset" });
    expect(initial.hasPublishedOverride).toBe(false);

    // Save a draft missing `{{link}}` — saving a work-in-progress draft succeeds, but publishing MUST fail!
    const missingLinkDraft = await mod.saveDraft(adminPrincipal, {
      templateKey: "auth.password_reset",
      expectedVersion: initial.version,
      format: "html",
      subject: "Reset your password",
      bodyHtml: "<p>Please contact support to reset your password.</p>",
      deriveTextFromHtml: true,
    });

    await expect(
      mod.publish(adminPrincipal, {
        templateKey: "auth.password_reset",
        expectedVersion: missingLinkDraft.version,
      }),
    ).rejects.toThrow(/MISSING_REQUIRED_TEMPLATE_VARIABLES/);

    // Also fail if HTML includes {{link}} but custom plain-text alternative omits {{link}}
    const missingTextVarDraft = await mod.saveDraft(adminPrincipal, {
      templateKey: "auth.password_reset",
      expectedVersion: missingLinkDraft.version,
      format: "html",
      subject: "Reset your password",
      bodyHtml: '<p>Reset here: <a href="{{link}}" data-rp-button="primary">Reset</a></p>',
      bodyText: "Plain text missing the reset URL placeholder.",
      deriveTextFromHtml: false,
    });

    await expect(
      mod.publish(adminPrincipal, {
        templateKey: "auth.password_reset",
        expectedVersion: missingTextVarDraft.version,
      }),
    ).rejects.toThrow(/MISSING_REQUIRED_TEMPLATE_VARIABLES/);

    // Save valid draft with {{link}} in both HTML and derived plain text, then publish
    const validDraft = await mod.saveDraft(adminPrincipal, {
      templateKey: "auth.password_reset",
      expectedVersion: missingTextVarDraft.version,
      format: "html",
      subject: "Action required: reset your ReadyPackets password",
      bodyHtml: '<p>Click below to reset:</p><p><a href="{{link}}" data-rp-button="primary">Choose new password</a></p>',
      deriveTextFromHtml: true,
      changeNote: "Brand button update",
    });

    const published = await mod.publish(adminPrincipal, {
      templateKey: "auth.password_reset",
      expectedVersion: validDraft.version,
    });
    expect(published.hasPublishedOverride).toBe(true);
    expect(published.activePublished?.versionNumber).toBe(1);

    const resolved = await registeredStore!.resolve("auth.password_reset");
    expect(resolved).not.toBeNull();
    expect(resolved!.sensitiveVars).toContain("link");

    const liveRender = resolved!.render({
      link: "https://portal.readypackets.test/reset?token=secret_tok_999",
    });
    expect(liveRender.subject).toBe("Action required: reset your ReadyPackets password");
    expect(liveRender.html).toContain('href="https://portal.readypackets.test/reset?token=secret_tok_999"');
    expect(liveRender.text).toContain("https://portal.readypackets.test/reset?token=secret_tok_999");

    // Redacted audit-copy / retained-content render (`[REDACTED]`)
    const redactedRender = resolved!.render({
      link: "[REDACTED]",
    });
    expect(redactedRender.html).toContain("[REDACTED]");
    expect(redactedRender.html).not.toContain("secret_tok_999");
    expect(redactedRender.text).toContain("[REDACTED]");

    // Reset to default clears active override while preserving version history
    const afterReset = await mod.resetToDefault(adminPrincipal, {
      templateKey: "auth.password_reset",
      expectedVersion: published.version,
    });
    expect(afterReset.hasPublishedOverride).toBe(false);
    expect(afterReset.versions.length).toBe(1);
    expect(await registeredStore!.resolve("auth.password_reset")).toBeNull();
  });

  it("supports custom template creation, version history, restore, optimistic locking, inert preview, and Send test to me", async () => {
    const created = await mod.createCustom(adminPrincipal, {
      templateKey: "custom.order_followup",
      name: "Order follow-up",
      description: "Sent by automation 24h after order creation.",
      category: "automation",
      declaredVars: [
        { name: "recipient_name", label: "Recipient name", required: true, sampleValue: "Taylor Jordan" },
        { name: "order_reference", label: "Order reference", required: true, sampleValue: "RP-2026-0500" },
        { name: "order_link", label: "Order link", required: true, sampleValue: "https://portal.readypackets.test/orders/01J9TEST" },
      ],
      format: "html",
      subject: "Follow-up on order {{order_reference}}",
      bodyHtml:
        '<p>Hello {{recipient_name}},</p><p>Your order <strong>{{order_reference}}</strong> is progressing.</p><p><a href="{{order_link}}" data-rp-button="primary">Open order</a></p>',
      deriveTextFromHtml: true,
    });

    // Unpublished custom template is NOT resolvable for live mail
    expect(await registeredStore!.resolve("custom.order_followup")).toBeNull();

    // Publish v1
    const v1Pub = await mod.publish(adminPrincipal, {
      templateKey: "custom.order_followup",
      expectedVersion: created.version,
    });
    expect(v1Pub.activePublished?.versionNumber).toBe(1);

    // Save + publish v2 in plain-text format
    const v2Draft = await mod.saveDraft(adminPrincipal, {
      templateKey: "custom.order_followup",
      expectedVersion: v1Pub.version,
      format: "text",
      subject: "Plain update for {{order_reference}}",
      bodyText: "Hi {{recipient_name}}, view order {{order_reference}} at {{order_link}}.",
      changeNote: "Switched to plain text",
    });
    const v2Pub = await mod.publish(adminPrincipal, {
      templateKey: "custom.order_followup",
      expectedVersion: v2Draft.version,
    });
    expect(v2Pub.activePublished?.versionNumber).toBe(2);
    expect(v2Pub.activePublished?.format).toBe("text");

    // Stale expectedVersion is rejected with CONFLICT
    await expect(
      mod.saveDraft(adminPrincipal, {
        templateKey: "custom.order_followup",
        expectedVersion: v1Pub.version,
        format: "text",
        subject: "Stale write",
        bodyText: "Should conflict",
      }),
    ).rejects.toThrow(/STALE_TEMPLATE_VERSION/);

    // Restore v1 into working draft, then publish as v3
    const restoredDraft = await mod.restoreVersion(adminPrincipal, {
      templateKey: "custom.order_followup",
      expectedVersion: v2Pub.version,
      versionNumber: 1,
    });
    expect(restoredDraft.workingDraft?.restoredFromVersionNumber).toBe(1);
    expect(restoredDraft.workingDraft?.format).toBe("html");

    const v3Pub = await mod.publish(adminPrincipal, {
      templateKey: "custom.order_followup",
      expectedVersion: restoredDraft.version,
    });
    expect(v3Pub.activePublished?.versionNumber).toBe(3);
    expect(v3Pub.versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);

    // Inert preview strips `<a>` / `href` and escapes hostile sample data
    const preview = await mod.preview(adminPrincipal, {
      format: "html",
      subject: "Follow-up on {{order_reference}}",
      bodyHtml: v3Pub.activePublished!.bodyHtml,
      bodyText: v3Pub.activePublished!.bodyText,
      declaredVars: v3Pub.declaredVars,
      sampleVars: {
        recipient_name: "<script>alert(1)</script>",
        order_reference: "RP-999",
        order_link: "https://portal.readypackets.test/orders/999",
      },
    });
    expect(preview.subject).toBe("Follow-up on RP-999");
    expect(preview.previewHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(preview.previewHtml).not.toContain("<a ");
    expect(preview.previewHtml).not.toContain("href=");

    // Send test to me addresses strictly `{ userId: adminUserId }` and resolves with `[TEST] ` prefix
    const testResult = await mod.sendTestToMe(adminPrincipal, {
      templateKey: "custom.order_followup",
      sampleVars: { order_reference: "RP-TEST-77" },
    });
    expect(testResult).toEqual({ queued: true, targetSource: "published" });
    expect(enqueuedMails).toHaveLength(1);
    expect(enqueuedMails[0]!.mail.to).toEqual({ userId: adminUserId });

    const testResolved = await registeredStore!.resolve(enqueuedMails[0]!.mail.template);
    expect(testResolved).not.toBeNull();
    const testRendered = testResolved!.render(enqueuedMails[0]!.mail.vars);
    expect(testRendered.subject).toBe("[TEST] Follow-up on order RP-TEST-77");

    // Audit trail never contains recipient addresses, bodies, or URLs
    const testAudit = h.audit.events.find((e) => e.eventName === "mail_template.test.sent");
    expect(testAudit).toBeDefined();
    expect(JSON.stringify(testAudit!.attributes)).not.toContain("admin@readypackets.test");
    expect(JSON.stringify(testAudit!.attributes)).not.toContain("RP-TEST-77");
  });

  it("denies non-admin roles and missing step-up, recording authz.mail_templates.denied", async () => {
    const staffPrincipal = fakePrincipal({
      userId: staffUserId,
      role: "staff",
      stepUpAt: h.clock.now(),
    });

    await expect(mod.list(staffPrincipal, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "CAPABILITY_NOT_GRANTED",
    });

    const noStepUpAdmin = fakePrincipal({
      userId: adminUserId,
      role: "admin",
      stepUpAt: null,
    });
    await expect(mod.list(noStepUpAdmin, {})).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
      reasonCode: "STEP_UP_REQUIRED",
    });

    const denials = h.audit.events.filter((e) => e.eventName === "authz.mail_templates.denied");
    expect(denials.length).toBeGreaterThanOrEqual(2);
  });

  it("executes email.send_template automation action with correlation propagation and default-denies staffOnlyTrigger (J-A01)", async () => {
    expect(SEND_TEMPLATE_AUTOMATION_ACTION.forbidOnStaffOnlyTrigger).toBe(true);

    const custom = await mod.createCustom(adminPrincipal, {
      templateKey: "custom.order_notice",
      name: "Order notice",
      category: "automation",
      declaredVars: [
        { name: "recipient_name", label: "Recipient", required: true, sampleValue: "Casey" },
        { name: "order_reference", label: "Order", required: true, sampleValue: "RP-1" },
      ],
      format: "html",
      subject: "Notice on {{order_reference}}",
      bodyHtml: "<p>Hello {{recipient_name}}, update on {{order_reference}}.</p>",
      deriveTextFromHtml: true,
    });
    await mod.publish(adminPrincipal, {
      templateKey: "custom.order_notice",
      expectedVersion: custom.version,
    });

    const baseCtx = {
      automationPublicId: ulid(h.clock.now().getTime()),
      automationVersion: 1,
      runPublicId: ulid(h.clock.now().getTime()),
      stepIndex: 0,
      stepKey: "step_1",
      idempotencyKey: "auto:run1:step:step_1",
      correlationId: "automation:01J9RUNPUBLICID00000000000",
      triggerMode: "event" as const,
      triggerKey: "order.created",
      triggerEventId: "evt_1",
      secrets: {},
      fields: { order_reference: "RP-2026-888" },
      recipients: { order_owner: [customerUserId], staff_group: [staffUserId] },
      orderPublicId: null,
      filePublicId: null,
      dryRun: false,
      assertStillOwned: async () => {},
      signal: new AbortController().signal,
      deps: {
        db: tdb.db,
        clock: h.clock,
        logger: h.deps.logger,
        audit: h.deps.audit,
        crypto: h.deps.crypto,
        settings: h.deps.settings,
        mailer: h.deps.mailer,
        jobs: h.deps.jobs,
        services: h.services,
      },
    };

    // 1. `J-A01`: `staffOnlyTrigger: true` is default-denied even on direct override invocation (both fixed and user recipients)
    const staffOnlyUserBlocked = await SEND_TEMPLATE_AUTOMATION_ACTION.run({
      ...baseCtx,
      triggerKey: "message.internal_note",
      staffOnlyTrigger: true,
      config: {
        templateKey: "custom.order_notice",
        recipientMode: "trigger",
        recipientKey: "staff_group",
      },
    });
    expect(staffOnlyUserBlocked).toMatchObject({
      outcome: "failed",
      reasonCode: "AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN",
    });
    expect(enqueuedMails).toHaveLength(0);

    // 2. Non-staff-only trigger delivers published Template Centre template with `automation:<runPublicId>` correlationId
    const delivered = await SEND_TEMPLATE_AUTOMATION_ACTION.run({
      ...baseCtx,
      staffOnlyTrigger: false,
      config: {
        templateKey: "custom.order_notice",
        recipientMode: "trigger",
        recipientKey: "order_owner",
      },
    });
    expect(delivered).toMatchObject({
      outcome: "completed",
      safeCounts: { queued_messages: 1 },
    });
    expect(enqueuedMails).toHaveLength(1);
    expect(enqueuedMails[0]!.mail.to).toEqual({ userId: customerUserId });
    expect(enqueuedMails[0]!.mail.vars.recipient_name).toBe("Casey Customer");
    expect(enqueuedMails[0]!.correlationId).toBe("automation:01J9RUNPUBLICID00000000000");

    // 3. Templates with sensitive single-use secrets (`auth.password_reset`) cannot be dispatched by automations
    const sensitiveRefused = await SEND_TEMPLATE_AUTOMATION_ACTION.run({
      ...baseCtx,
      staffOnlyTrigger: false,
      config: {
        templateKey: "auth.password_reset",
        recipientMode: "trigger",
        recipientKey: "order_owner",
      },
    });
    expect(sensitiveRefused).toMatchObject({
      outcome: "failed",
      reasonCode: "SENSITIVE_TEMPLATE_FORBIDDEN_IN_AUTOMATION",
    });
  });
});
