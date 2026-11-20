/**
 * Siem module — tRPC router (mounted at `trpc.siem.*`). Owner: siem module engineer.
 */
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import {
  createDestinationSchema,
  deleteDestinationSchema,
  destinationPublicIdSchema,
  listDeadLettersSchema,
  purgeDeadLettersSchema,
  replayDeadLettersSchema,
  setEnabledSchema,
  updateDestinationSchema,
} from "./validation.js";

const siemReadProcedure = adminProcedure.use(requireCapability("siem.read"));
const siemManageProcedure = adminProcedure.use(requireCapability("siem.manage"));

export const siemRouter = router({
  admin: router({
    health: siemReadProcedure.query(async ({ ctx }) => {
      const components = (await ctx.services.siem.health?.()) ?? [];
      return { components };
    }),

    destinations: router({
      list: siemReadProcedure.query(({ ctx }) => ctx.services.siem.listDestinations(ctx.session)),

      get: siemReadProcedure
        .input(destinationPublicIdSchema)
        .query(({ ctx, input }) => ctx.services.siem.getDestination(ctx.session, input.publicId)),

      create: siemManageProcedure
        .input(createDestinationSchema)
        .mutation(({ ctx, input }) => ctx.services.siem.createDestination(ctx.session, input)),

      update: siemManageProcedure
        .input(updateDestinationSchema)
        .mutation(({ ctx, input }) => ctx.services.siem.updateDestination(ctx.session, input)),

      setEnabled: siemManageProcedure
        .input(setEnabledSchema)
        .mutation(({ ctx, input }) => ctx.services.siem.setDestinationEnabled(ctx.session, input)),

      delete: siemManageProcedure
        .input(deleteDestinationSchema)
        .mutation(async ({ ctx, input }) => {
          await ctx.services.siem.deleteDestination(ctx.session, input);
          return { deleted: true as const };
        }),

      test: siemReadProcedure
        .meta({ rateLimit: "expensive" })
        .input(destinationPublicIdSchema)
        .mutation(({ ctx, input }) => ctx.services.siem.sendTestEvent(ctx.session, input)),
    }),

    deadLetters: router({
      list: siemReadProcedure
        .input(listDeadLettersSchema)
        .query(({ ctx, input }) => ctx.services.siem.listDeadLetters(ctx.session, input)),

      replay: siemManageProcedure
        .input(replayDeadLettersSchema)
        .mutation(({ ctx, input }) => ctx.services.siem.replayDeadLetters(ctx.session, input)),

      purge: siemManageProcedure
        .input(purgeDeadLettersSchema)
        .mutation(({ ctx, input }) => ctx.services.siem.purgeDeadLetters(ctx.session, input)),
    }),
  }),
});
