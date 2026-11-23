import { and, asc, count, eq, exists, gt, inArray, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import type { UserRole } from "../../../shared/domain.js";
import { conflict, forbidden, notFound, validation } from "../../core/errors.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { users, userSessions } from "../identity/schema.js";
import { defineSetting } from "../platform/settingsRegistry.js";
import { assertLiveActorInTx, runComplianceTx } from "./actorAuth.js";
import { type POLICY_ENFORCEMENT_MODES, type POLICY_ENFORCEMENT_REASONS, policyEnforcementActions, policyEnforcementPreferences } from "./policyEnforcementSchema.js";
import { audienceUserFilter, hasPortalAcceptance } from "./policyNotices.js";
import { policyDocuments, policyVersions } from "./schema.js";

export const POLICY_WARNING_SETTING = "compliance.policies.default_enforcement_warning";
export const DEFAULT_POLICY_WARNING = "Review and accept {policy} by {deadline} to keep using the portal. Time remaining: {timeLeft}.";
export const warningTextSchema = z.string().trim().min(1).max(1000)
  .refine((text) => !/[{}]/u.test(text.replaceAll(/\{(?:policy|deadline|timeLeft)\}/gu, "")),
    "Use only {policy}, {deadline}, and {timeLeft} as placeholders.");
defineSetting({
  key: POLICY_WARNING_SETTING,
  owner: "compliance",
  group: "compliance",
  label: "Default policy enforcement warning",
  description: "Plain-text warning shown before the policy grace period expires.",
  schema: warningTextSchema,
  default: DEFAULT_POLICY_WARNING,
  sensitivity: "internal",
  writeCapability: "policies.manage",
  managedBy: { href: "/admin/policies", label: "Policies" },
});
type ActorRole = UserRole;
type EnforcementMode = (typeof POLICY_ENFORCEMENT_MODES)[number];
type EnforcementReason = (typeof POLICY_ENFORCEMENT_REASONS)[number];
type Actor = { userId: number; role: ActorRole };
const HOUR_MS = 3_600_000;
const SWEEP = "compliance.policy_enforcement.sweep";
const newer = alias(policyVersions, "newer_enforced_policy_version");
const preference = policyEnforcementPreferences;

export function parsePolicyWarning(raw: unknown): string {
  const value = warningTextSchema.safeParse(raw);
  return value.success ? value.data : DEFAULT_POLICY_WARNING;
}

export function policyDeadline(publishedAt: Date, effectiveAt: Date, enabledAt: Date, graceHours: number): Date {
  return new Date(Math.max(publishedAt.getTime(), effectiveAt.getTime(), enabledAt.getTime()) + graceHours * HOUR_MS);
}

function latestEffective(db: DbOrTx, now: Date) {
  return and(
    eq(policyVersions.status, "published"), eq(policyVersions.origin, "portal"), lte(policyVersions.effectiveAt, now),
    notExists(db.select({ id: newer.id }).from(newer).where(and(
      eq(newer.documentId, policyVersions.documentId), eq(newer.status, "published"), eq(newer.origin, "portal"),
      lte(newer.effectiveAt, now),
      or(gt(newer.versionNumber, policyVersions.versionNumber), and(eq(newer.versionNumber, policyVersions.versionNumber), gt(newer.id, policyVersions.id))),
    ))),
  );
}

const deadlineSql = sql<Date>`TIMESTAMPADD(HOUR, ${preference.graceHours}, GREATEST(
  COALESCE(${policyVersions.publishedAt}, ${policyVersions.effectiveAt}), ${policyVersions.effectiveAt},
  COALESCE(${preference.enabledAt}, ${policyVersions.effectiveAt})
))`;

function activeAudience(role: ActorRole) {
  return inArray(policyDocuments.audience, ["all", role === "customer" ? "customer" : "staff"]);
}

function processed(db: DbOrTx, userId: number | typeof users.id) {
  return db.select({ id: policyEnforcementActions.id }).from(policyEnforcementActions).where(and(
    eq(policyEnforcementActions.policyVersionId, policyVersions.id), eq(policyEnforcementActions.userId, userId),
    sql`${policyEnforcementActions.completedAt} >= ${preference.enabledAt}`,
  ));
}

export function createPolicyEnforcement(deps: ModuleDeps) {
  const disabledByHost = deps.config.policyEnforcementDisabled;
  if (disabledByHost) deps.logger.warn("Policy session enforcement disabled by break-glass host override", {
    reasonCode: "POLICY_ENFORCEMENT_DISABLED",
  });

  function candidates(db: DbOrTx, userId: number, role: ActorRole, now: Date) {
    return and(
      eq(policyDocuments.active, true), eq(policyDocuments.requiresAcceptance, true),
      eq(preference.mode, "required_to_continue"), activeAudience(role), latestEffective(db, now),
      notExists(hasPortalAcceptance(db, policyVersions.id, userId)),
    );
  }

  async function requiresRemediation(userId: number, role: ActorRole, db: DbOrTx = deps.db): Promise<boolean> {
    if (disabledByHost) return false;
    const now = deps.clock.now();
    const [row] = await db.select({ id: policyVersions.id }).from(preference)
      .innerJoin(policyDocuments, eq(policyDocuments.id, preference.documentId))
      .innerJoin(policyVersions, eq(policyVersions.documentId, policyDocuments.id))
      .where(and(candidates(db, userId, role, now), or(lte(deadlineSql, now), exists(processed(db, userId))))).limit(1);
    return row !== undefined;
  }

  async function pendingRows(userId: number, role: ActorRole, db: DbOrTx, versionPublicId?: string, onlyBlocking = false) {
    const now = deps.clock.now();
    const handled = sql<number>`EXISTS (${processed(db, userId)})`;
    return db.select({
      versionId: policyVersions.id, versionPublicId: policyVersions.publicId, documentPublicId: policyDocuments.publicId,
      title: policyDocuments.title, versionLabel: policyVersions.versionLabel, contentHash: policyVersions.contentHash,
      bodyText: policyVersions.bodyText, contentFormat: policyVersions.contentFormat, changeSummary: policyVersions.changeSummary,
      requiresTypedSignature: policyDocuments.requiresTypedSignature, publishedAt: policyVersions.publishedAt,
      effectiveAt: policyVersions.effectiveAt, enabledAt: preference.enabledAt, enforcementVersion: preference.version,
      warningText: preference.warningText, graceHours: preference.graceHours,
      handled,
    }).from(preference)
      .innerJoin(policyDocuments, eq(policyDocuments.id, preference.documentId))
      .innerJoin(policyVersions, eq(policyVersions.documentId, policyDocuments.id))
      .where(and(candidates(db, userId, role, now), versionPublicId ? eq(policyVersions.publicId, versionPublicId) : undefined,
        onlyBlocking ? or(lte(deadlineSql, now), exists(processed(db, userId))) : undefined))
      .orderBy(asc(deadlineSql), policyDocuments.id).limit(100);
  }

  type PendingRow = Awaited<ReturnType<typeof pendingRows>>[number];
  function deadline(row: PendingRow) {
    return policyDeadline(row.publishedAt ?? row.effectiveAt, row.effectiveAt, row.enabledAt ?? row.effectiveAt, row.graceHours);
  }

  function permitsPolicyStep(principal: SessionPrincipal) {
    return principal.state === "full" || principal.pendingSteps[0] === "accept_policy";
  }

  async function assertPending(userId: number, role: ActorRole, versionPublicId: string, tx: Tx): Promise<void> {
    if (disabledByHost || (await pendingRows(userId, role, tx, versionPublicId)).length === 0) {
      throw notFound("POLICY_ENFORCEMENT_ITEM_NOT_FOUND");
    }
  }

  async function pendingForUser(principal: SessionPrincipal) {
    if (!permitsPolicyStep(principal)) throw forbidden("POLICY_ENFORCEMENT_STEP_NOT_AVAILABLE");
    if (disabledByHost) return [];
    const [rows, defaultWarning] = await Promise.all([
      pendingRows(principal.userId, principal.role, deps.db, undefined, principal.state === "remediation"),
      deps.settings.get(POLICY_WARNING_SETTING, parsePolicyWarning, DEFAULT_POLICY_WARNING),
    ]);
    const now = deps.clock.now();
    return rows.map((row) => ({
      versionPublicId: row.versionPublicId, documentPublicId: row.documentPublicId,
      title: row.title, versionLabel: row.versionLabel, contentHash: row.contentHash,
      bodyText: row.bodyText, contentFormat: row.contentFormat, changeSummary: row.changeSummary,
      requiresTypedSignature: row.requiresTypedSignature, deadline: deadline(row),
      warningText: row.warningText ?? defaultWarning, blocking: Boolean(row.handled) || deadline(row) <= now,
    }));
  }

  async function adminStatus(documentPublicId: string) {
    const [row] = await deps.db.select({ doc: policyDocuments, config: preference }).from(policyDocuments)
      .leftJoin(preference, eq(policyDocuments.id, preference.documentId)).where(eq(policyDocuments.publicId, documentPublicId)).limit(1);
    if (!row) throw notFound("POLICY_DOCUMENT_NOT_FOUND");
    const [version] = await deps.db.select({ id: policyVersions.id }).from(policyVersions)
      .where(and(eq(policyVersions.documentId, row.doc.id), latestEffective(deps.db, deps.clock.now()))).limit(1);
    const [impact] = version ? await deps.db.select({ size: count() }).from(users)
      .where(and(audienceUserFilter(row.doc.audience), notExists(hasPortalAcceptance(deps.db, version.id, users.id)))) : [];
    return {
      disabledByHost, canEnable: row.doc.active && row.doc.requiresAcceptance && Boolean(version),
      mode: row.config?.mode ?? "none", graceHours: row.config?.graceHours ?? 24,
      warningText: row.config?.warningText ?? null, expectedVersion: row.config?.version ?? 0, affectedCount: impact?.size ?? 0,
    };
  }

  async function defaultStatus() {
    return { disabledByHost, warningText: await deps.settings.get(POLICY_WARNING_SETTING, parsePolicyWarning, DEFAULT_POLICY_WARNING) };
  }

  async function setWarning(principal: SessionPrincipal, value: string) {
    const warning = warningTextSchema.safeParse(value);
    if (!warning.success) throw validation("POLICY_WARNING_INVALID", "Enter a warning of up to 1,000 characters using supported placeholders.");
    const resource = { type: "policy_enforcement_settings" };
    return runComplianceTx(deps, principal, resource, async (tx) => {
      const actor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");
      await deps.settings.set(POLICY_WARNING_SETTING, warning.data, tx);
      await deps.audit.record({ category: "admin", eventName: "policy.enforcement.default_warning_changed",
        action: "update", outcome: "completed", actor, resource }, tx);
      return { warningText: warning.data };
    });
  }

  async function setConfig(principal: SessionPrincipal, input: {
    documentPublicId: string; expectedVersion: number; mode: EnforcementMode; graceHours: number;
    warningText: string | null; confirmedCount?: number | undefined;
  }) {
    if (!Number.isInteger(input.graceHours) || input.graceHours < 0 || input.graceHours > 720) {
      throw validation("POLICY_GRACE_INVALID", "Enter a whole number of grace hours from 0 to 720.");
    }
    const warningText = input.warningText === null ? null : warningTextSchema.parse(input.warningText);
    const resource = { type: "policy_document", publicId: input.documentPublicId };
    return runComplianceTx(deps, principal, resource, async (tx) => {
      const actor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");
      const [doc] = await tx.select().from(policyDocuments).where(eq(policyDocuments.publicId, input.documentPublicId)).for("update").limit(1);
      if (!doc) throw notFound("POLICY_DOCUMENT_NOT_FOUND");
      const [old] = await tx.select().from(preference).where(eq(preference.documentId, doc.id)).for("update").limit(1);
      if ((old?.version ?? 0) !== input.expectedVersion) throw conflict("POLICY_ENFORCEMENT_CHANGED", "The policy enforcement settings changed. Refresh and review.");
      const now = deps.clock.now();
      const enabling = input.mode === "required_to_continue" && old?.mode !== "required_to_continue";
      const shortensGrace = old?.mode === "required_to_continue" && input.mode === old.mode && input.graceHours < old.graceHours;
      if (input.mode === "required_to_continue") {
        if (disabledByHost) throw conflict("POLICY_ENFORCEMENT_DISABLED", "Policy session enforcement is disabled on this server.");
        const [current] = await tx.select({ id: policyVersions.id }).from(policyVersions)
          .where(and(eq(policyVersions.documentId, doc.id), latestEffective(tx, now))).limit(1);
        if (!doc.active || !doc.requiresAcceptance || !current) {
          throw conflict("POLICY_ENFORCEMENT_UNPUBLISHED", "Publish an active, required policy before enabling enforcement.");
        }
        if (enabling || shortensGrace) {
          const [impact] = await tx.select({ size: count() }).from(users)
            .where(and(audienceUserFilter(doc.audience), notExists(hasPortalAcceptance(tx, current.id, users.id))));
          if (input.confirmedCount !== (impact?.size ?? 0)) {
            throw conflict("POLICY_ENFORCEMENT_AUDIENCE_CHANGED", "Refresh and confirm the current number of affected users.");
          }
        }
      }
      const patch = { mode: input.mode, graceHours: input.graceHours, warningText,
        enabledAt: input.mode === "none" ? null : (enabling ? now : old?.enabledAt ?? now), updatedAt: now };
      const version = (old?.version ?? 0) + 1;
      await tx.insert(preference).values({ documentId: doc.id, ...patch, version }).onDuplicateKeyUpdate({ set: { ...patch, version } });
      await deps.audit.record({ category: "admin", eventName: "policy.enforcement.configuration_changed",
        action: "update", outcome: "completed", actor, resource,
        attributes: { mode: input.mode, grace_hours: input.graceHours, affects_current_audience: enabling || shortensGrace },
      }, tx);
      return { version };
    });
  }

  async function terminate(tx: Tx, userId: number, row: PendingRow, reason: EnforcementReason, actor?: Actor) {
    const now = deps.clock.now();
    const why = reason === "admin" ? "policy_admin_ended" : reason === "deadline" ? "policy_deadline" : "policy_declined";
    const result = await deps.services.identity.endSessionsForUser(userId, why, { tx });
    await tx.insert(policyEnforcementActions).values({
      policyVersionId: row.versionId, userId, enforcementVersion: row.enforcementVersion, reason, completedAt: now,
    }).onDuplicateKeyUpdate({ set: { completedAt: now } });
    await deps.audit.record({
      category: "security", eventName: "policy.enforcement.session_ended", action: "revoke", outcome: "completed",
      actor: actor ?? { role: "system" }, resource: { type: "policy_version", publicId: row.versionPublicId },
      attributes: { sessions_ended: result.ended, trigger: reason, subject_user_id: userId },
    }, tx);
    return result;
  }

  async function decline(principal: SessionPrincipal, versionPublicId: string) {
    if (disabledByHost || !permitsPolicyStep(principal)) throw forbidden("POLICY_ENFORCEMENT_STEP_NOT_AVAILABLE");
    return deps.db.transaction(async (tx) => {
      // Validate the session and acquire its user's lock before acceptance/revocation reads.
      const live = await deps.services.identity.sessions.assertCurrent(principal, tx);
      if (live.pendingSteps.length > 0 && live.pendingSteps[0] !== "accept_policy") throw forbidden("POLICY_ENFORCEMENT_STEP_NOT_AVAILABLE");
      const [row] = await pendingRows(principal.userId, principal.role, tx, versionPublicId);
      if (!row) throw notFound("POLICY_ENFORCEMENT_ITEM_NOT_FOUND");
      return terminate(tx, principal.userId, row, "declined", { userId: principal.userId, role: principal.role });
    });
  }

  async function endNow(principal: SessionPrincipal, input: { userPublicId: string; versionPublicId?: string | undefined }) {
    if (disabledByHost) throw forbidden("POLICY_ENFORCEMENT_DISABLED");
    return runComplianceTx(deps, principal, { type: "user", publicId: input.userPublicId }, async (tx) => {
      const actor = await assertLiveActorInTx(deps, principal, tx, "sessions.revoke_any");
      const [target] = await tx.select({ id: users.id, role: users.role, status: users.status }).from(users)
        .where(eq(users.publicId, input.userPublicId)).for("update").limit(1);
      if (!target || target.status !== "active") throw notFound("POLICY_ENFORCEMENT_ITEM_NOT_FOUND");
      const [row] = await pendingRows(target.id, target.role, tx, input.versionPublicId);
      if (!row) throw notFound("POLICY_ENFORCEMENT_ITEM_NOT_FOUND");
      return terminate(tx, target.id, row, "admin", actor);
    });
  }

  async function targetStatus(input: { userPublicId: string; versionPublicId?: string | undefined }) {
    if (disabledByHost) return { canEndSessions: false };
    const [target] = await deps.db.select({ id: users.id, role: users.role }).from(users)
      .where(and(eq(users.publicId, input.userPublicId), eq(users.status, "active"))).limit(1);
    return { canEndSessions: Boolean(target && (await pendingRows(target.id, target.role, deps.db, input.versionPublicId)).length > 0) };
  }

  deps.jobs.register(SWEEP, async (claim) => {
    if (disabledByHost) return { outcome: "completed" };
    const now = deps.clock.now();
    const targets = await deps.db.select({ id: users.id, versionPublicId: policyVersions.publicId })
      .from(preference).innerJoin(policyDocuments, eq(policyDocuments.id, preference.documentId))
      .innerJoin(policyVersions, eq(policyVersions.documentId, policyDocuments.id))
      .innerJoin(users, or(eq(policyDocuments.audience, "all"),
        and(eq(policyDocuments.audience, "customer"), eq(users.role, "customer")),
        and(eq(policyDocuments.audience, "staff"), inArray(users.role, ["staff", "admin"]))))
      .where(and(eq(preference.mode, "required_to_continue"), eq(policyDocuments.active, true),
        eq(policyDocuments.requiresAcceptance, true), eq(users.status, "active"), latestEffective(deps.db, now), lte(deadlineSql, now),
        notExists(hasPortalAcceptance(deps.db, policyVersions.id, users.id)), notExists(processed(deps.db, users.id)),
        exists(deps.db.select({ id: userSessions.id }).from(userSessions).where(and(eq(userSessions.userId, users.id),
          isNull(userSessions.revokedAt), gt(userSessions.absoluteExpiresAt, now), sql`${userSessions.authenticatedAt} < ${deadlineSql}`))),
      )).orderBy(users.id, policyVersions.id).limit(50);
    let ended = 0;
    for (const target of targets) {
      claim.signal.throwIfAborted();
      ended += await deps.db.transaction(async (tx) => {
        await claim.assertStillOwned(tx);
        const [user] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, target.id)).for("update").limit(1);
        if (!user || user.status !== "active") return 0;
        const [row] = await pendingRows(target.id, user.role, tx, target.versionPublicId);
        if (!row || row.handled || deadline(row) > deps.clock.now()) return 0;
        // The candidate query can go stale before the user lock (e.g. old sessions signed out).
        // Do not end fresh remediation sessions if no pre-deadline session remains.
        const [oldSession] = await tx.select({ id: userSessions.id }).from(userSessions).where(and(
          eq(userSessions.userId, target.id), isNull(userSessions.revokedAt),
          gt(userSessions.absoluteExpiresAt, deps.clock.now()), lt(userSessions.authenticatedAt, deadline(row)),
        )).limit(1).for("update");
        if (!oldSession) return 0;
        return (await terminate(tx, target.id, row, "deadline")).ended;
      });
    }
    return { outcome: "completed", safeCounts: { ended } };
  }, { retrySafe: true });
  deps.jobs.registerSchedule({ name: SWEEP, type: SWEEP, everyMs: 60_000 });

  return { pendingForUser, assertPending, requiresRemediation, adminStatus, defaultStatus, setWarning, setConfig, decline, endNow, targetStatus };
}

export type PolicyEnforcementService = ReturnType<typeof createPolicyEnforcement>;
