import { and, count, eq, gt, inArray, lte, max, notExists } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { assertLiveActorInTx, runComplianceTx } from "./actorAuth.js";
import { policyNoticePreferences, policyNoticeRecipients, policyNotices } from "./policyNoticesSchema.js";
import { policyAcceptances, policyDocuments, policyVersions, type PolicyAudience } from "./schema.js";

const HOUR = 3_600_000;
const REMINDER_BACKOFF = 24 * HOUR;
export const POLICY_NOTICE_DEFAULT_DELAY = 24;
export const POLICY_NOTICE_MAX_DELAY = 24 * 365;
export const POLICY_NOTICE_PORTAL_PATH = "/policies";

type Actor = { userId: number; role: "customer" | "staff" | "admin" };
export type PolicyNoticeJob = { noticePublicId: string; revision: number; scheduledAt: Date };
export type PolicyNoticeBatch = Omit<PolicyNoticeJob, "scheduledAt"> & { cursor: string | null; limit: number };
type NoticeMail = {
  kind: "update";
  policyVersionPublicId: string;
  recipientUserId: number;
  policyTitle: string;
  portalUrl: string;
  summary?: string;
  reminderPublicId?: string;
};
type MailRound = Pick<NoticeMail, "kind" | "policyVersionPublicId" | "reminderPublicId">;
type MailState = "queued" | "sent" | "failed";
type MailProgress = Record<MailState, number>;
export interface PolicyNoticesPorts {
  schedule: (input: PolicyNoticeJob, tx: Tx) => Promise<unknown>;
  mail: (input: NoticeMail, tx: Tx) => Promise<unknown>;
  mailKey: (input: MailRound & { recipientUserId: number }) => string;
  mailStates: (keys: readonly string[], tx: Tx) => Promise<ReadonlyMap<string, MailState>>;
}

export function audienceUserFilter(audience: PolicyAudience) {
  if (audience === "all") return eq(users.status, "active");
  return and(eq(users.status, "active"), audience === "customer" ? eq(users.role, "customer") : inArray(users.role, ["staff", "admin"]));
}

export function hasPortalAcceptance(db: DbOrTx, versionId: number | typeof policyVersions.id, userId: number | typeof users.id) {
  return db.select({ id: policyAcceptances.id }).from(policyAcceptances)
    .where(and(eq(policyAcceptances.userId, userId), eq(policyAcceptances.policyVersionId, versionId), eq(policyAcceptances.origin, "portal")));
}

export function policyNoticeSchedule(publishedAt: Date, delayHours: number): Date {
  if (!Number.isInteger(delayHours) || delayHours < 0 || delayHours > POLICY_NOTICE_MAX_DELAY) {
    throw validation("POLICY_NOTICE_DELAY_INVALID", "Enter a whole number of hours from 0 to 8760.");
  }
  return new Date(publishedAt.getTime() + delayHours * HOUR);
}

export function createPolicyNotices(deps: ModuleDeps, ports: PolicyNoticesPorts) {
  async function audit(tx: Tx, action: string, noticePublicId: string, actor?: Actor, attributes?: Record<string, number>) {
    await deps.audit.record({
      category: "admin", eventName: `policy.notice.${action}`, action: "transition", outcome: "completed",
      actor: actor ?? { role: "system" }, resource: { type: "policy_notice", publicId: noticePublicId },
      ...(attributes ? { attributes } : {}),
    }, tx);
  }

  async function onPublished(tx: Tx, input: {
    documentId: number; versionId: number; publishedAt: Date; requiresAcceptance: boolean; active: boolean; actor: Actor;
  }): Promise<void> {
    if (!input.requiresAcceptance || !input.active) return;
    const [prefs] = await tx.select().from(policyNoticePreferences).where(eq(policyNoticePreferences.documentId, input.documentId));
    const noticePublicId = ulid();
    const scheduledAt = policyNoticeSchedule(input.publishedAt, prefs?.delayHours ?? POLICY_NOTICE_DEFAULT_DELAY);
    await tx.insert(policyNotices).values({ publicId: noticePublicId, policyVersionId: input.versionId, scheduledAt });
    await ports.schedule({ noticePublicId, revision: 1, scheduledAt }, tx);
    await audit(tx, "scheduled", noticePublicId, input.actor);
  }

  async function getNotice(db: DbOrTx, noticePublicId: string) {
    const [row] = await db.select({
      notice: policyNotices,
      version: {
        id: policyVersions.id, publicId: policyVersions.publicId, status: policyVersions.status,
        origin: policyVersions.origin, changeSummary: policyVersions.changeSummary,
      },
      doc: {
        active: policyDocuments.active, requiresAcceptance: policyDocuments.requiresAcceptance,
        currentPublishedVersionId: policyDocuments.currentPublishedVersionId, audience: policyDocuments.audience,
        title: policyDocuments.title,
      },
    })
      .from(policyNotices)
      .innerJoin(policyVersions, eq(policyVersions.id, policyNotices.policyVersionId))
      .innerJoin(policyDocuments, eq(policyDocuments.id, policyVersions.documentId))
      .where(eq(policyNotices.publicId, noticePublicId)).limit(1);
    return row;
  }

  function isCurrent(row: NonNullable<Awaited<ReturnType<typeof getNotice>>>) {
    return row.doc.active && row.doc.requiresAcceptance && row.doc.currentPublishedVersionId === row.version.id
      && row.version.status === "published" && row.version.origin === "portal";
  }

  function mailRound(row: NonNullable<Awaited<ReturnType<typeof getNotice>>>): MailRound {
    return { kind: "update", policyVersionPublicId: row.version.publicId,
      ...(row.notice.reminderPublicId ? { reminderPublicId: row.notice.reminderPublicId } : {}) };
  }

  async function audienceCounts(db: DbOrTx, audience: PolicyAudience, versionId: number) {
    const eligible = audienceUserFilter(audience);
    const pending = notExists(hasPortalAcceptance(db, versionId, users.id));
    const [[total], [target]] = await Promise.all([
      db.select({ size: count() }).from(users).where(eligible),
      db.select({ size: count() }).from(users).where(and(eligible, pending)),
    ]);
    const open = target?.size ?? 0;
    return { pending: open, accepted: Math.max(0, (total?.size ?? 0) - open) };
  }

  async function status(documentPublicId: string) {
    const [row] = await deps.db.select({
      doc: policyDocuments, delayHours: policyNoticePreferences.delayHours, noticePublicId: policyNotices.publicId,
    }).from(policyDocuments)
      .leftJoin(policyNoticePreferences, eq(policyNoticePreferences.documentId, policyDocuments.id))
      .leftJoin(policyNotices, eq(policyNotices.policyVersionId, policyDocuments.currentPublishedVersionId))
      .where(eq(policyDocuments.publicId, documentPublicId)).limit(1);
    if (!row) throw notFound("POLICY_DOCUMENT_NOT_FOUND");
    const entry = row.noticePublicId ? await getNotice(deps.db, row.noticePublicId) : undefined;
    if (!entry || !isCurrent(entry)) {
      return { delayHours: row.delayHours ?? POLICY_NOTICE_DEFAULT_DELAY, notice: null };
    }
    const [{ pending, accepted }, progressRows] = await Promise.all([
      audienceCounts(deps.db, entry.doc.audience, entry.version.id),
      deps.db.select({ state: policyNoticeRecipients.mailState, size: count() }).from(policyNoticeRecipients)
        .where(and(eq(policyNoticeRecipients.noticeId, entry.notice.id),
          eq(policyNoticeRecipients.deliveryRound, entry.notice.reminderPublicId ? entry.notice.revision : 0)))
        .groupBy(policyNoticeRecipients.mailState),
    ]);
    const progress: MailProgress = { queued: 0, sent: 0, failed: 0 };
    for (const { state, size } of progressRows) progress[state] = size;
    return { delayHours: row.delayHours ?? POLICY_NOTICE_DEFAULT_DELAY, notice: {
      publicId: entry.notice.publicId, revision: entry.notice.revision, state: entry.notice.state,
      scheduledAt: entry.notice.scheduledAt, pending, accepted, ...progress,
      reminderAvailableAt: entry.notice.state === "completed"
        ? new Date((entry.notice.lastReminderAt ?? entry.notice.scheduledAt).getTime() + REMINDER_BACKOFF) : null,
    } };
  }

  async function setDelay(principal: SessionPrincipal, input: { documentPublicId: string; delayHours: number }) {
    policyNoticeSchedule(deps.clock.now(), input.delayHours);
    const resource = { type: "policy_document", publicId: input.documentPublicId };
    return runComplianceTx(deps, principal, resource, async (tx) => {
      const actor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");
      const [doc] = await tx.select({ id: policyDocuments.id }).from(policyDocuments)
        .where(eq(policyDocuments.publicId, input.documentPublicId)).for("update").limit(1);
      if (!doc) throw notFound("POLICY_DOCUMENT_NOT_FOUND");
      await tx.insert(policyNoticePreferences).values({ documentId: doc.id, delayHours: input.delayHours })
        .onDuplicateKeyUpdate({ set: { delayHours: input.delayHours, updatedAt: deps.clock.now() } });
      await deps.audit.record({
        category: "admin", eventName: "policy.notice.delay_changed", action: "update", outcome: "completed",
        actor, resource, attributes: { delay_hours: input.delayHours },
      }, tx);
      return { delayHours: input.delayHours };
    });
  }

  type Command =
    | { kind: "reschedule"; scheduledAt: Date }
    | { kind: "cancel" }
    | { kind: "send" | "remind"; confirmedCount: number };
  async function change(
    principal: SessionPrincipal,
    input: { noticePublicId: string; revision: number } & Command,
  ) {
    const resource = { type: "policy_notice", publicId: input.noticePublicId };
    return runComplianceTx(deps, principal, resource, async (tx) => {
      const send = input.kind === "send" || input.kind === "remind";
      const actor = await assertLiveActorInTx(deps, principal, tx, send ? "policies.notices.send" : "policies.manage");
      const [locked] = await tx.select().from(policyNotices).where(eq(policyNotices.publicId, input.noticePublicId)).for("update").limit(1);
      if (!locked) throw notFound("POLICY_NOTICE_NOT_FOUND");
      const entry = await getNotice(tx, input.noticePublicId);
      if (!entry || !isCurrent(entry) || locked.revision !== input.revision) {
        throw conflict("POLICY_NOTICE_CHANGED", "The notice changed. Refresh and review it again.");
      }
      const reminder = input.kind === "remind";
      if (reminder ? locked.state !== "completed" : locked.state !== "scheduled") {
        throw conflict("POLICY_NOTICE_CHANGED", "This action is no longer available for the notice.");
      }
      const now = deps.clock.now();
      if (reminder && now.getTime() - (locked.lastReminderAt ?? locked.scheduledAt).getTime() < REMINDER_BACKOFF) {
        throw conflict("POLICY_NOTICE_REMINDER_TOO_SOON", "Wait at least 24 hours between reminder sends.");
      }
      if (send) {
        const { pending } = await audienceCounts(tx, entry.doc.audience, entry.version.id);
        if (pending !== input.confirmedCount || pending === 0) {
          throw conflict("POLICY_NOTICE_AUDIENCE_CHANGED", "The audience changed. Refresh and confirm the new recipient count.");
        }
      }
      const scheduledAt = input.kind === "reschedule" ? input.scheduledAt : now;
      if (input.kind === "reschedule" && (scheduledAt < now || scheduledAt.getTime() > now.getTime() + POLICY_NOTICE_MAX_DELAY * HOUR)) {
        throw validation("POLICY_NOTICE_TIME_INVALID", "Select a future time within one year.");
      }
      const revision = locked.revision + 1;
      const state = input.kind === "cancel" ? "cancelled" : "scheduled";
      await tx.update(policyNotices).set({
        revision, scheduledAt: state === "cancelled" ? locked.scheduledAt : scheduledAt, state, updatedAt: now,
        ...(reminder ? { lastReminderAt: now, reminderPublicId: ulid() } : {}),
      }).where(eq(policyNotices.id, locked.id));
      if (state !== "cancelled") await ports.schedule({ noticePublicId: input.noticePublicId, revision, scheduledAt }, tx);
      await audit(tx, input.kind, input.noticePublicId, actor, send ? { confirmed_count: input.confirmedCount } : undefined);
      return { state, revision };
    });
  }

  async function runBatch(input: PolicyNoticeBatch, claim: Pick<ClaimedJob, "signal" | "assertStillOwned">, tx: Tx) {
    await claim.assertStillOwned(tx);
    const [locked] = await tx.select().from(policyNotices).where(eq(policyNotices.publicId, input.noticePublicId)).for("update").limit(1);
    const now = deps.clock.now();
    if (!locked || locked.revision !== input.revision || locked.scheduledAt > now
      || (locked.state !== "scheduled" && locked.state !== "dispatching")) return { nextCursor: null };
    const row = await getNotice(tx, input.noticePublicId);
    if (!row || !isCurrent(row)) {
      await tx.update(policyNotices).set({ state: "cancelled", updatedAt: now }).where(eq(policyNotices.id, locked.id));
      await audit(tx, "superseded", input.noticePublicId);
      return { nextCursor: null };
    }
    const cursor = input.cursor === null ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid internal policy notice cursor");
    const limit = Math.min(100, Math.max(1, input.limit));
    const deliveryRound = locked.reminderPublicId ? locked.revision : 0;
    const [progress] = await tx.select({ highWater: max(policyNoticeRecipients.userId) }).from(policyNoticeRecipients)
      .where(and(eq(policyNoticeRecipients.noticeId, locked.id), eq(policyNoticeRecipients.deliveryRound, deliveryRound)));
    // Generic job settlement can lag a committed chunk. Its already committed successor owns the next cursor.
    if (Number(progress?.highWater ?? 0) !== cursor) return { nextCursor: null };
    const recipients = await tx.select({ id: users.id }).from(users).where(and(
      audienceUserFilter(row.doc.audience), gt(users.id, cursor),
      notExists(hasPortalAcceptance(tx, row.version.id, users.id)),
      notExists(tx.select({ id: policyNoticeRecipients.id }).from(policyNoticeRecipients).where(and(
        eq(policyNoticeRecipients.noticeId, locked.id), eq(policyNoticeRecipients.deliveryRound, deliveryRound),
        eq(policyNoticeRecipients.userId, users.id),
      ))),
    )).orderBy(users.id).limit(limit);
    for (const recipient of recipients) {
      claim.signal.throwIfAborted();
      await tx.insert(policyNoticeRecipients).values({
        noticeId: locked.id, deliveryRound, userId: recipient.id,
        reminderPublicId: locked.reminderPublicId, nextMailCheckAt: now,
      });
      await ports.mail({
        ...mailRound(row), recipientUserId: recipient.id, policyTitle: row.doc.title,
        portalUrl: new URL(POLICY_NOTICE_PORTAL_PATH, deps.config.canonicalOrigin).href,
        ...(row.version.changeSummary ? { summary: row.version.changeSummary } : {}),
      }, tx);
      await deps.services.engagement.notifications.notify({
        userId: recipient.id, kind: "policy.updated", title: "Policy update",
        body: `Review and accept the latest version of ${row.doc.title}.`, link: POLICY_NOTICE_PORTAL_PATH,
        idempotencyKey: `policy-notice:${row.version.publicId}:${locked.reminderPublicId ?? "original"}`, skipEmail: true,
      }, tx);
    }
    const nextCursor = recipients.length === limit ? String(recipients.at(-1)!.id) : null;
    await tx.update(policyNotices).set({ state: nextCursor ? "dispatching" : "completed", updatedAt: now }).where(eq(policyNotices.id, locked.id));
    await audit(tx, nextCursor ? "batch_queued" : "dispatch_completed", input.noticePublicId, undefined, { recipient_count: recipients.length });
    return { nextCursor };
  }

  const reconcileType = "compliance.policy_notice.reconcile_mail";
  deps.jobs.register(reconcileType, async (claim) => {
    const checked = await deps.db.transaction(async (tx) => {
      await claim.assertStillOwned(tx);
      const now = deps.clock.now();
      const rows = await tx.select({
        id: policyNoticeRecipients.id, recipientUserId: policyNoticeRecipients.userId,
        reminderPublicId: policyNoticeRecipients.reminderPublicId, policyVersionPublicId: policyVersions.publicId,
      }).from(policyNoticeRecipients)
        .innerJoin(policyNotices, eq(policyNotices.id, policyNoticeRecipients.noticeId))
        .innerJoin(policyVersions, eq(policyVersions.id, policyNotices.policyVersionId))
        .where(and(eq(policyNoticeRecipients.mailState, "queued"), lte(policyNoticeRecipients.nextMailCheckAt, now)))
        .orderBy(policyNoticeRecipients.nextMailCheckAt, policyNoticeRecipients.id).limit(250);
      if (rows.length === 0) return 0;
      const keyed = rows.map((row) => ({ ...row, key: ports.mailKey({
        kind: "update", policyVersionPublicId: row.policyVersionPublicId, recipientUserId: row.recipientUserId,
        ...(row.reminderPublicId ? { reminderPublicId: row.reminderPublicId } : {}),
      }) }));
      const states = await ports.mailStates(keyed.map((row) => row.key), tx);
      for (const row of keyed) {
        claim.signal.throwIfAborted();
        const state = states.get(row.key);
        await tx.update(policyNoticeRecipients).set({
          ...(state ? { mailState: state } : {}),
          nextMailCheckAt: new Date(now.getTime() + 300_000),
        }).where(eq(policyNoticeRecipients.id, row.id));
      }
      return rows.length;
    });
    return { outcome: "completed", safeCounts: { checked } };
  }, { retrySafe: true });
  deps.jobs.registerSchedule({ name: reconcileType, type: reconcileType, everyMs: 60_000 });

  return { onPublished, status, setDelay, change, runBatch };
}

export type PolicyNoticesService = ReturnType<typeof createPolicyNotices>;
