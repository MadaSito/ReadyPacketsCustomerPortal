/**
 * Platform module — tRPC router (mounted at `trpc.platform.*`). Owner: platform module engineer.
 * Reads of administrative data require the admin role; every change requires `platform.settings.manage`
 * (which demands a fresh step-up). Secrets never leave the server: responses carry `configured` only.
 */
import { z } from "zod";
import { DomainError } from "../../core/errors.js";
import { SETTING_GROUPS } from "./settingsRegistry.js";
import { MAX_CONFIG_DOCUMENT_BYTES } from "./configTransfer.js";
import { adminProcedure, publicProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import type { PlatformModuleImpl } from "./module.js";
import type { Services } from "../../container.js";

const settingKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/).max(96);
const version = z.number().int().min(0).max(2_147_483_647);
const passphrase = z.string().min(1).max(1024).optional();
const documentText = z.string().min(2).max(MAX_CONFIG_DOCUMENT_BYTES);

function impl(services: Services): PlatformModuleImpl {
  const platform = services.platform as Partial<PlatformModuleImpl>;
  if (typeof platform.settingsAdmin !== "function") {
    throw new DomainError("NOT_CONFIGURED", "PLATFORM_UNAVAILABLE", "This feature is not available.");
  }
  return platform as PlatformModuleImpl;
}

const manage = adminProcedure.use(requireCapability("platform.settings.manage"));

export const platformRouter = router({
  setupStatus: publicProcedure.query(({ ctx }) => ctx.services.platform.setupStatus()),
  presentation: publicProcedure.query(({ ctx }) => ctx.services.platform.presentation()),

  admin: router({
    settings: router({
      list: adminProcedure
        .input(z.strictObject({ group: z.enum(SETTING_GROUPS).optional() }).optional())
        .query(async ({ ctx, input }) => {
          const views = await impl(ctx.services).settingsAdmin().describe({ group: input?.group, kinds: ["value", "secret"] });
          return views;
        }),
      update: manage
        .input(z.strictObject({ key: settingKey, value: z.json(), expectedVersion: version }))
        .mutation(({ ctx, input }) => {
          const platform = impl(ctx.services);
          return platform.updateSetting(input.key, input.value, input.expectedVersion, platform.actorGuard(ctx.session));
        }),
      setSecret: manage
        .input(z.strictObject({ key: settingKey, value: z.string().min(1).max(16384).nullable(), expectedVersion: version }))
        .mutation(async ({ ctx, input }) => {
          const platform = impl(ctx.services);
          const store = platform.settingsAdmin();
          await store.updateSecret(input.key, input.value, { expectedVersion: input.expectedVersion, guard: platform.actorGuard(ctx.session) });
          return store.describeOne(input.key);
        }),
    }),
    features: router({
      list: adminProcedure.query(({ ctx }) => impl(ctx.services).settingsAdmin().describe({ kinds: ["flag"] })),
      set: manage
        .input(z.strictObject({ key: settingKey.refine((k) => k.startsWith("feature."), "must be a feature flag"), enabled: z.boolean(), expectedVersion: version }))
        .mutation(async ({ ctx, input }) => {
          const platform = impl(ctx.services);
          const store = platform.settingsAdmin();
          await store.setFeature(input.key.slice("feature.".length), input.enabled, {
            expectedVersion: input.expectedVersion,
            guard: platform.actorGuard(ctx.session),
          });
          return store.describeOne(input.key);
        }),
    }),
    health: staffProcedure.use(requireCapability("platform.health.read")).query(({ ctx }) => ctx.services.platform.healthReport()),
    setupChecklist: adminProcedure.query(({ ctx }) => ctx.services.platform.setupChecklist()),
    presentation: router({
      get: adminProcedure.query(async ({ ctx }) => {
        const platform = impl(ctx.services);
        const views = await platform.settingsAdmin().describe({ group: "presentation" });
        return { settings: views, images: await platform.presentationService.listImages() };
      }),
      deleteImage: manage
        .input(z.strictObject({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }))
        .mutation(async ({ ctx, input }) => {
          const platform = impl(ctx.services);
          await platform.presentationService.deleteImage(input.id, platform.actorGuard(ctx.session));
          return { ok: true as const };
        }),
    }),
    config: router({
      export: manage
        .input(z.strictObject({ includeSecrets: z.boolean(), passphrase }))
        .meta({ rateLimit: "expensive" })
        .mutation(({ ctx, input }) => impl(ctx.services).configTransfer().exportDocument(input)),
      importPreview: manage
        .input(z.strictObject({ document: documentText, passphrase }))
        .meta({ rateLimit: "expensive" })
        .mutation(({ ctx, input }) => impl(ctx.services).configTransfer().preview(input.document, input.passphrase)),
      importApply: manage
        .input(z.strictObject({ document: documentText, passphrase, expectedPreviewDigest: z.string().regex(/^[0-9a-f]{64}$/) }))
        .meta({ rateLimit: "expensive" })
        .mutation(({ ctx, input }) => {
          const platform = impl(ctx.services);
          return platform.configTransfer().apply(input.document, input.expectedPreviewDigest, platform.actorGuard(ctx.session), input.passphrase);
        }),
    }),
  }),
});
