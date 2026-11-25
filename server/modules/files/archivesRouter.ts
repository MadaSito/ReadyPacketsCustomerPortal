/**
 * trpc.fileArchives.* (D8 ZIP). Any full session may ask; the service decides through the Files selector
 * (phase ZIP) or requires admin + files.archive.order + fresh step-up (whole-order ZIP). All "expensive".
 */
import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import type { FileArchivesModule } from "./archives.js";

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const stageKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const scoped = z.strictObject({ orderId: id, stageKey: stageKey.nullish() });
const expensive = protectedProcedure.meta({ rateLimit: "expensive" });

function archives(services: Services): FileArchivesModule {
  const module = (services as Services & { fileArchives?: FileArchivesModule }).fileArchives;
  if (!module) throw new DomainError("UNAVAILABLE", "ARCHIVES_UNAVAILABLE", "File archives are not available right now.");
  return module;
}

export const fileArchivesRouter = router({
  request: expensive.input(scoped).mutation(({ ctx, input }) => archives(ctx.services).request(ctx.session, input)),
  status: protectedProcedure.input(z.strictObject({ archiveId: id })).query(({ ctx, input }) => archives(ctx.services).status(ctx.session, input.archiveId)),
  latest: protectedProcedure.input(scoped).query(({ ctx, input }) => archives(ctx.services).latest(ctx.session, input)),
  cancel: protectedProcedure.input(z.strictObject({ archiveId: id })).mutation(({ ctx, input }) => archives(ctx.services).cancel(ctx.session, input.archiveId)),
  issueDownloadTicket: expensive
    .input(z.strictObject({ archiveId: id }))
    .mutation(({ ctx, input }) => archives(ctx.services).issueDownloadTicket(ctx.session, input.archiveId)),
});
