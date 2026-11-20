import { z } from "zod";
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { ULID_PATTERN } from "../../core/ids.js";

const id = z.string().regex(ULID_PATTERN, "Enter a valid public ID.");
const digest = z.string().regex(/^[0-9a-f]{64}$/, "Enter a valid plan digest.");
const page = z.strictObject({ cursor: id.optional(), limit: z.int().min(1).max(100).optional() });
const importById = z.strictObject({ importId: id });
const exportAction = adminProcedure.use(requireCapability("portable.export")).meta({ rateLimit: "expensive" });
const importAction = adminProcedure.use(requireCapability("portable.import")).meta({ rateLimit: "expensive" });
const exportSelection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("customers"), ids: z.array(id).min(1).max(100) }),
  z.strictObject({ kind: z.literal("orders"), ids: z.array(id).min(1).max(100) }),
]);

export const portableRouter = router({
  admin: router({
    listExports: adminProcedure.input(page).query(({ ctx, input }) => ctx.services.portable.listExports(ctx.session, input)),
    listImports: adminProcedure.input(page).query(({ ctx, input }) => ctx.services.portable.listImports(ctx.session, input)),
    getImport: adminProcedure.input(importById).query(({ ctx, input }) => ctx.services.portable.getImport(ctx.session, input.importId)),
    startExport: exportAction.input(z.strictObject({ selection: exportSelection, passphrase: z.string().min(16).max(512) }))
      .mutation(({ ctx, input }) => ctx.services.portable.startExport(ctx.session, input)),
    verifyAndPlan: importAction.input(z.strictObject({ importId: id, passphrase: z.string().min(1).max(512) }))
      .mutation(({ ctx, input }) => ctx.services.portable.verifyAndPlan(ctx.session, input)),
    approve: importAction.input(z.strictObject({ importId: id, planDigest: digest }))
      .mutation(({ ctx, input }) => ctx.services.portable.approve(ctx.session, input)),
    cancel: importAction.input(importById).mutation(({ ctx, input }) => ctx.services.portable.cancel(ctx.session, input.importId)),
    accept: importAction.input(z.strictObject({ importId: id, planDigest: digest, independentChecks: z.literal(true) }))
      .mutation(({ ctx, input }) => ctx.services.portable.accept(ctx.session, input)),
  }),
});
