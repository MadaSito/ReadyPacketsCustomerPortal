/**
 * trpc.sharepoint.admin.* — admin + storage.manage; every call re-validates the live administrator and fresh
 * step-up inside the service (assertCurrentStorageAdmin). Provider calls use the "expensive" rate limit.
 */
import { z } from "zod";
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { SHAREPOINT_SYNC_STATES } from "./schema.js";

const admin = adminProcedure.use(requireCapability("storage.manage"));
const expensive = admin.meta({ rateLimit: "expensive" });
const publicId = z.string().regex(/^[0-9A-Z]{26}$/u);
const graphId = z.string().regex(/^[A-Za-z0-9!._,{}-]{1,200}$/u);
const connection = { connectionPublicId: publicId, expectedVersion: z.number().int().min(1) };

export const sharepointRouter = router({
  admin: router({
    discoverSite: expensive
      .input(z.strictObject({ ...connection, siteUrl: z.string().min(1).max(2048) }))
      .mutation(({ ctx, input }) => ctx.services.sharepoint.discovery.discoverSite(ctx.session, input)),
    listDrives: expensive
      .input(z.strictObject({ ...connection, siteId: graphId }))
      .mutation(({ ctx, input }) => ctx.services.sharepoint.discovery.listDrives(ctx.session, input)),
    resolveOneDrive: expensive
      .input(z.strictObject({ ...connection, userPrincipalName: z.string().email().max(254) }))
      .mutation(({ ctx, input }) => ctx.services.sharepoint.discovery.resolveOneDrive(ctx.session, input)),
    listFolders: expensive
      .input(z.strictObject({ ...connection, kind: z.enum(["sharepoint", "onedrive"]), driveId: graphId, parentItemId: graphId.nullish(), cursor: z.string().max(1024).nullish() }))
      .mutation(({ ctx, input }) => ctx.services.sharepoint.discovery.listFolders(ctx.session, input)),
    orderSync: router({
      get: admin.query(({ ctx }) => ctx.services.sharepoint.orderSync.get(ctx.session)),
      listLists: expensive.mutation(({ ctx }) => ctx.services.sharepoint.orderSync.listLists(ctx.session)),
      createList: expensive
        .input(z.strictObject({ displayName: z.string().min(1).max(120) }))
        .mutation(({ ctx, input }) => ctx.services.sharepoint.orderSync.createList(ctx.session, input)),
      update: expensive
        .input(z.strictObject({ expectedVersion: z.number().int().min(0), enabled: z.boolean(), listId: graphId.nullable(), listLabel: z.string().max(255).nullable(), includePortalLink: z.boolean() }))
        .mutation(({ ctx, input }) => ctx.services.sharepoint.orderSync.update(ctx.session, input)),
      test: expensive.mutation(({ ctx }) => ctx.services.sharepoint.orderSync.test(ctx.session)),
      resyncAll: expensive.mutation(({ ctx }) => ctx.services.sharepoint.orderSync.resyncAll(ctx.session)),
      backfill: expensive.input(z.object({ restart: z.boolean().optional() }).strict().default({})).mutation(({ ctx, input }) => ctx.services.sharepoint.orderSync.backfill(ctx.session, input)),
      status: admin
        .input(z.strictObject({ cursor: z.string().max(16).nullish(), limit: z.number().int().min(1).max(100).optional(), state: z.enum(SHAREPOINT_SYNC_STATES).optional() }))
        .query(({ ctx, input }) => ctx.services.sharepoint.orderSync.status(ctx.session, { ...input, state: input.state })),
    }),
  }),
});
