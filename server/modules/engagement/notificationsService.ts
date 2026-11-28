import { and, asc, count, desc, eq, exists, gt, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { DbOrTx, JobResult, SessionPrincipal, Tx } from "../../core/types.js";
import { complianceInvoices } from "../compliance/schema.js";
import { isLiveUserRow, isTrashedUserInTx } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { readSetting } from "../platform/index.js";
import { buildCanonicalPortalUrl, MAIL_GENERIC_NOTIFICATION } from "./mail.js";
import { assertCurrentActorInTx } from "./peers.js";
import {
  engagementNotificationPreferences,
  engagementNotifications,
  engagementSupportTickets,
} from "./schema.js";
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
  liveNotificationPredicate,
  parseNotificationLinkRef,
  resolveNotificationTargetsInTx,
} from "./trashGate.js";
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
  let lastScannedLegacyId = 0;
  let legacyScanInFlight: Promise<void> | null = null;

  /**
   * Bounded idempotent backfill for pre-0009 notification rows whose `orderId` and `ticketId`
   * columns are NULL so `liveNotificationPredicate()` and `purge()` cover upgraded databases.
   */
  async function backfillLegacyTargets(handle: DbOrTx = db): Promise<void> {
    for (let batch = 0; batch < 10; batch += 1) {
      const candidates = await handle
        .select({
          id: engagementNotifications.id,
          link: engagementNotifications.link,
        })
        .from(engagementNotifications)
        .where(
          and(
            gt(engagementNotifications.id, lastScannedLegacyId),
            isNull(engagementNotifications.orderId),
            isNull(engagementNotifications.ticketId),
            isNotNull(engagementNotifications.link),
          ),
        )
        .orderBy(asc(engagementNotifications.id))
        .limit(250);

      if (candidates.length === 0) break;

      const orderPubs = new Set<string>();
      const invoicePubs = new Set<string>();
      const ticketPubs = new Set<string>();
      const parsedById = new Map<number, ReturnType<typeof parseNotificationLinkRef>>();

      for (const row of candidates) {
        const parsed = parseNotificationLinkRef(row.link);
        parsedById.set(row.id, parsed);
        if (parsed?.kind === "order") orderPubs.add(parsed.publicId);
        else if (parsed?.kind === "invoice") invoicePubs.add(parsed.publicId);
        else if (parsed?.kind === "ticket") ticketPubs.add(parsed.publicId);
      }

      const orderByPub = new Map<string, number>();
      if (orderPubs.size > 0) {
        const ordRows = await handle
          .select({ id: orders.id, publicId: orders.publicId })
          .from(orders)
          .where(inArray(orders.publicId, [...orderPubs]));
        for (const ord of ordRows) orderByPub.set(ord.publicId, ord.id);
      }

      const invoiceOrderByPub = new Map<string, number>();
      if (invoicePubs.size > 0) {
        const invRows = await handle
          .select({ publicId: complianceInvoices.publicId, orderId: complianceInvoices.orderId })
          .from(complianceInvoices)
          .where(inArray(complianceInvoices.publicId, [...invoicePubs]));
        for (const inv of invRows) invoiceOrderByPub.set(inv.publicId, inv.orderId);
      }

      const ticketByPub = new Map<string, { id: number; relatedOrderId: number | null }>();
      if (ticketPubs.size > 0) {
        const tktRows = await handle
          .select({
            id: engagementSupportTickets.id,
            publicId: engagementSupportTickets.publicId,
            relatedOrderId: engagementSupportTickets.relatedOrderId,
          })
          .from(engagementSupportTickets)
          .where(inArray(engagementSupportTickets.publicId, [...ticketPubs]));
        for (const tkt of tktRows) {
          ticketByPub.set(tkt.publicId, { id: tkt.id, relatedOrderId: tkt.relatedOrderId });
        }
      }

      for (const row of candidates) {
        const parsed = parsedById.get(row.id);
        let orderId: number | null = null;
        let ticketId: number | null = null;
        if (parsed?.kind === "order") {
          orderId = orderByPub.get(parsed.publicId) ?? null;
        } else if (parsed?.kind === "invoice") {
          orderId = invoiceOrderByPub.get(parsed.publicId) ?? null;
        } else if (parsed?.kind === "ticket") {
          const tkt = ticketByPub.get(parsed.publicId);
          if (tkt) {
            ticketId = tkt.id;
            orderId = tkt.relatedOrderId;
          }
        }
        if (orderId !== null || ticketId !== null) {
          await handle
            .update(engagementNotifications)
            .set({ orderId, ticketId })
            .where(eq(engagementNotifications.id, row.id));
        }
      }

      lastScannedLegacyId = candidates[candidates.length - 1]!.id;
      if (candidates.length < 250) break;
    }
  }

  async function ensureLegacyBackfilled(): Promise<void> {
    if (!legacyScanInFlight) {
      legacyScanInFlight = backfillLegacyTargets(db).finally(() => {
        legacyScanInFlight = null;
      });
    }
    await legacyScanInFlight;
  }

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
    const staffOnly = Boolean(input.staffOnly);

    if (staffOnly) {
      const [liveRecipient] = await handle
        .select({
          role: users.role,
          status: users.status,
          trashedAt: users.trashedAt,
          purgedAt: users.purgedAt,
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (
        !liveRecipient ||
        liveRecipient.status !== "active" ||
        !isLiveUserRow(liveRecipient) ||
        liveRecipient.role === "customer"
      ) {
        throw validation(
          "STAFF_ONLY_RECIPIENT_FORBIDDEN",
          "Staff-only notifications may only be delivered to active staff or administrator accounts.",
        );
      }
    } else if (await isTrashedUserInTx(handle, input.userId)) {
      return { publicId: "", deliveredInApp: false, enqueuedEmail: false };
    }

    const resolvedTargets = await resolveNotificationTargetsInTx(handle, {
      orderId: input.orderId,
      ticketId: input.ticketId,
      link,
    });
    if (resolvedTargets.suppressed) {
      return { publicId: "", deliveredInApp: false, enqueuedEmail: false };
    }

    if (idempotencyKey !== null) {
      const [existing] = await handle
        .select({ publicId: engagementNotifications.publicId })
        .from(engagementNotifications)
        .where(
          and(
            eq(engagementNotifications.userId, input.userId),
            eq(engagementNotifications.idempotencyKey, idempotencyKey),
            liveNotificationPredicate(),
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
        orderId: resolvedTargets.orderId,
        ticketId: resolvedTargets.ticketId,
        kind,
        category,
        title,
        body,
        link,
        staffOnly,
        readAt: null,
        idempotencyKey,
        createdAt: now,
      });
      deliveredInApp = true;
    }

    let enqueuedEmail = false;
    if (!input.skipEmail && !staffOnly && pref.email) {
      const globalEmailEnabled = await readSetting(settings, ENGAGEMENT_NOTIFICATIONS_EMAIL_ENABLED, tx);
      if (globalEmailEnabled) {
        const portalUrl = buildCanonicalPortalUrl(config.canonicalOrigin, link ?? "/notifications");
        await mailer.enqueue(
          {
            template: MAIL_GENERIC_NOTIFICATION,
            to: { userId: input.userId },
            vars: { title, link: portalUrl },
            idempotencyKey: `eng-notif-mail:${idempotencyKey ?? publicId}:${input.userId}`,
            ...(resolvedTargets.orderId !== null ? { orderId: resolvedTargets.orderId } : {}),
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

  function staffOnlyVisibilityPredicate(principal: SessionPrincipal) {
    if (principal.role === "customer") {
      return eq(engagementNotifications.staffOnly, false);
    }
    return or(
      eq(engagementNotifications.staffOnly, false),
      exists(
        db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, engagementNotifications.userId),
              eq(users.status, "active"),
              inArray(users.role, ["admin", "staff"]),
            ),
          ),
      ),
    );
  }

  async function list(
    principal: SessionPrincipal,
    options: { unreadOnly?: boolean; cursor?: string; limit?: number } = {},
  ): Promise<{ items: NotificationView[]; nextCursor: string | null }> {
    assertFullSession(principal);
    await ensureLegacyBackfilled();
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const beforeId = decodeIdCursor(options.cursor);

    const rows = await db
      .select()
      .from(engagementNotifications)
      .where(
        and(
          eq(engagementNotifications.userId, principal.userId),
          staffOnlyVisibilityPredicate(principal),
          liveNotificationPredicate(),
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
    await ensureLegacyBackfilled();
    const [row] = await db
      .select({ total: count(engagementNotifications.id) })
      .from(engagementNotifications)
      .where(
        and(
          eq(engagementNotifications.userId, principal.userId),
          staffOnlyVisibilityPredicate(principal),
          liveNotificationPredicate(),
          isNull(engagementNotifications.readAt),
        ),
      );
    return { unreadCount: Number(row?.total ?? 0) };
  }

  async function markRead(principal: SessionPrincipal, notificationPublicId: string): Promise<{ ok: true }> {
    assertFullSession(principal);
    await ensureLegacyBackfilled();
    if (!ULID_PATTERN.test(notificationPublicId)) {
      throw notFound("NOTIFICATION_NOT_FOUND");
    }
    const [existing] = await db
      .select({
        id: engagementNotifications.id,
        userId: engagementNotifications.userId,
        staffOnly: engagementNotifications.staffOnly,
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

    const visibility = staffOnlyVisibilityPredicate(principal);
    const liveGate = liveNotificationPredicate();
    const [visible] = await db
      .select({ id: engagementNotifications.id })
      .from(engagementNotifications)
      .where(and(eq(engagementNotifications.id, existing.id), visibility, liveGate))
      .limit(1);
    if (!visible) {
      throw notFound("NOTIFICATION_NOT_FOUND");
    }

    if (existing.readAt === null) {
      await db
        .update(engagementNotifications)
        .set({ readAt: clock.now() })
        .where(
          and(
            eq(engagementNotifications.id, existing.id),
            eq(engagementNotifications.userId, principal.userId),
            visibility,
            liveGate,
          ),
        );
    }
    return { ok: true };
  }

  async function markAllRead(principal: SessionPrincipal): Promise<{ markedCount: number }> {
    assertFullSession(principal);
    await ensureLegacyBackfilled();
    const visibility = staffOnlyVisibilityPredicate(principal);
    const liveGate = liveNotificationPredicate();
    const unreadRows = await db
      .select({ id: engagementNotifications.id })
      .from(engagementNotifications)
      .where(
        and(
          eq(engagementNotifications.userId, principal.userId),
          visibility,
          liveGate,
          isNull(engagementNotifications.readAt),
        ),
      )
      .limit(1000);
    if (unreadRows.length === 0) return { markedCount: 0 };

    const [upd] = await db
      .update(engagementNotifications)
      .set({ readAt: clock.now() })
      .where(
        and(
          eq(engagementNotifications.userId, principal.userId),
          visibility,
          liveGate,
          isNull(engagementNotifications.readAt),
          inArray(
            engagementNotifications.id,
            unreadRows.map((row) => row.id),
          ),
        ),
      );
    return { markedCount: Number(upd.affectedRows ?? unreadRows.length) };
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
    await ensureLegacyBackfilled();
    const [row] = await db
      .select({ total: count(engagementNotifications.id) })
      .from(engagementNotifications)
      .where(and(isNull(engagementNotifications.readAt), liveNotificationPredicate()));
    return Number(row?.total ?? 0);
  }

  return {
    notify,
    backfillLegacyTargets,
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
