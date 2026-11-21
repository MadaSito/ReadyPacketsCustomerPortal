/**
 * Cart & Checkout tRPC router (Increment 04, Package L).
 * Owner: recovery_ops_engineer.
 */
import { DomainError } from "../../core/errors.js";
import { protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import {
  addItemsInputSchema,
  adminGetOpenInputSchema,
  adminListOpenInputSchema,
  checkoutInputSchema,
  checkoutTargetInputSchema,
  clearCartInputSchema,
  removeItemInputSchema,
  saveDraftDetailsInputSchema,
  updateItemInputSchema,
  type CartModule,
} from "./types.js";

function requireCartModule(services: unknown): CartModule {
  const mod = (services as { cart?: CartModule } | null | undefined)?.cart;
  if (!mod) {
    throw new DomainError("UNAVAILABLE", "CART_MODULE_UNAVAILABLE", "Shopping cart is temporarily unavailable.");
  }
  return mod;
}

export const cartRouter = router({
  badgeCount: protectedProcedure.query(({ ctx }) => requireCartModule(ctx.services).getBadgeCount(ctx.session)),

  get: protectedProcedure.query(({ ctx }) => requireCartModule(ctx.services).getMyCart(ctx.session)),

  addItems: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(addItemsInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).addItems(ctx.session, input)),

  updateItem: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(updateItemInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).updateItem(ctx.session, input)),

  removeItem: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(removeItemInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).removeItem(ctx.session, input)),

  clear: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(clearCartInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).clearCart(ctx.session, input)),

  saveDraftDetails: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(saveDraftDetailsInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).saveDraftDetails(ctx.session, input)),

  checkout: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(checkoutInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).checkout(ctx.session, input)),

  checkoutStatus: protectedProcedure
    .input(checkoutTargetInputSchema)
    .query(({ ctx, input }) => requireCartModule(ctx.services).getCheckoutStatus(ctx.session, input)),

  restoreCheckout: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(checkoutTargetInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).restoreCheckout(ctx.session, input)),

  admin: router({
    listOpen: staffProcedure
      .use(requireCapability("carts.read_all"))
      .input(adminListOpenInputSchema)
      .query(({ ctx, input }) => requireCartModule(ctx.services).adminListOpen(ctx.session, input)),

    getOpen: staffProcedure
      .use(requireCapability("carts.read_all"))
      .input(adminGetOpenInputSchema)
      .query(({ ctx, input }) => requireCartModule(ctx.services).adminGetOpen(ctx.session, input)),
  }),
});

export type CartRouter = typeof cartRouter;
