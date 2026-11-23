/**
 * trpc.reports.* (D6). Built-ins: staff + admin (reports.read). Custom definitions: admin (reports.manage).
 * Exports: reports.export (fresh step-up). Run/export/preview are "expensive" for the edge rate limiter; the
 * service also enforces its own per-user slot and rate limit and re-validates the live session.
 */
import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { adminProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import type { ReportsModule } from "./index.js";
import { builtInRunSchema, definitionInputSchema, reportSpecSchema } from "./spec.js";

const read = staffProcedure.use(requireCapability("reports.read"));
const readExpensive = read.meta({ rateLimit: "expensive" });
const manage = adminProcedure.use(requireCapability("reports.manage"));
const manageExpensive = manage.meta({ rateLimit: "expensive" });
const exportBuiltIn = staffProcedure.use(requireCapability("reports.export")).meta({ rateLimit: "expensive" });
const exportCustom = adminProcedure.use(requireCapability("reports.manage")).use(requireCapability("reports.export")).meta({ rateLimit: "expensive" });

const definitionId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const version = z.number().int().min(1);

function reports(services: Services): ReportsModule {
  const module = (services as Services & { reports?: ReportsModule }).reports;
  if (!module) throw new DomainError("UNAVAILABLE", "REPORTS_UNAVAILABLE", "Reports are not available right now.");
  return module;
}

export const reportsRouter = router({
  catalogue: read.query(({ ctx }) => reports(ctx.services).catalogue(ctx.session)),
  builtIn: router({
    run: readExpensive.input(builtInRunSchema).query(({ ctx, input }) => reports(ctx.services).builtIn.run(ctx.session, input)),
    export: exportBuiltIn
      .input(builtInRunSchema.extend({ panel: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u) }))
      .mutation(({ ctx, input }) => reports(ctx.services).builtIn.export(ctx.session, input)),
  }),
  custom: router({
    list: manage
      .input(z.strictObject({ cursor: definitionId.nullish(), scope: z.enum(["mine", "shared", "all"]).optional() }).default({}))
      .query(({ ctx, input }) => reports(ctx.services).custom.list(ctx.session, input)),
    get: manage.input(z.strictObject({ definitionId })).query(({ ctx, input }) => reports(ctx.services).custom.get(ctx.session, input.definitionId)),
    create: manage.input(definitionInputSchema).mutation(({ ctx, input }) => reports(ctx.services).custom.create(ctx.session, input)),
    update: manage
      .input(z.strictObject({ definitionId, expectedVersion: version, definition: definitionInputSchema }))
      .mutation(({ ctx, input }) => reports(ctx.services).custom.update(ctx.session, input.definitionId, input.expectedVersion, input.definition)),
    duplicate: manage
      .input(z.strictObject({ definitionId, name: z.string().trim().min(1).max(120).optional() }))
      .mutation(({ ctx, input }) => reports(ctx.services).custom.duplicate(ctx.session, input.definitionId, input.name)),
    delete: manage
      .input(z.strictObject({ definitionId, expectedVersion: version }))
      .mutation(({ ctx, input }) => reports(ctx.services).custom.delete(ctx.session, input.definitionId, input.expectedVersion)),
    preview: manageExpensive.input(z.strictObject({ spec: reportSpecSchema })).mutation(({ ctx, input }) => reports(ctx.services).custom.preview(ctx.session, input.spec)),
    run: manageExpensive.input(z.strictObject({ definitionId })).mutation(({ ctx, input }) => reports(ctx.services).custom.run(ctx.session, input.definitionId)),
    export: exportCustom.input(z.strictObject({ definitionId })).mutation(({ ctx, input }) => reports(ctx.services).custom.export(ctx.session, input.definitionId)),
  }),
});
