/**
 * Audit module — tRPC router (mounted at `trpc.audit.*`). Owner: audit engineer.
 * Every procedure is admin-only (capability checked here AND re-checked inside the service), except
 * `orderActivity` and `orderStatusHistory`, which follows the orders read policy and returns the customer-safe projection to customers.
 */
import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { AUDIT_CATEGORIES } from "../../core/types.js";
import { adminProcedure, protectedProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { ORDER_ACTIVITY_CATEGORIES, ORDER_ACTIVITY_MAX_PAGE } from "./orderActivity.js";
import { CASE_SEVERITIES, CASE_STATUSES } from "./cases.js";
import { EXPORT_FORMATS, EXPORT_PROFILES } from "./formats.js";
import { auditQuerySchema, MAX_PAGE, PIVOT_KINDS, STAT_BUCKETS, STAT_DIMENSIONS } from "./query.js";
import { MAX_RETAIN_DAYS, MIN_RETAIN_DAYS } from "./retention.js";
import { BAN_DURATIONS, CLOSE_REASONS, INCIDENT_STATUSES } from "./correlation/incidents.js";
import { INCIDENT_SEVERITIES, RULE_KEYS, correlationConfigSchema } from "./correlation/rules.js";

const ulidId = z.string().regex(ULID_PATTERN);
const eventId = z.string().regex(ULID_PATTERN);
const cursor = z.string().max(200).regex(/^[A-Za-z0-9_-]*$/).nullish();
const isoDate = z.string().max(40).datetime({ offset: true });

const read = adminProcedure.use(requireCapability("audit.read"));
const manageCases = adminProcedure.use(requireCapability("audit.cases.manage"));
const exportCap = adminProcedure.use(requireCapability("audit.export"));
const retentionCap = adminProcedure.use(requireCapability("audit.retention.manage"));
const incidentsRead = adminProcedure.use(requireCapability("security.incidents.read"));
const banCap = incidentsRead.use(requireCapability("security.firewall.manage"));
const revokeCap = incidentsRead.use(requireCapability("sessions.revoke_any"));
const banDuration = z.union([z.literal(BAN_DURATIONS[0]), z.literal(BAN_DURATIONS[1]), z.literal(BAN_DURATIONS[2]), z.literal(BAN_DURATIONS[3]), z.null()]);
const banReason = z.string().trim().min(3).max(240);
const incidentRef = z.strictObject({ publicId: ulidId, expectedVersion: z.number().int().min(1).max(2_147_483_647) });

const searchInput = z.strictObject({
  query: auditQuerySchema,
  cursor,
  limit: z.number().int().min(1).max(MAX_PAGE).optional(),
  actorUserPublicId: ulidId.optional(),
});

export const auditRouter = router({
  orderActivity: protectedProcedure
    .input(z.strictObject({
      orderPublicId: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/),
      category: z.enum(ORDER_ACTIVITY_CATEGORIES).optional(),
      cursor: z.string().max(600).regex(/^[A-Za-z0-9_-]*$/).nullish(),
      limit: z.number().int().min(1).max(ORDER_ACTIVITY_MAX_PAGE).optional(),
    }))
    .query(({ ctx, input }) => ctx.services.auditCenter.orderActivity(ctx.session, input)),
  orderStatusHistory: protectedProcedure
    .input(z.strictObject({
      orderPublicId: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/),
      cursor: z.string().max(800).regex(/^[A-Za-z0-9_-]*$/).nullish(),
      limit: z.number().int().min(1).max(ORDER_ACTIVITY_MAX_PAGE).optional(),
    }))
    .query(({ ctx, input }) => ctx.services.auditCenter.orderStatusHistory(ctx.session, input)),
  search: read.meta({ rateLimit: "expensive" }).input(searchInput).query(({ ctx, input }) => ctx.services.auditCenter.search(ctx.session, input)),
  event: read.input(z.strictObject({ eventId })).query(({ ctx, input }) => ctx.services.auditCenter.getEvent(ctx.session, input.eventId)),
  revealSourceAddress: read.meta({ rateLimit: "expensive" }).input(z.strictObject({ eventId }))
    .mutation(({ ctx, input }) => ctx.services.auditCenter.revealSourceAddress(ctx.session, input.eventId)),
  pivot: read.input(z.strictObject({
    eventId,
    kind: z.enum(PIVOT_KINDS),
    windowMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE).optional(),
  })).query(({ ctx, input }) => ctx.services.auditCenter.pivot(ctx.session, input)),
  stats: read.meta({ rateLimit: "expensive" }).input(z.strictObject({
    query: auditQuerySchema,
    bucket: z.enum(Object.keys(STAT_BUCKETS) as [keyof typeof STAT_BUCKETS, ...(keyof typeof STAT_BUCKETS)[]]),
    dimension: z.enum(Object.keys(STAT_DIMENSIONS) as [keyof typeof STAT_DIMENSIONS, ...(keyof typeof STAT_DIMENSIONS)[]]),
  })).query(({ ctx, input }) => ctx.services.auditCenter.stats(ctx.session, input)),

  savedQueries: router({
    list: read.query(({ ctx }) => ctx.services.auditCenter.listSavedQueries(ctx.session)),
    save: read.input(z.strictObject({ name: z.string().min(1).max(120), shared: z.boolean(), query: auditQuerySchema }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.saveQuery(ctx.session, input)),
    remove: read.input(z.strictObject({ id: ulidId })).mutation(({ ctx, input }) => ctx.services.auditCenter.deleteSavedQuery(ctx.session, input.id)),
  }),

  cases: router({
    list: read.input(z.strictObject({ status: z.enum(CASE_STATUSES).optional(), cursor, limit: z.number().int().min(1).max(100).optional() }))
      .query(({ ctx, input }) => ctx.services.auditCenter.listCases(ctx.session, input)),
    get: read.input(z.strictObject({ id: ulidId })).query(({ ctx, input }) => ctx.services.auditCenter.getCase(ctx.session, input.id)),
    create: manageCases.input(z.strictObject({ title: z.string().min(1).max(160), severity: z.enum(CASE_SEVERITIES), eventIds: z.array(eventId).max(50).optional() }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.createCase(ctx.session, input)),
    setStatus: manageCases.input(z.strictObject({ id: ulidId, status: z.enum(CASE_STATUSES) }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.updateCaseStatus(ctx.session, input.id, input.status)),
    attachEvents: manageCases.input(z.strictObject({ id: ulidId, eventIds: z.array(eventId).min(1).max(50) }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.attachEvents(ctx.session, input.id, input.eventIds)),
    addNote: manageCases.input(z.strictObject({ id: ulidId, body: z.string().min(1).max(4000) }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.addCaseNote(ctx.session, input.id, input.body)),
  }),

  exports: router({
    list: exportCap.query(({ ctx }) => ctx.services.auditCenter.listExports(ctx.session)),
    request: exportCap.meta({ rateLimit: "expensive" }).input(z.strictObject({ format: z.enum(EXPORT_FORMATS), profile: z.enum(EXPORT_PROFILES), query: auditQuerySchema }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.requestExport(ctx.session, input)),
  }),

  integrity: router({
    status: read.query(({ ctx }) => ctx.services.auditCenter.integrityStatus(ctx.session)),
    checkpoints: read.query(({ ctx }) => ctx.services.auditCenter.listCheckpoints(ctx.session)),
    verify: read.meta({ rateLimit: "expensive" }).input(z.strictObject({ fromSeq: z.number().int().min(1).optional(), maxEvents: z.number().int().min(1).max(1_000_000).optional() }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.verifyIntegrity(ctx.session, input)),
    createCheckpoint: retentionCap.mutation(({ ctx }) => ctx.services.auditCenter.createCheckpoint(ctx.session)),
  }),

  retention: router({
    get: read.query(({ ctx }) => ctx.services.auditCenter.getRetention(ctx.session)),
    setPolicy: retentionCap.input(z.strictObject({ category: z.enum(AUDIT_CATEGORIES), retainDays: z.number().int().min(MIN_RETAIN_DAYS).max(MAX_RETAIN_DAYS).nullable() }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.setRetentionPolicy(ctx.session, input)),
    createHold: retentionCap.input(z.strictObject({ label: z.string().min(1).max(120), categories: z.array(z.enum(AUDIT_CATEGORIES)).min(1).max(AUDIT_CATEGORIES.length).nullable(), from: isoDate, to: isoDate }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.createLegalHold(ctx.session, input)),
    releaseHold: retentionCap.input(z.strictObject({ id: ulidId })).mutation(({ ctx, input }) => ctx.services.auditCenter.releaseLegalHold(ctx.session, input.id)),
    run: retentionCap.meta({ rateLimit: "expensive" }).input(z.strictObject({ dryRun: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.runRetention(ctx.session, input.dryRun)),
  }),
  /** Increment 06, D7: security incidents from event correlation (`security.incidents.read`, admins). */
  incidents: router({
    list: incidentsRead
      .input(z.strictObject({
        status: z.enum(INCIDENT_STATUSES).optional(),
        severity: z.enum(INCIDENT_SEVERITIES).optional(),
        ruleKey: z.enum(RULE_KEYS).optional(),
        cursor: z.string().max(40).regex(/^\d{10,15}_\d{1,15}$/).nullish(),
        limit: z.number().int().min(1).max(100).optional(),
      }))
      .query(({ ctx, input }) => ctx.services.auditCenter.listIncidents(ctx.session, input)),
    get: incidentsRead.input(z.strictObject({ publicId: ulidId })).query(({ ctx, input }) => ctx.services.auditCenter.getIncident(ctx.session, input.publicId)),
    acknowledge: incidentsRead.input(incidentRef).mutation(({ ctx, input }) => ctx.services.auditCenter.acknowledgeIncident(ctx.session, input)),
    close: incidentsRead.input(incidentRef.extend({ reason: z.enum(CLOSE_REASONS) })).mutation(({ ctx, input }) => ctx.services.auditCenter.closeIncident(ctx.session, input)),
    banAddress: banCap
      .input(z.strictObject({ publicId: ulidId, eventId: eventId.optional(), durationMinutes: banDuration, reason: banReason }))
      .mutation(({ ctx, input }) => ctx.services.auditCenter.banIncidentAddress(ctx.session, input)),
    endSessions: revokeCap.input(z.strictObject({ publicId: ulidId })).mutation(({ ctx, input }) => ctx.services.auditCenter.endIncidentSessions(ctx.session, input)),
    rules: incidentsRead.query(({ ctx }) => ctx.services.auditCenter.getCorrelationRules(ctx.session)),
    updateRules: incidentsRead.use(requireCapability("security.firewall.manage")).input(correlationConfigSchema).mutation(({ ctx, input }) => ctx.services.auditCenter.updateCorrelationRules(ctx.session, input)),
  }),
  /** "Ban this IP" from an audit event (admins, `security.firewall.manage` with step-up). */
  banEventAddress: read
    .use(requireCapability("security.firewall.manage"))
    .input(z.strictObject({ eventId, durationMinutes: banDuration, reason: banReason }))
    .mutation(({ ctx, input }) => ctx.services.auditCenter.banEventAddress(ctx.session, input)),
});
