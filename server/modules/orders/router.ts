/**
 * Orders module — tRPC router (mounted at `trpc.orders.*`). Owner: orders module engineer.
 * Routers validate + guard + delegate; resource scope lives in the services (policy.ts).
 */
import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { adminProcedure, protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { GRANT_ROLES, NOTE_VISIBILITIES, ORDER_LOCK_STATES, PACKET_TIERS } from "./schema.js";
import { bundleRuleSchema } from "./settings.js";

const id = z.string().regex(ULID_PATTERN);
const nfc = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(z.string().min(min).max(max));
const version = z.number().int().min(1).max(2_147_483_647);
const statusKey = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,47}$/);
const cursor = z.string().min(1).max(40).optional();
const limit = z.number().int().min(1).max(100).optional();
const currency = z.string().regex(/^[A-Z]{3}$/);
const priceMinor = z.number().int().min(0).max(100_000_000_000);
const packetNumber = z.number().int().min(1).max(255);
const groupKey = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const productTerms = {
  name: nfc(1, 160),
  description: nfc(0, 2000),
  features: z.array(nfc(1, 200)).max(50),
  priceMinor,
  currency,
  // Increment 02: omitted on update = keep current. features = deliverable titles when deliverables are non-empty.
  outcome: nfc(0, 1000).optional(),
  timeline: nfc(0, 120).optional(),
  deliverables: z.array(z.strictObject({ title: nfc(1, 200), detail: nfc(0, 2000) })).max(100).optional(),
  packetNumber: packetNumber.nullable().optional(),
  tier: z.enum(PACKET_TIERS).nullable().optional(),
};
const groupPlacement = { groupKey: groupKey.nullable().optional(), packetNumber: packetNumber.nullable().optional() };
const orderItems = z
  .array(z.strictObject({ productPublicId: id, quantity: z.number().int().min(1).max(1000) }))
  .min(1)
  .max(50);

const catalogAdmin = router({
  list: adminProcedure.use(requireCapability("catalog.manage")).query(({ ctx }) => ctx.services.orders.catalog.listAll()),
  createGroup: adminProcedure
    .use(requireCapability("catalog.manage"))
    .input(z.strictObject({ name: nfc(1, 120), description: nfc(0, 1000), sortOrder: z.number().int().min(0).max(10_000), active: z.boolean(), ...groupPlacement }))
    .mutation(({ ctx, input }) => ctx.services.orders.catalog.createGroup(ctx.session, input)),
  updateGroup: adminProcedure
    .use(requireCapability("catalog.manage"))
    .input(
      z.strictObject({
        groupId: id,
        expectedVersion: version,
        name: nfc(1, 120),
        description: nfc(0, 1000),
        sortOrder: z.number().int().min(0).max(10_000),
        active: z.boolean(),
        ...groupPlacement,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.orders.catalog.updateGroup(ctx.session, input)),
  createProduct: adminProcedure
    .use(requireCapability("catalog.manage"))
    .input(
      z.strictObject({
        groupId: id,
        productKey: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
        sortOrder: z.number().int().min(0).max(10_000),
        active: z.boolean(),
        ...productTerms,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.orders.catalog.createProduct(ctx.session, input)),
  updateProduct: adminProcedure
    .use(requireCapability("catalog.manage"))
    .input(
      z.strictObject({
        productId: id,
        expectedVersion: version,
        groupId: id,
        sortOrder: z.number().int().min(0).max(10_000),
        active: z.boolean(),
        ...productTerms,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.orders.catalog.updateProduct(ctx.session, input)),
  bundleRule: adminProcedure.use(requireCapability("catalog.manage")).query(({ ctx }) => ctx.services.orders.catalog.getBundleRule()),
  updateBundleRule: adminProcedure
    .use(requireCapability("catalog.manage"))
    .input(z.strictObject({ rule: bundleRuleSchema }))
    .mutation(({ ctx, input }) => ctx.services.orders.catalog.updateBundleRule(ctx.session, input.rule)),
});

const workflowsAdmin = router({
  list: adminProcedure.use(requireCapability("workflows.manage")).query(({ ctx }) => ctx.services.orders.workflows.list()),
  create: adminProcedure
    .use(requireCapability("workflows.manage"))
    .input(z.strictObject({ workflowKey: statusKey, name: nfc(1, 120), definition: z.unknown() }))
    .mutation(({ ctx, input }) => ctx.services.orders.workflows.create(ctx.session, input)),
  publish: adminProcedure
    .use(requireCapability("workflows.manage"))
    .input(z.strictObject({ workflowId: id, expectedVersion: version, name: nfc(1, 120), definition: z.unknown(), makeDefault: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.services.orders.workflows.publish(ctx.session, input)),
});

const sharing = router({
  list: protectedProcedure.input(z.strictObject({ orderId: id })).query(({ ctx, input }) => ctx.services.orders.sharing.list(ctx.session, input.orderId)),
  invite: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(z.strictObject({ orderId: id, email: z.string().min(3).max(254), role: z.enum(GRANT_ROLES) }))
    .mutation(({ ctx, input }) => ctx.services.orders.sharing.invite(ctx.session, input)),
  revoke: protectedProcedure
    .input(z.strictObject({ orderId: id, grantId: id }))
    .mutation(({ ctx, input }) => ctx.services.orders.sharing.revoke(ctx.session, input)),
  myInvitations: protectedProcedure.query(({ ctx }) => ctx.services.orders.sharing.myInvitations(ctx.session)),
  respond: protectedProcedure
    .input(z.strictObject({ grantId: id, accept: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.services.orders.sharing.respond(ctx.session, input)),
});

export const ordersRouter = router({
  catalog: router({
    list: protectedProcedure.query(({ ctx }) => ctx.services.orders.catalog.listActive()),
  }),
  /** Server price of a selection (packet rules + bundle discount); same validation as create, writes nothing. */
  quote: protectedProcedure.input(z.strictObject({ items: orderItems })).query(({ ctx, input }) => ctx.services.orders.orders.quote(ctx.session, input)),
  list: protectedProcedure
    .input(z.strictObject({ cursor, limit, status: statusKey.optional() }))
    .query(({ ctx, input }) => ctx.services.orders.orders.list(ctx.session, input)),
  get: protectedProcedure.input(z.strictObject({ orderId: id })).query(({ ctx, input }) => ctx.services.orders.orders.get(ctx.session, input.orderId, "customer")),
  summary: protectedProcedure.input(z.strictObject({ orderId: id })).query(({ ctx, input }) => ctx.services.orders.getOrderSummary(ctx.session, input.orderId)),
  create: protectedProcedure
    .use(requireCapability("orders.create"))
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        projectName: nfc(1, 160),
        items: orderItems,
        note: nfc(1, 5000).optional(),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.orders.orders.create(ctx.session, input)),
  update: protectedProcedure
    .input(z.strictObject({ orderId: id, expectedVersion: version, projectName: nfc(1, 160) }))
    .mutation(({ ctx, input }) => ctx.services.orders.orders.update(ctx.session, input)),
  addNote: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(z.strictObject({ orderId: id, body: nfc(1, 5000), visibility: z.enum(NOTE_VISIBILITIES).optional() }))
    .mutation(({ ctx, input }) => ctx.services.orders.orders.addNote(ctx.session, input)),
  transition: protectedProcedure
    .input(
      z.strictObject({
        orderId: id,
        expectedVersion: version,
        toStatus: statusKey,
        note: nfc(1, 5000).optional(),
        noteVisibility: z.enum(NOTE_VISIBILITIES).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.orders.orders.transition(ctx.session, input)),
  sharing,
  admin: router({
    list: staffProcedure
      .use(requireCapability("orders.read_all"))
      .input(
        z.strictObject({
          cursor,
          limit,
          status: statusKey.optional(),
          lockState: z.enum(ORDER_LOCK_STATES).optional(),
          customerPublicId: id.optional(),
          from: z.date().optional(),
          to: z.date().optional(),
          referencePrefix: z.string().regex(/^[A-Za-z0-9-]{1,32}$/).optional(),
        }),
      )
      .query(({ ctx, input }) => ctx.services.orders.orders.adminList(ctx.session, input)),
    get: staffProcedure
      .use(requireCapability("orders.read_all"))
      .input(z.strictObject({ orderId: id }))
      .query(({ ctx, input }) => ctx.services.orders.orders.get(ctx.session, input.orderId, "console")),
    referenceHistory: staffProcedure
      .use(requireCapability("orders.read_all"))
      .input(z.strictObject({ orderId: id }))
      .query(({ ctx, input }) => ctx.services.orders.orders.referenceHistory(ctx.session, input.orderId)),
    createForCustomer: staffProcedure
      .use(requireCapability("orders.manage"))
      .input(
        z.strictObject({
          customerPublicId: id,
          projectName: nfc(1, 160),
          items: z
            .array(z.strictObject({ productPublicId: id, quantity: z.number().int().min(1).max(1000) }))
            .min(1)
            .max(50),
          note: nfc(1, 5000).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
        }),
      )
      .mutation(({ ctx, input }) => {
        const { customerPublicId, ...rest } = input;
        return ctx.services.orders.orders.create(ctx.session, { ...rest, onBehalfOfCustomerPublicId: customerPublicId });
      }),
    setLock: staffProcedure
      .use(requireCapability("orders.manage"))
      .input(z.strictObject({ orderId: id, expectedVersion: version, lockState: z.enum(ORDER_LOCK_STATES), reasonCode }))
      .mutation(({ ctx, input }) => ctx.services.orders.orders.setLock(ctx.session, input)),
    changeReference: adminProcedure
      .use(requireCapability("orders.identifiers.change"))
      .input(z.strictObject({ orderId: id, expectedVersion: version, newReference: z.string().min(3).max(32), reasonCode }))
      .mutation(({ ctx, input }) => ctx.services.orders.orders.changeReference(ctx.session, input)),
    reassign: adminProcedure
      .use(requireCapability("orders.reassign"))
      .input(
        z.strictObject({
          orderId: id,
          targetCustomerPublicId: id,
          expectedVersion: version,
          operationId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
          reasonCode,
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.orders.orders.reassign(ctx.session, input)),
    catalog: catalogAdmin,
    workflows: workflowsAdmin,
  }),
});
