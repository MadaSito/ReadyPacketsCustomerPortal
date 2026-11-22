/**
 * Cart, Checkout, Upsell & Promo Code tRPC router (Increments 04 & 05, Packages L & B).
 * Owner: recovery_ops_engineer.
 */
import { DomainError } from "../../core/errors.js";
import { protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import {
  acceptUpsellInputSchema,
  addItemsInputSchema,
  adminGetOpenInputSchema,
  adminListOpenInputSchema,
  adminUpsellCreateInputSchema,
  adminUpsellDeleteInputSchema,
  adminUpsellSetActiveInputSchema,
  adminUpsellUpdateInputSchema,
  applyCodeInputSchema,
  checkoutInputSchema,
  checkoutTargetInputSchema,
  clearCartInputSchema,
  dismissUpsellInputSchema,
  removeCodeInputSchema,
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

  applyCode: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(applyCodeInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).applyCode(ctx.session, input)),

  removeCode: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(removeCodeInputSchema)
    .mutation(({ ctx, input }) => requireCartModule(ctx.services).removeCode(ctx.session, input)),

  upsell: router({
    accept: protectedProcedure
      .meta({ rateLimit: "form_submission" })
      .input(acceptUpsellInputSchema)
      .mutation(({ ctx, input }) => requireCartModule(ctx.services).acceptUpsell(ctx.session, input)),

    dismiss: protectedProcedure
      .meta({ rateLimit: "form_submission" })
      .input(dismissUpsellInputSchema)
      .mutation(({ ctx, input }) => requireCartModule(ctx.services).dismissUpsell(ctx.session, input)),
  }),

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

    /**
     * Uses `protectedProcedure` so the service returns `NOT_FOUND` (`404`) to customer sessions and
     * `FORBIDDEN` (`403`) to staff sessions without `carts.upsells.manage` (Contract §4).
     */
    upsells: router({
      list: protectedProcedure.query(({ ctx }) =>
        requireCartModule(ctx.services).adminListUpsellOffers(ctx.session),
      ),

      create: protectedProcedure
        .meta({ rateLimit: "form_submission" })
        .input(adminUpsellCreateInputSchema)
        .mutation(({ ctx, input }) =>
          requireCartModule(ctx.services).adminCreateUpsellOffer(ctx.session, input),
        ),

      update: protectedProcedure
        .meta({ rateLimit: "form_submission" })
        .input(adminUpsellUpdateInputSchema)
        .mutation(({ ctx, input }) =>
          requireCartModule(ctx.services).adminUpdateUpsellOffer(ctx.session, input),
        ),

      setActive: protectedProcedure
        .meta({ rateLimit: "form_submission" })
        .input(adminUpsellSetActiveInputSchema)
        .mutation(({ ctx, input }) =>
          requireCartModule(ctx.services).adminSetUpsellOfferActive(ctx.session, input),
        ),

      delete: protectedProcedure
        .meta({ rateLimit: "form_submission" })
        .input(adminUpsellDeleteInputSchema)
        .mutation(({ ctx, input }) =>
          requireCartModule(ctx.services).adminDeleteUpsellOffer(ctx.session, input),
        ),
    }),
  }),
});

export type CartRouter = typeof cartRouter;
