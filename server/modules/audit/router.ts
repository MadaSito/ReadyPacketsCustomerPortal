/**
 * Audit module — tRPC router (mounted at `trpc.audit.*`). Owner: audit engineer.
 * Every procedure is admin-only; the capability is checked here AND re-checked inside the service.
 */
import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { AUDIT_CATEGORIES } from "../../core/types.js";
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { CASE_SEVERITIES, CASE_STATUSES } from "./cases.js";
import { EXPORT_FORMATS, EXPORT_PROFILES } from "./formats.js";
import { auditQuerySchema, MAX_PAGE, PIVOT_KINDS, STAT_BUCKETS, STAT_DIMENSIONS } from "./query.js";
import { MAX_RETAIN_DAYS, MIN_RETAIN_DAYS } from "./retention.js";

const ulidId = z.string().regex(ULID_PATTERN);
const eventId = z.string().regex(ULID_PATTERN);
const cursor = z.string().max(200).regex(/^[A-Za-z0-9_-]*$/).nullish();
const isoDate = z.string().max(40).datetime({ offset: true });

const read = adminProcedure.use(requireCapability("audit.read"));
const manageCases = adminProcedure.use(requireCapability("audit.cases.manage"));
const exportCap = adminProcedure.use(requireCapability("audit.export"));
const retentionCap = adminProcedure.use(requireCapability("audit.retention.manage"));

const searchInput = z.strictObject({
  query: auditQuerySchema,
  cursor,
  limit: z.number().int().min(1).max(MAX_PAGE).optional(),
  actorUserPublicId: ulidId.optional(),
});

export const auditRouter = router({
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
});
