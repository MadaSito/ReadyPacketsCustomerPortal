/**
 * Platform module — tRPC router (mounted at `trpc.platform.*`). Owner: platform module engineer.
 * Reads of administrative data require the admin role; every change requires `platform.settings.manage`
 * (which demands a fresh step-up). Secrets never leave the server: responses carry `configured` only.
 */
import { z } from "zod";
import { DomainError } from "../../core/errors.js";
import { SETTING_GROUPS, getSettingDefinition, listSettingDefinitions } from "./settingsRegistry.js";
import type { Capability } from "../../../shared/capabilities.js";
import type { ActorGuard } from "./actorGuard.js";
import type { SessionPrincipal } from "../../core/types.js";
import { MAX_CONFIG_DOCUMENT_BYTES } from "./configTransfer.js";
import { adminProcedure, protectedProcedure, publicProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { recordInputSchema, searchInputSchema } from "./consent.js";
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

/**
 * Guard for generic writes: platform.settings.manage plus every `writeCapability` declared by the affected
 * settings (e.g. mail.manage), each re-validated in-transaction with its own step-up rule.
 * `keys === "all"` covers configuration import, which may touch any exportable setting.
 */
function settingWriteGuard(platform: PlatformModuleImpl, principal: SessionPrincipal, keys: readonly string[] | "all"): ActorGuard {
  const defs = keys === "all" ? listSettingDefinitions() : keys.map((key) => getSettingDefinition(key));
  const extra = new Set<Capability>();
  for (const def of defs) if (def && def.kind !== "flag" && def.writeCapability) extra.add(def.writeCapability);
  const guards = [platform.actorGuard(principal), ...[...extra].sort().map((cap) => platform.actorGuard(principal, cap))];
  return async (tx) => {
    for (const guard of guards) await guard(tx);
  };
}

const manage = adminProcedure.use(requireCapability("platform.settings.manage"));
const consentRead = adminProcedure.use(requireCapability("privacy.consent.read"));

export const platformRouter = router({
  setupStatus: publicProcedure.query(({ ctx }) => ctx.services.platform.setupStatus()),
  presentation: publicProcedure.query(({ ctx }) => ctx.services.platform.presentation()),
  /** Public: clientVisible flag states + consent configuration (increment 04, package J). */
  bootstrap: publicProcedure.query(({ ctx }) => impl(ctx.services).consent.bootstrap()),
  consent: router({
    inventory: publicProcedure.query(({ ctx }) => impl(ctx.services).consent.inventory()),
    record: publicProcedure
      .meta({ rateLimit: "form_submission" })
      .input(recordInputSchema)
      .mutation(({ ctx, input }) => {
        const full = ctx.session && ctx.session.state === "full" ? ctx.session : null;
        return impl(ctx.services).consent.record(input, { userPublicId: full?.userPublicId ?? null, ipAddress: ctx.request.ipAddress ?? null });
      }),
    mine: protectedProcedure.query(({ ctx }) => impl(ctx.services).consent.mine(ctx.session.userPublicId)),
  }),

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
          return platform.updateSetting(input.key, input.value, input.expectedVersion, settingWriteGuard(platform, ctx.session, [input.key]));
        }),
      setSecret: manage
        .input(z.strictObject({ key: settingKey, value: z.string().min(1).max(16384).nullable(), expectedVersion: version }))
        .mutation(async ({ ctx, input }) => {
          const platform = impl(ctx.services);
          const store = platform.settingsAdmin();
          await store.updateSecret(input.key, input.value, { expectedVersion: input.expectedVersion, guard: settingWriteGuard(platform, ctx.session, [input.key]) });
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
    consent: router({
      stats: consentRead.input(z.strictObject({ days: z.number().int().min(1).max(400).default(30) })).query(({ ctx, input }) => impl(ctx.services).consent.stats(input.days)),
      search: consentRead.input(searchInputSchema).query(({ ctx, input }) => impl(ctx.services).consent.search(input)),
      export: consentRead
        .meta({ rateLimit: "expensive" })
        .input(searchInputSchema.omit({ cursor: true, limit: true }))
        .mutation(({ ctx, input }) => impl(ctx.services).consent.exportCsv(input)),
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
        .mutation(({ ctx, input }) => {
          const platform = impl(ctx.services);
          return platform.configTransfer().exportDocument(input, platform.actorGuard(ctx.session));
        }),
      importPreview: manage
        .input(z.strictObject({ document: documentText, passphrase }))
        .meta({ rateLimit: "expensive" })
        .mutation(({ ctx, input }) => impl(ctx.services).configTransfer().preview(input.document, input.passphrase)),
      importApply: manage
        .input(z.strictObject({ document: documentText, passphrase, expectedPreviewDigest: z.string().regex(/^[0-9a-f]{64}$/) }))
        .meta({ rateLimit: "expensive" })
        .mutation(({ ctx, input }) => {
          const platform = impl(ctx.services);
          return platform.configTransfer().apply(input.document, input.expectedPreviewDigest, settingWriteGuard(platform, ctx.session, "all"), input.passphrase);
        }),
    }),
  }),
});
