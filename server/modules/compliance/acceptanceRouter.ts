/**
 * Order policy acceptance gateway — tRPC (package V). Mounted as `compliance.acceptance`.
 * Owner: identity_engineer. Inputs are strict and bounded; ids are public ULIDs.
 */
import { z } from "zod";
import { protectedProcedure, router, staffProcedure } from "../../trpc/trpc.js";
import { publicIdSchema, sha256HexSchema } from "./domain.js";

const gateKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,47}$|^order_start$/, "Invalid gate.");

export const acceptanceRouter = router({
  /** The order's gates with the current policy text and whether the caller has met them. */
  forOrder: protectedProcedure
    .meta({ rateLimit: "api" })
    .input(z.strictObject({ orderId: publicIdSchema }))
    .query(({ ctx, input }) => ctx.services.compliance.acceptance.forOrder(ctx.session, input)),

  /** Customer (owner or person with access) accepts for themselves. Bound to the exact text hash. */
  accept: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        orderId: publicIdSchema,
        gateKey: gateKeySchema,
        policyVersionId: publicIdSchema,
        textSha256: sha256HexSchema,
        typedName: z.string().max(200).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.compliance.acceptance.accept(ctx.session, input)),

  /** Printable receipt (the signer, or staff/admin with access to the order). */
  receipt: protectedProcedure
    .meta({ rateLimit: "api" })
    .input(z.strictObject({ receiptId: publicIdSchema }))
    .query(({ ctx, input }) => ctx.services.compliance.acceptance.receipt(ctx.session, input)),

  console: router({
    count: staffProcedure
      .meta({ rateLimit: "api" })
      .input(z.strictObject({ orderId: publicIdSchema }))
      .query(({ ctx, input }) => ctx.services.compliance.acceptance.consoleCount(ctx.session, input)),
    list: staffProcedure
      .meta({ rateLimit: "api" })
      .input(z.strictObject({ orderId: publicIdSchema, cursor: z.string().max(40).optional(), limit: z.number().int().min(1).max(100).optional() }))
      .query(({ ctx, input }) => ctx.services.compliance.acceptance.consoleList(ctx.session, input)),
  }),
});
