import { and, count, desc, eq, inArray, isNull, lt, lte } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { DbOrTx, JobResult, SessionPrincipal, Tx } from "../../core/types.js";
import { readSetting } from "../platform/index.js";
import { buildCanonicalPortalUrl, MAIL_GENERIC_NOTIFICATION } from "./mail.js";
import { assertCurrentActorInTx } from "./peers.js";
import { engagementNotificationPreferences, engagementNotifications } from "./schema.js";
import { ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED, ENGAGEMENT_NOTIFICATIONS_RETENTION_DAYS } from "./settings.js";
import {
  classifyNotificationCategory,
  decodeIdCursor,
  encodeIdCursor,
  NOTIFICATION_KIND_RE,
  normalizeInternalLink,
  normalizePlainText,
} from "./textAndSearch.js";
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  type NotificationPreferenceCategory,
  type NotifyInput,
  type NotifyResult,
} from "./types.js";

export const NOTIFICATIONS_RETENTION_JOB = "engagement.notifications.retention";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NotificationView {
  publicId: string;
  kind: string;
  category: NotificationPreferenceCategory;
  title: string;
  body: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationPreferenceView {
  category: NotificationPreferenceCategory;
  inApp: boolean;
  email: boolean;
  inAppLocked: boolean;
}

function defaultCategoryPreference(category: NotificationPreferenceCategory): { inApp: boolean; email: boolean } {
  return {
    inApp: true,
    email: category === "message" || category === "ticket",
  };
}

function assertFullSession(principal: SessionPrincipal): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
}

export function createNotificationsService(deps: ModuleDeps) {
  const { db, clock, audit, mailer, settings, config } = deps;

  async function resolvePreference(
    handle: DbOrTx,
    userId: number,
    category: NotificationPreferenceCategory,
  ): Promise<{ inApp: boolean; email: boolean }> {
    const [row] = await handle
      .select()
      .from(engagementNotificationPreferences)
      .where(
        and(
          eq(engagementNotificationPreferences.userId, userId),
          eq(engagementNotificationPreferences.category, category),
        ),
      )
      .limit(1);
    const defaults = defaultCategoryPreference(category);
    const inApp = category === "security" ? true : (row?.inApp ?? defaults.inApp);
    const email = row?.email ?? defaults.email;
    return { inApp, email };
  }

  async function notify(input: NotifyInput, tx?: Tx): Promise<NotifyResult> {
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
      throw validation("INVALID_RECIPIENT", "A valid recipient user is required.");
    }
    const kind = input.kind.normalize("NFC").trim();
    if (kind.length > 64 || !NOTIFICATION_KIND_RE.test(kind)) {
      throw validation("INVALID_NOTIFICATION_KIND", "The notification kind format is invalid.");
    }
    const title = normalizePlainText(input.title, {
      min: 1,
      max: 160,
      field: "title",
      label: "notification title",
      singleLine: true,
    });
    const body = normalizePlainText(input.body, {
      min: 1,
      max: 500,
      field: "body",
      label: "notification body",
    });
    const link = normalizeInternalLink(input.link);
    const idempotencyKey =
      input.idempotencyKey !== undefined
        ? normalizePlainText(input.idempotencyKey, {
            min: 1,
            max: 128,
            field: "idempotencyKey",
            label: "idempotency key",
            singleLine: true,
          })
        : null;

    const handle: DbOrTx = tx ?? db;
    const category = classifyNotificationCategory(kind);

    if (idempotencyKey !== null) {
      const [existing] = await handle
        .select({ publicId: engagementNotifications.publicId })
        .from(engagementNotifications)
        .where(
          and(
            eq(engagementNotifications.userId, input.userId),
            eq(engagementNotifications.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        return { publicId: existing.publicId, deliveredInApp: true, enqueuedEmail: false };
      }
    }

    const pref = await resolvePreference(handle, input.userId, category);
    const now = clock.now();
    const publicId = ulid(now.getTime());

    let deliveredInApp = false;
    if (pref.inApp) {
      await handle.insert(engagementNotifications).values({
        publicId,
        userId: input.userId,
        kind,
        category,
        title,
        body,
        link,
        readAt: null,
        idempotencyKey,
        createdAt: now,
      });
      deliveredInApp = true;
    }

    let enqueuedEmail = false;
    if (!input.skipEmail && pref.email) {
      const globalEmailEnabled = await readSetting(settings, ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED, tx);
      if (globalEmailEnabled) {
        const portalUrl = buildCanonicalPortalUrl(config.canonicalOrigin, link ?? "/notifications");
        await mailer.enqueue(
          {
            template: MAIL_GENERIC_NOTIFICATION,
            to: { userId: input.userId },
            vars: { title, link: portalUrl },
            idempotencyKey: `eng-notif-mail:${idempotencyKey ?? publicId}:${input.userId}`,
          },
          tx,
        );
        enqueuedEmail = true;
      }
    }

    return { publicId, deliveredInApp, enqueuedEmail };
  }

  async function isCategoryEmailEnabled(handle: DbOrTx, userId: number, category: NotificationPreferenceCategory): Promise<boolean> {
    const pref = await resolvePreference(handle, userId, category);
    return pref.email;
  }

  async function list(
    principal: SessionPrincipal,
    options: { unreadOnly?: boolean; cursor?: string; limit?: number } = {},
  ): Promise<{ items: NotificationView[]; nextCursor: string | null }> {
    assertFullSession(principal);
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const beforeId = decodeIdCursor(options.cursor);

    const rows = await db
      .select()
      .from(engagementNotifications)
      .where(
        and(
          eq(engagementNotifications.userId, principal.userId),
          options.unreadOnly ? isNull(engagementNotifications.readAt) : undefined,
          beforeId !== undefined ? lt(engagementNotifications.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(engagementNotifications.id))
      .limit(limit + 1);

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;

    return {
      items: slice.map((row) => ({
        publicId: row.publicId,
        kind: row.kind,
        category: row.category,
        title: row.title,
        body: row.body,
        link: row.link,
        readAt: row.readAt,
        createdAt: row.createdAt,
      })),
      nextCursor,
    };
  }

  async function unreadCount(principal: SessionPrincipal): Promise<{ unreadCount: number }> {
    assertFullSession(principal);
    const [row] = await db
      .select({ total: count(engagementNotifications.id) })
      .from(engagementNotifications)
      .where(and(eq(engagementNotifications.userId, principal.userId), isNull(engagementNotifications.readAt)));
    return { unreadCount: Number(row?.total ?? 0) };
  }

  async function markRead(principal: SessionPrincipal, notificationPublicId: string): Promise<{ ok: true }> {
    assertFullSession(principal);
    if (!ULID_PATTERN.test(notificationPublicId)) {
      throw notFound("NOTIFICATION_NOT_FOUND");
    }
    const [existing] = await db
      .select({
        id: engagementNotifications.id,
        userId: engagementNotifications.userId,
        readAt: engagementNotifications.readAt,
      })
      .from(engagementNotifications)
      .where(eq(engagementNotifications.publicId, notificationPublicId))
      .limit(1);

    if (!existing) {
      throw notFound("NOTIFICATION_NOT_FOUND");
    }
    if (existing.userId !== principal.userId) {
      await audit.record({
        category: "security",
        eventName: "authz.engagement.denied",
        action: "update",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "CROSS_TENANT_NOTIFICATION",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "notification", publicId: notificationPublicId },
      });
      throw notFound("NOTIFICATION_NOT_FOUND");
    }

    if (existing.readAt === null) {
      await db
        .update(engagementNotifications)
        .set({ readAt: clock.now() })
        .where(and(eq(engagementNotifications.id, existing.id), eq(engagementNotifications.userId, principal.userId)));
    }
    return { ok: true };
  }

  async function markAllRead(principal: SessionPrincipal): Promise<{ markedCount: number }> {
    assertFullSession(principal);
    const unreadRows = await db
      .select({ id: engagementNotifications.id })
      .from(engagementNotifications)
      .where(and(eq(engagementNotifications.userId, principal.userId), isNull(engagementNotifications.readAt)))
      .limit(1000);
    if (unreadRows.length === 0) return { markedCount: 0 };

    await db
      .update(engagementNotifications)
      .set({ readAt: clock.now() })
      .where(
        and(
          eq(engagementNotifications.userId, principal.userId),
          isNull(engagementNotifications.readAt),
          inArray(
            engagementNotifications.id,
            unreadRows.map((row) => row.id),
          ),
        ),
      );
    return { markedCount: unreadRows.length };
  }

  async function getPreferences(principal: SessionPrincipal): Promise<{ items: NotificationPreferenceView[] }> {
    assertFullSession(principal);
    const rows = await db
      .select()
      .from(engagementNotificationPreferences)
      .where(eq(engagementNotificationPreferences.userId, principal.userId));
    const map = new Map(rows.map((row) => [row.category, row]));

    const items: NotificationPreferenceView[] = NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => {
      const stored = map.get(category);
      const defaults = defaultCategoryPreference(category);
      const inAppLocked = category === "security";
      return {
        category,
        inApp: inAppLocked ? true : (stored?.inApp ?? defaults.inApp),
        email: stored?.email ?? defaults.email,
        inAppLocked,
      };
    });
    return { items };
  }

  async function updatePreference(
    principal: SessionPrincipal,
    input: { category: NotificationPreferenceCategory; inApp: boolean; email: boolean },
  ): Promise<NotificationPreferenceView> {
    assertFullSession(principal);
    if (input.category === "security" && !input.inApp) {
      throw validation("SECURITY_IN_APP_REQUIRED", "In-app security notifications cannot be turned off.");
    }

    const now = clock.now();
    await db.transaction(async (tx) => {
      await assertCurrentActorInTx(deps, principal, tx);
      const [existing] = await tx
        .select({ id: engagementNotificationPreferences.id })
        .from(engagementNotificationPreferences)
        .where(
          and(
            eq(engagementNotificationPreferences.userId, principal.userId),
            eq(engagementNotificationPreferences.category, input.category),
          ),
        )
        .limit(1);

      if (existing) {
        await tx
          .update(engagementNotificationPreferences)
          .set({ inApp: input.inApp, email: input.email, updatedAt: now })
          .where(eq(engagementNotificationPreferences.id, existing.id));
      } else {
        await tx.insert(engagementNotificationPreferences).values({
          userId: principal.userId,
          category: input.category,
          inApp: input.inApp,
          email: input.email,
          updatedAt: now,
        });
      }

      await audit.record(
        {
          category: "business",
          eventName: "engagement.notification.preferences.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "notification_preference", publicId: principal.userPublicId },
          attributes: {
            category: input.category,
            in_app: input.inApp,
            email: input.email,
          },
        },
        tx,
      );
    });

    return {
      category: input.category,
      inApp: input.category === "security" ? true : input.inApp,
      email: input.email,
      inAppLocked: input.category === "security",
    };
  }

  async function runRetentionJob(
    signal: AbortSignal,
    assertStillOwned: (tx?: Tx) => Promise<void>,
    correlationId: string,
    jobId: string,
  ): Promise<JobResult> {
    if (signal.aborted) {
      return { outcome: "canceled", reasonCode: "ABORTED" };
    }
    await assertStillOwned();
    const retentionDays = await readSetting(settings, ENGAGEMENT_NOTIFICATIONS_RETENTION_DAYS);
    const cutoff = new Date(clock.now().getTime() - retentionDays * DAY_MS);

    let totalDeleted = 0;
    // Bounded max 10 batches per scheduled invocation so worker stays responsive.
    for (let batch = 0; batch < 10; batch += 1) {
      if (signal.aborted) {
        return { outcome: "canceled", reasonCode: "ABORTED" };
      }
      const deletedInBatch = await db.transaction(async (tx) => {
        await assertStillOwned(tx);
        const lockedCandidates = await tx
          .select({ id: engagementNotifications.id })
          .from(engagementNotifications)
          .where(lte(engagementNotifications.createdAt, cutoff))
          .orderBy(engagementNotifications.id)
          .limit(500)
          .for("update");
        if (lockedCandidates.length === 0) return 0;

        await audit.record(
          {
            category: "job",
            eventName: "engagement.notifications.retention.purged",
            action: "delete",
            outcome: "completed",
            actor: { role: "system" },
            correlationId,
            jobId,
            safeCounts: { deleted: lockedCandidates.length },
          },
          tx,
        );
        await tx.delete(engagementNotifications).where(
          inArray(
            engagementNotifications.id,
            lockedCandidates.map((c) => c.id),
          ),
        );
        return lockedCandidates.length;
      });
      totalDeleted += deletedInBatch;
      if (deletedInBatch < 500) break;
    }

    return { outcome: "completed", safeCounts: { deleted: totalDeleted } };
  }

  async function totalUnreadMetric(): Promise<number> {
    const [row] = await db
      .select({ total: count(engagementNotifications.id) })
      .from(engagementNotifications)
      .where(isNull(engagementNotifications.readAt));
    return Number(row?.total ?? 0);
  }

  return {
    notify,
    isCategoryEmailEnabled,
    list,
    unreadCount,
    markRead,
    markAllRead,
    getPreferences,
    updatePreference,
    runRetentionJob,
    totalUnreadMetric,
    canManageGlobal: (principal: SessionPrincipal) => roleHasCapability(principal.role, "platform.settings.manage"),
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
