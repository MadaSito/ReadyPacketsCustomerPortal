import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { users, userSessions } from "../identity/schema.js";
import { getSettingDefinition } from "../platform/settingsRegistry.js";
import { createPolicyEnforcement, DEFAULT_POLICY_WARNING, parsePolicyWarning, policyDeadline, POLICY_WARNING_SETTING } from "./policyEnforcement.js";
import { policyEnforcementActions, policyEnforcementPreferences } from "./policyEnforcementSchema.js";
import { createPolicyNotices, policyNoticeSchedule, type PolicyNoticeJob, type PolicyNoticesPorts } from "./policyNotices.js";
import { policyNoticePreferences, policyNoticeRecipients, policyNotices } from "./policyNoticesSchema.js";
import { policyAcceptances, policyDocuments, policyVersions } from "./schema.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const HASH = "a".repeat(64);
const claim = { signal: new AbortController().signal, assertStillOwned: async () => {} };

describe("policy update notices and session enforcement", () => {
  let testDb: TestDb;
  let admin: SessionPrincipal;
  let customer: SessionPrincipal;
  let secondCustomer: SessionPrincipal;
  let staff: SessionPrincipal;

  beforeAll(async () => {
    testDb = await createTestDb({ schema: {
      users, userSessions, policyDocuments, policyVersions, policyAcceptances, policyNoticePreferences, policyNotices,
      policyNoticeRecipients, policyEnforcementPreferences, policyEnforcementActions,
    } });
    async function user(role: SessionPrincipal["role"], suffix: string) {
      const publicId = ulid();
      const [row] = await testDb.db.insert(users).values({
        publicId, role, status: "active", nameEnc: "synthetic", emailEnc: "synthetic", emailIndex: suffix.repeat(64),
      }).$returningId();
      return fakePrincipal({ role, userPublicId: publicId, userId: row!.id, stepUpAt: NOW });
    }
    admin = await user("admin", "a");
    staff = await user("staff", "b");
    customer = await user("customer", "c");
    secondCustomer = await user("customer", "d");
  }, 25_000);
  afterAll(async () => { await testDb?.cleanup(); });

  async function policy(slug: string, { draft = false, audience = "customer", delay = 0 }:
  { draft?: boolean; audience?: "customer" | "staff" | "all"; delay?: number } = {}) {
    const documentPublicId = ulid();
    const versionPublicId = ulid();
    const [doc] = await testDb.db.insert(policyDocuments).values({ publicId: documentPublicId, title: "Synthetic terms", slug, audience }).$returningId();
    const effectiveAt = new Date(NOW.getTime() + delay);
    const [ver] = await testDb.db.insert(policyVersions).values({
      publicId: versionPublicId, documentId: doc!.id, status: draft ? "draft" : "published",
      publishedAt: draft ? null : NOW, versionLabel: "1.0", versionNumber: 1,
      bodyText: "Synthetic exact terms.", contentHash: HASH, effectiveAt, changeSummary: "Synthetic revision.",
    }).$returningId();
    if (!draft) await testDb.db.update(policyDocuments).set({ currentPublishedVersionId: ver!.id }).where(eq(policyDocuments.id, doc!.id));
    return { documentPublicId, versionPublicId, documentId: doc!.id, versionId: ver!.id };
  }

  async function accept(userId: number, item: Awaited<ReturnType<typeof policy>>) {
    await testDb.db.insert(policyAcceptances).values({
      userId, documentId: item.documentId, policyVersionId: item.versionId,
      versionContentHash: HASH, requestId: ulid(), method: "portal_checkbox", acceptedAt: NOW,
    });
  }

  it("defaults the warning for missing/legacy values and establishes grace no earlier than publication, effectiveness and opt-in", () => {
    expect(getSettingDefinition(POLICY_WARNING_SETTING)).toMatchObject({ owner: "compliance", writeCapability: "policies.manage" });
    expect(parsePolicyWarning({ text: "old setting" })).toBe(DEFAULT_POLICY_WARNING);
    expect(parsePolicyWarning("Bad {other}")).toBe(DEFAULT_POLICY_WARNING);
    expect(parsePolicyWarning("{policy} at {deadline} ({timeLeft})")).toContain("{deadline}");
    expect(policyDeadline(NOW, new Date(+NOW + HOUR), new Date(+NOW + 2 * HOUR), 24)).toEqual(new Date(+NOW + 26 * HOUR));
    expect(policyNoticeSchedule(NOW, 0)).toEqual(NOW);
    expect(policyNoticeSchedule(NOW, 24)).toEqual(new Date(+NOW + 24 * HOUR));
    expect(() => policyNoticeSchedule(NOW, -1)).toThrow();
  });

  it("fences rescheduling and stale chunk replays, filters recipients, audits dispatch, reconciles progress and limits reminders", async () => {
    const item = await policy("notice-test");
    const h = createTestDeps({ db: testDb.db, now: NOW });
    const scheduled: PolicyNoticeJob[] = [];
    const mail = vi.fn<PolicyNoticesPorts["mail"]>().mockResolvedValue(undefined);
    const mailStates = vi.fn<PolicyNoticesPorts["mailStates"]>().mockImplementation(async (keys) =>
      new Map(keys.map((key) => [key, "sent"] as const)));
    const notify = vi.fn().mockResolvedValue(undefined);
    h.services.engagement = { notifications: { notify } } as unknown as typeof h.services.engagement;
    const notices = createPolicyNotices(h.deps, {
      schedule: async (job) => scheduled.push(job), mail, mailStates,
      mailKey: (value) => `${value.policyVersionPublicId}:${value.recipientUserId}:${value.reminderPublicId ?? "original"}`,
    });
    await testDb.db.transaction((tx) => notices.onPublished(tx, {
      ...item, publishedAt: NOW, active: true, requiresAcceptance: true, actor: admin,
    }));
    const status = await notices.status(item.documentPublicId);
    expect(status.notice).toMatchObject({ revision: 1, pending: 2, scheduledAt: new Date(+NOW + 24 * HOUR) });
    const noticePublicId = status.notice!.publicId;
    const rescheduled = await notices.change(admin, { kind: "reschedule", noticePublicId, revision: 1, scheduledAt: new Date(+NOW + HOUR) });
    expect(rescheduled).toEqual({ state: "scheduled", revision: 2 });
    await expect(notices.change(staff, { kind: "send", noticePublicId, revision: 2, confirmedCount: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(notices.change({ ...admin, stepUpAt: null }, { kind: "send", noticePublicId, revision: 2, confirmedCount: 2 })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(notices.change(admin, { kind: "send", noticePublicId, revision: 2, confirmedCount: 1 })).rejects.toMatchObject({ reasonCode: "POLICY_NOTICE_AUDIENCE_CHANGED" });
    const sent = await notices.change(admin, { kind: "send", noticePublicId, revision: 2, confirmedCount: 2 });
    expect(scheduled).toHaveLength(3);
    const batch = (revision: number, cursor: string | null, limit = 1) =>
      testDb.db.transaction((tx) => notices.runBatch({ noticePublicId, revision, cursor, limit }, claim, tx));
    expect(await batch(2, null)).toEqual({ nextCursor: null });
    expect(mail).not.toHaveBeenCalled();
    const first = await batch(sent.revision, null);
    expect(first.nextCursor).toBe(String(customer.userId));
    expect(await batch(sent.revision, null)).toEqual({ nextCursor: null });
    expect(mail).toHaveBeenCalledTimes(1);
    expect(await batch(sent.revision, first.nextCursor, 2)).toEqual({ nextCursor: null });
    expect(mail.mock.calls.map(([args]) => args.recipientUserId)).toEqual([customer.userId, secondCustomer.userId]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await notices.status(item.documentPublicId)).notice).toMatchObject({ state: "completed", queued: 2, failed: 0 });
    await h.jobs.enqueue("compliance.policy_notice.reconcile_mail", {});
    await h.jobs.runAll("compliance.policy_notice.reconcile_mail");
    expect((await notices.status(item.documentPublicId)).notice).toMatchObject({ queued: 0, sent: 2 });
    await expect(notices.change(admin, { kind: "remind", noticePublicId, revision: sent.revision, confirmedCount: 2 })).rejects.toMatchObject({ reasonCode: "POLICY_NOTICE_REMINDER_TOO_SOON" });
    await accept(customer.userId, item);
    h.clock.advance(24 * HOUR);
    const reminder = await notices.change({ ...admin, stepUpAt: h.clock.now() }, { kind: "remind", noticePublicId, revision: sent.revision, confirmedCount: 1 });
    await batch(reminder.revision, null, 20);
    expect(mail.mock.calls.at(-1)?.[0]).toMatchObject({ recipientUserId: secondCustomer.userId, reminderPublicId: expect.any(String) });
    expect(mail).toHaveBeenCalledTimes(3);
    expect(h.audit.named("policy.notice.dispatch_completed")).toHaveLength(2);
  });

  it("requires exact-version acceptance only after effective grace or an explicit end, and supports break-glass", async () => {
    const item = await policy("enforcement-test");
    const future = await policy("future-policy", { delay: 48 * HOUR });
    const draft = await policy("draft-policy", { draft: true });
    const h = createTestDeps({ db: testDb.db, now: NOW });
    const endSessionsForUser = vi.fn().mockResolvedValue({ ended: 2 });
    const assertCurrent = vi.fn().mockResolvedValue({ pendingSteps: [] });
    h.services.identity = { endSessionsForUser, sessions: { assertCurrent } } as unknown as typeof h.services.identity;
    const service = createPolicyEnforcement(h.deps);
    expect(await service.requiresRemediation(customer.userId, "customer")).toBe(false);
    await h.settings.set(POLICY_WARNING_SETTING, { obsolete: true });
    expect((await service.defaultStatus()).warningText).toBe(DEFAULT_POLICY_WARNING);
    await expect(service.setConfig(admin, {
      ...draft, expectedVersion: 0, mode: "required_to_continue", graceHours: 0, warningText: null, confirmedCount: 2,
    })).rejects.toMatchObject({ reasonCode: "POLICY_ENFORCEMENT_UNPUBLISHED" });
    await expect(service.setConfig(admin, {
      ...future, expectedVersion: 0, mode: "required_to_continue", graceHours: 0, warningText: null, confirmedCount: 2,
    })).rejects.toMatchObject({ reasonCode: "POLICY_ENFORCEMENT_UNPUBLISHED" });
    const config = { documentPublicId: item.documentPublicId, expectedVersion: 0, mode: "required_to_continue" as const, graceHours: 1, warningText: null };
    await expect(service.setConfig(admin, { ...config, confirmedCount: 1 })).rejects.toMatchObject({ reasonCode: "POLICY_ENFORCEMENT_AUDIENCE_CHANGED" });
    await service.setConfig(admin, { ...config, confirmedCount: 2 });
    expect(await service.pendingForUser(customer)).toEqual([expect.objectContaining({ versionPublicId: item.versionPublicId, blocking: false, changeSummary: "Synthetic revision." })]);
    await expect(service.pendingForUser({ ...customer, state: "remediation", pendingSteps: ["change_password", "accept_policy"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.endNow(customer, { userPublicId: secondCustomer.userPublicId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.endNow({ ...admin, stepUpAt: null }, { userPublicId: secondCustomer.userPublicId })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await service.decline(customer, item.versionPublicId);
    expect(endSessionsForUser).toHaveBeenCalledWith(customer.userId, "policy_declined", { tx: expect.anything() });
    expect(await service.requiresRemediation(customer.userId, "customer")).toBe(true);
    expect(await service.requiresRemediation(secondCustomer.userId, "customer")).toBe(false);
    expect(await service.requiresRemediation(staff.userId, "staff")).toBe(false);
    h.clock.advance(HOUR);
    expect(await service.requiresRemediation(secondCustomer.userId, "customer")).toBe(true);
    const remediation = { ...secondCustomer, state: "remediation", pendingSteps: ["accept_policy"] } satisfies SessionPrincipal;
    expect(await service.pendingForUser(remediation)).toEqual([expect.objectContaining({ versionPublicId: item.versionPublicId, blocking: true })]);
    const session = { userId: secondCustomer.userId, csrfSecretEnc: "synthetic", lastSeenAt: h.clock.now(), absoluteExpiresAt: new Date(+NOW + 2 * HOUR) };
    // A post-deadline remediation sign-in alone is not swept.
    await testDb.db.insert(userSessions).values({ ...session, publicId: ulid(), tokenHash: "1".repeat(64), authenticatedAt: h.clock.now() });
    const sweep = async () => {
      await h.jobs.enqueue("compliance.policy_enforcement.sweep", {});
      await h.jobs.runAll("compliance.policy_enforcement.sweep");
    };
    await sweep();
    expect(endSessionsForUser).toHaveBeenCalledTimes(1);
    // A pre-deadline session triggers termination even if a newer sign-in exists.
    await testDb.db.insert(userSessions).values({ ...session, publicId: ulid(), tokenHash: "2".repeat(64), authenticatedAt: NOW });
    await sweep();
    expect(endSessionsForUser).toHaveBeenLastCalledWith(secondCustomer.userId, "policy_deadline", { tx: expect.anything() });
    await sweep();
    expect(endSessionsForUser).toHaveBeenCalledTimes(2);
    await accept(secondCustomer.userId, item);
    expect(await service.requiresRemediation(secondCustomer.userId, "customer")).toBe(false);
    const override = createPolicyEnforcement(createTestDeps({ db: testDb.db, now: h.clock.now(), config: { policyEnforcementDisabled: true } }).deps);
    expect(await override.requiresRemediation(customer.userId, "customer")).toBe(false);
    expect(await override.pendingForUser(customer)).toEqual([]);
    await expect(override.endNow(admin, { userPublicId: customer.userPublicId })).rejects.toMatchObject({ reasonCode: "POLICY_ENFORCEMENT_DISABLED" });
    expect(h.audit.named("policy.enforcement.session_ended")).toHaveLength(2);
  });
});
