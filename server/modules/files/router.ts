/**
 * Files module — tRPC router (mounted at `trpc.files.*`). Owner: files module engineer.
 * Nest customer/staff/admin sub-routers as needed. Use only the guards from server/trpc/trpc.ts.
 */
import { z } from "zod";
import { adminProcedure, protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { fileVisibilities } from "./schema.js";
import { audioRulesSchema, fileRulesSchema } from "./settings.js";

const id = z.string().length(26).regex(ULID_PATTERN);
const file = z.strictObject({ fileId: id });

export const filesRouter = router({
  list: protectedProcedure.input(z.strictObject({
    orderId: id,
    cursor: z.string().length(35).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    includeVersions: z.boolean().optional(),
    includeDeleted: z.boolean().optional(),
  })).query(({ ctx, input }) => ctx.services.files.list(ctx.session, input.orderId, input)),
  issueDownloadTicket: protectedProcedure.meta({ rateLimit: "expensive" }).input(file)
    .mutation(({ ctx, input }) => ctx.services.files.issueDownloadTicket(ctx.session, input.fileId)),
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
  }),
});
