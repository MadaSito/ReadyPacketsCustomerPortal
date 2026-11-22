/**
 * trpc.publicApi.admin.* — admin only. api.keys.manage and api.replay need fresh step-up; api.logs.read does
 * not. Every service call re-validates the live administrator inside its transaction.
 */
import { z } from "zod";
import type { Services } from "../../container.js";
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { API_SCOPES } from "./ports.js";

const keys = adminProcedure.use(requireCapability("api.keys.manage"));
const logs = adminProcedure.use(requireCapability("api.logs.read"));
const replay = adminProcedure.use(requireCapability("api.replay")).meta({ rateLimit: "expensive" });
const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const cursor = z.string().regex(/^\d{1,15}$/u).nullish();
const version = z.number().int().min(0);
const api = (services: Services) => services.publicApi;

const keyInput = z.strictObject({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
  expiresAt: z.coerce.date().nullable(),
  ipAllowList: z.array(z.string().min(1).max(64)).max(50),
  rateLimitPerMinute: z.number().int().min(1).max(6000),
  requireSigning: z.boolean(),
});

export const publicApiRouter = router({
  admin: router({
    settings: router({
      get: keys.query(({ ctx }) => api(ctx.services).settings.get(ctx.session)),
      update: keys
        .input(z.strictObject({ expectedVersion: version, enabled: z.boolean(), retentionDays: z.number().int().min(1).max(90) }))
        .mutation(({ ctx, input }) => api(ctx.services).settings.update(ctx.session, input)),
    }),
    keys: router({
      list: keys
        .input(z.strictObject({ cursor, state: z.enum(["active", "revoked"]).optional() }).default({}))
        .query(({ ctx, input }) => api(ctx.services).keys.list(ctx.session, input)),
      get: keys.input(z.strictObject({ keyId: publicId })).query(({ ctx, input }) => api(ctx.services).keys.get(ctx.session, input.keyId)),
      create: keys.input(keyInput).mutation(({ ctx, input }) => api(ctx.services).keys.create(ctx.session, input)),
      update: keys
        .input(z.strictObject({ keyId: publicId, expectedVersion: version, key: keyInput }))
        .mutation(({ ctx, input }) => api(ctx.services).keys.update(ctx.session, input.keyId, input.expectedVersion, input.key)),
      rotate: keys
        .input(z.strictObject({ keyId: publicId, expectedVersion: version }))
        .mutation(({ ctx, input }) => api(ctx.services).keys.rotate(ctx.session, input.keyId, input.expectedVersion)),
      revoke: keys
        .input(z.strictObject({ keyId: publicId, expectedVersion: version }))
        .mutation(({ ctx, input }) => api(ctx.services).keys.revoke(ctx.session, input.keyId, input.expectedVersion)),
    }),
    log: router({
      list: logs
        .input(
          z
            .strictObject({
              cursor,
              limit: z.number().int().min(1).max(100).optional(),
              keyId: publicId.optional(),
              method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional(),
              status: z.number().int().min(100).max(599).optional(),
              statusClass: z.enum(["2xx", "3xx", "4xx", "5xx"]).optional(),
              pathPrefix: z.string().min(1).max(200).optional(),
              correlationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u).optional(),
              from: z.coerce.date().optional(),
              to: z.coerce.date().optional(),
              replay: z.boolean().optional(),
              search: z.string().min(1).max(100).optional(),
            })
            .default({}),
        )
        .query(({ ctx, input }) => api(ctx.services).log.list(ctx.session, input)),
      get: logs.input(z.strictObject({ requestId: publicId })).query(({ ctx, input }) => api(ctx.services).log.get(ctx.session, input.requestId)),
      replay: replay
        .input(z.strictObject({ requestId: publicId, confirmWrite: z.boolean().optional() }))
        .mutation(({ ctx, input }) => api(ctx.services).log.replay(ctx.session, input.requestId, { confirmWrite: input.confirmWrite })),
    }),
  }),
});
