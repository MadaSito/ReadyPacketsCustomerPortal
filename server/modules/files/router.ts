/**
 * Files module — tRPC router (mounted at `trpc.files.*`). Owner: files module engineer.
 * Nest customer/staff/admin sub-routers as needed. Use only the guards from server/trpc/trpc.ts.
 */
import { z } from "zod";
import { stageKeySchema } from "../../../shared/workflowStages.js";
import { adminProcedure, protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { fileVisibilities } from "./schema.js";
import { uploadIntents } from "./governance.js";
import { audioRulesSchema, documentEditingRulesSchema, fileRulesSchema, slotKeySchema } from "./settings.js";

const id = z.string().length(26).regex(ULID_PATTERN);
const file = z.strictObject({ fileId: id });
const document = z.strictObject({ orderPublicId: id, filePublicId: id, taskKey: slotKeySchema.optional() });

export const filesRouter = router({
  recording: router({
    preflight: protectedProcedure
      .input(z.strictObject({ orderPublicId: id, slotKey: slotKeySchema.optional(), stageKey: stageKeySchema.optional() }))
      .query(({ ctx, input }) => ctx.services.files.recordingPreflight(ctx.session, input.orderPublicId, input.slotKey, input.stageKey)),
  }),
  phasePolicy: protectedProcedure.input(z.strictObject({ orderPublicId: id, stageKey: stageKeySchema, intent: z.enum(uploadIntents) }))
    .query(({ ctx, input }) => ctx.services.files.phasePolicy(ctx.session, input.orderPublicId, input.stageKey, input.intent)),
  teamFiles: protectedProcedure.input(z.strictObject({ orderPublicId: id, stageKey: stageKeySchema, cursor: z.string().length(35).optional() }))
    .query(({ ctx, input }) => ctx.services.files.teamFiles(ctx.session, input.orderPublicId, input.stageKey, input.cursor)),
  document: router({
    status: protectedProcedure.input(document).query(({ ctx, input }) => ctx.services.files.documentStatus(ctx.session, input)),
    versions: protectedProcedure.input(document).query(({ ctx, input }) => ctx.services.files.listDocumentVersions(ctx.session, input)),
  }),
  list: protectedProcedure.input(z.strictObject({
    orderId: id,
    stageKey: stageKeySchema.optional(),
    cursor: z.string().length(35).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    includeVersions: z.boolean().optional(),
    includeDeleted: z.boolean().optional(),
    phaseUploadKind: z.enum(["document", "audio"]).optional(),
  })).query(({ ctx, input }) => ctx.services.files.list(ctx.session, input.orderId, { ...input, preferConvertedAudio: true })),
  issueDownloadTicket: protectedProcedure.meta({ rateLimit: "expensive" }).input(file)
    .mutation(({ ctx, input }) => ctx.services.files.issueDownloadTicket(ctx.session, input.fileId)),
  issuePlaybackTicket: protectedProcedure.meta({ rateLimit: "expensive" }).input(z.strictObject({ orderId: id, fileId: id }))
    .mutation(({ ctx, input }) => ctx.services.files.issuePlaybackTicket(ctx.session, input.orderId, input.fileId)),
  readTranscript: protectedProcedure.meta({ rateLimit: "expensive" }).input(file)
    .mutation(({ ctx, input }) => ctx.services.files.readTranscript(ctx.session, input.fileId)),
  setVisibility: staffProcedure.use(requireCapability("files.visibility.change"))
    .input(z.strictObject({ fileId: id, visibility: z.enum(fileVisibilities) }))
    .mutation(({ ctx, input }) => ctx.services.files.setVisibility(ctx.session, input.fileId, input.visibility)),
  remove: staffProcedure.use(requireCapability("files.manage")).input(file)
    .mutation(({ ctx, input }) => ctx.services.files.remove(ctx.session, input.fileId)),
  restore: staffProcedure.use(requireCapability("files.manage")).input(file)
    .mutation(({ ctx, input }) => ctx.services.files.restore(ctx.session, input.fileId)),
  admin: router({
    get: adminProcedure.query(({ ctx }) => ctx.services.files.adminOverview(ctx.session)),
    setTypeRules: adminProcedure.use(requireCapability("platform.settings.manage")).input(fileRulesSchema)
      .mutation(({ ctx, input }) => ctx.services.files.setTypeRules(ctx.session, input)),
    setAudioRules: adminProcedure.use(requireCapability("platform.settings.manage")).input(audioRulesSchema)
      .mutation(({ ctx, input }) => ctx.services.files.setAudioRules(ctx.session, input)),
    setDocumentEditingRules: adminProcedure.use(requireCapability("platform.settings.manage")).input(documentEditingRulesSchema)
      .mutation(({ ctx, input }) => ctx.services.files.setDocumentEditingRules(ctx.session, input)),
  }),
});
