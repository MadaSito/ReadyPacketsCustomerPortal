/**
 * Integrations module — tRPC router (mounted at `trpc.integrations.*`). Owner: integrations module engineer.
 */
import { z } from "zod";
import { adminProcedure, publicProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { EGRESS_PRESET_KEYS, EGRESS_PROTOCOLS, EGRESS_PURPOSES } from "./egress.js";
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_DIRECTIONS, WEBHOOK_SUBSCRIPTION_STATUSES } from "./webhooks/index.js";

const manageProcedure = adminProcedure.use(requireCapability("integrations.manage"));
const webhooksManageProcedure = adminProcedure.use(requireCapability("webhooks.manage"));
const apiReplayProcedure = adminProcedure.use(requireCapability("api.replay"));
const productionTriggerProcedure = staffProcedure.use(requireCapability("orders.production.trigger"));
const productionResendProcedure = adminProcedure.use(requireCapability("orders.production.trigger"));
const productionRedeliverProcedure = staffProcedure.use(requireCapability("orders.production.redeliver"));

const ulidParamSchema = z.string().trim().min(10).max(64);

const updateSmtpInputSchema = z.strictObject({
  enabled: z.boolean(),
  host: z.string().trim().max(253),
  port: z.number().int().min(1).max(65535),
  tlsMode: z.enum(["starttls", "implicit"]),
  username: z.string().trim().max(254),
  password: z.string().max(1024).nullable().optional(),
  fromAddress: z.string().trim().max(254).optional(),
  fromName: z.string().trim().max(120).optional(),
  replyToAddress: z.string().trim().max(254).optional(),
});

const sendTestSmtpSchema = z
  .strictObject({
    toAddress: z.string().trim().min(3).max(254).optional(),
  })
  .default({});

const updateGraphInputSchema = z.strictObject({
  enabled: z.boolean(),
  tenantId: z.string().trim().max(64),
  clientId: z.string().trim().max(64),
  clientSecret: z.string().max(1024).nullable().optional(),
  senderMailbox: z.string().trim().max(254).optional(),
  enableEgressPreset: z.boolean().optional(),
});

const emptyOrOptionalObjectSchema = z.strictObject({}).default({});

const sendTestGraphSchema = z
  .strictObject({
    toAddress: z.string().trim().min(3).max(254).optional(),
  })
  .default({});

const updateAnalyticsInputSchema = z.strictObject({
  clarityEnabled: z.boolean(),
  clarityProjectId: z.string().trim().max(64),
  posthogEnabled: z.boolean(),
  posthogProjectKey: z.string().trim().max(200),
  posthogHost: z.string().trim().max(253),
  allowedSelfHostedOrigins: z.array(z.string().trim().max(253)).max(8).optional(),
});

const updateStripeInputSchema = z.strictObject({
  enabled: z.boolean(),
  publishableKey: z.string().trim().max(200),
  webhookToleranceSeconds: z.number().int().min(30).max(900).optional(),
  secretKey: z.string().max(256).nullable().optional(),
  webhookSecret: z.string().max(256).nullable().optional(),
});

const updateSamlInputSchema = z.strictObject({
  idpEntityId: z.string().trim().max(255),
  idpSsoUrl: z.string().trim().max(500),
  spEntityId: z.string().trim().max(255),
  nameIdFormat: z.enum([
    "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  ]),
  enabled: z.boolean().optional(),
});

const createEgressRuleSchema = z.strictObject({
  purpose: z.enum(EGRESS_PURPOSES),
  matchType: z.enum(["host", "ip", "cidr"]),
  pattern: z.string().trim().min(2).max(255),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(EGRESS_PROTOCOLS),
  allowPrivateAddress: z.boolean(),
  enabled: z.boolean().optional(),
  justification: z.string().trim().min(8).max(280),
});

const updateEgressRuleSchema = z.strictObject({
  publicId: ulidParamSchema,
  expectedVersion: z.number().int().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  allowPrivateAddress: z.boolean().optional(),
  enabled: z.boolean().optional(),
  justification: z.string().trim().min(8).max(280).optional(),
});

const deleteEgressRuleSchema = z.strictObject({
  publicId: ulidParamSchema,
});

const checkEgressTargetSchema = z.strictObject({
  target: z.string().trim().min(3).max(2048),
  purpose: z.enum(EGRESS_PURPOSES),
});

const setEgressPresetSchema = z.strictObject({
  presetKey: z.enum(EGRESS_PRESET_KEYS),
  enabled: z.boolean(),
  params: z
    .strictObject({
      region: z.string().trim().max(48).optional(),
      bucket: z.string().trim().max(64).optional(),
      accountName: z.string().trim().max(32).optional(),
    })
    .optional(),
});

const productionPhaseSchema = z.enum(["P101", "P201", "P301", "P401"]);
const productionDispatchStateSchema = z.enum(["queued", "sending", "delivered", "failed", "dead", "unknown"]);

const updateProductionSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  p101Url: z.string().trim().max(2048).nullable().optional(),
  p201Url: z.string().trim().max(2048).nullable().optional(),
  p301Url: z.string().trim().max(2048).nullable().optional(),
  p401Url: z.string().trim().max(2048).nullable().optional(),
  authHeaderName: z.string().trim().max(64).optional(),
  authHeaderValue: z.string().max(1024).nullable().optional(),
  canonVersion: z.string().trim().max(64),
  runMode: z.string().trim().max(32).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
});

const testProductionDestinationSchema = z.strictObject({
  phase: productionPhaseSchema,
});

const previewProductionOrderSchema = z.strictObject({
  orderPublicId: ulidParamSchema,
  releaseStatus: z.string().trim().max(120).optional(),
});

const requestP101Schema = z.strictObject({
  orderPublicId: ulidParamSchema,
  releaseStatus: z.string().trim().max(120).optional(),
});

const requestP201Schema = z.strictObject({
  orderPublicId: ulidParamSchema,
  phase1ArtifactsConfirmed: z.boolean(),
});

const requestLaterPhaseSchema = z.strictObject({
  orderPublicId: ulidParamSchema,
});

const retryProductionDispatchSchema = z.strictObject({
  orderPublicId: ulidParamSchema,
  dispatchPublicId: ulidParamSchema,
});

const redeliverProductionDispatchSchema = z.strictObject({
  orderPublicId: ulidParamSchema,
  dispatchPublicId: ulidParamSchema,
  reason: z.string().max(500),
  confirmation: z.string().max(64),
  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9:_-]+$/),
});

const resendProductionSchema = z.strictObject({
  orderPublicId: ulidParamSchema,
  phase: productionPhaseSchema,
  reason: z.string().trim().min(3).max(280),
  releaseStatus: z.string().trim().max(120).optional(),
  phase1ArtifactsConfirmed: z.boolean().optional(),
});

const productionOrderHistorySchema = z.strictObject({
  orderPublicId: ulidParamSchema,
});

const listProductionDispatchesSchema = z.strictObject({
  phase: productionPhaseSchema.optional(),
  state: productionDispatchStateSchema.optional(),
  orderReference: z.string().trim().max(64).optional(),
  fromDate: z.date().optional(),
  toDate: z.date().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const integrationsRouter = router({
  /** Public, minimal safe analytics configuration (`{ clarity: { enabled, projectId }, posthog: { enabled, key, host } }`). */
  publicAnalyticsConfig: publicProcedure.query(({ ctx }) => ctx.services.integrations.analytics.getPublicConfig()),

  admin: router({
    providers: adminProcedure.query(({ ctx }) => ctx.services.integrations.providers.listStatuses()),

    smtpReadiness: adminProcedure.query(({ ctx }) => ctx.services.integrations.smtp.getReadiness()),

    smtp: router({
      get: adminProcedure.query(({ ctx }) => ctx.services.integrations.smtp.getConfig()),
      update: adminProcedure
        .input(updateSmtpInputSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.smtp.updateConfig(ctx.session, input)),
      sendTest: adminProcedure
        .meta({ rateLimit: "expensive" })
        .input(sendTestSmtpSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.smtp.sendTestMessage(ctx.session, input)),
    }),

    graphReadiness: adminProcedure.query(({ ctx }) => ctx.services.integrations.graphAdmin.getReadiness()),

    graph: router({
      get: adminProcedure.query(({ ctx }) => ctx.services.integrations.graphAdmin.getConfig()),
      update: adminProcedure
        .input(updateGraphInputSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.graphAdmin.updateConfig(ctx.session, input)),
      testConnection: adminProcedure
        .meta({ rateLimit: "expensive" })
        .input(emptyOrOptionalObjectSchema)
        .mutation(({ ctx }) => ctx.services.integrations.graphAdmin.testConnection(ctx.session)),
      sendTest: adminProcedure
        .meta({ rateLimit: "expensive" })
        .input(sendTestGraphSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.graphAdmin.sendTestMessage(ctx.session, input)),
    }),

    analytics: router({
      get: adminProcedure.query(({ ctx }) => ctx.services.integrations.analytics.getAdminConfig()),
      update: manageProcedure
        .input(updateAnalyticsInputSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.analytics.updateConfig(ctx.session, input)),
    }),

    stripe: router({
      get: adminProcedure.query(({ ctx }) => ctx.services.integrations.stripe.getConfig()),
      update: manageProcedure
        .input(updateStripeInputSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.stripe.updateConfig(ctx.session, input)),
    }),

    saml: router({
      get: adminProcedure.query(({ ctx }) => ctx.services.integrations.scaffolds.getSamlScaffold()),
      updateMetadata: manageProcedure
        .input(updateSamlInputSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.scaffolds.updateSamlMetadata(ctx.session, input)),
    }),

    sharepoint: router({
      get: adminProcedure.query(({ ctx }) => ctx.services.integrations.scaffolds.getSharePointScaffold()),
    }),

    egress: router({
      list: adminProcedure.query(({ ctx }) => ctx.services.integrations.egress.listAllowlist()),
      presets: adminProcedure.query(({ ctx }) => ctx.services.integrations.egress.listPresets()),
      setPreset: adminProcedure
        .input(setEgressPresetSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.egress.setPresetEnabled(ctx.session, input)),
      create: manageProcedure
        .input(createEgressRuleSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.egress.createAllowlistRule(ctx.session, input)),
      update: manageProcedure
        .input(updateEgressRuleSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.egress.updateAllowlistRule(ctx.session, input)),
      remove: manageProcedure
        .input(deleteEgressRuleSchema)
        .mutation(({ ctx, input }) =>
          ctx.services.integrations.egress.deleteAllowlistRule(ctx.session, input.publicId),
        ),
      check: manageProcedure
        .meta({ rateLimit: "expensive" })
        .input(checkEgressTargetSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.egress.checkTarget(ctx.session, input)),
    }),

    webhooks: router({
      settings: router({
        get: adminProcedure.query(({ ctx }) => ctx.services.integrations.webhooks.getSettings(ctx.session)),
        update: webhooksManageProcedure
          .input(
            z.strictObject({
              enabled: z.boolean().optional(),
              retentionDays: z.number().int().min(0).max(90).optional(),
              autoDisableThreshold: z.number().int().min(3).max(50).optional(),
              deliveryTimeoutMs: z.number().int().min(1_000).max(30_000).optional(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.updateSettings(ctx.session, input)),
      }),

      catalogue: adminProcedure.query(({ ctx }) => ctx.services.integrations.webhooks.listCatalogueEvents(ctx.session)),

      subscriptions: router({
        list: adminProcedure
          .input(
            z
              .strictObject({
                status: z.enum(WEBHOOK_SUBSCRIPTION_STATUSES).optional(),
                cursor: z.string().max(200).nullish(),
                limit: z.number().int().min(1).max(100).optional(),
              })
              .default({}),
          )
          .query(({ ctx, input }) =>
            ctx.services.integrations.webhooks.listSubscriptions(ctx.session, {
              status: input.status,
              cursor: input.cursor ?? undefined,
              limit: input.limit,
            }),
          ),
        get: adminProcedure
          .input(z.strictObject({ publicId: ulidParamSchema }))
          .query(({ ctx, input }) => ctx.services.integrations.webhooks.getSubscription(ctx.session, input.publicId)),
        create: webhooksManageProcedure
          .input(
            z.strictObject({
              name: z.string().trim().min(1).max(120),
              description: z.string().trim().max(280).nullable().optional(),
              targetUrl: z.string().trim().min(10).max(2048),
              events: z.array(z.string().trim().min(2).max(120)).min(1).max(200),
              paused: z.boolean().optional(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.createSubscription(ctx.session, input)),
        update: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
              name: z.string().trim().min(1).max(120).optional(),
              description: z.string().trim().max(280).nullable().optional(),
              targetUrl: z.string().trim().min(10).max(2048).optional(),
              events: z.array(z.string().trim().min(2).max(120)).min(1).max(200).optional(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.updateSubscription(ctx.session, input)),
        setPaused: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
              paused: z.boolean(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.setSubscriptionPaused(ctx.session, input)),
        rotateSecret: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
              overlapMinutes: z.number().int().min(0).max(1440).optional(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.rotateSubscriptionSecret(ctx.session, input)),
        testDelivery: webhooksManageProcedure
          .meta({ rateLimit: "expensive" })
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              eventKey: z.string().trim().min(2).max(120).optional(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.testSubscriptionDelivery(ctx.session, input)),
        remove: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.deleteSubscription(ctx.session, input)),
      }),

      inbound: router({
        list: adminProcedure
          .input(
            z
              .strictObject({
                enabled: z.boolean().optional(),
                cursor: z.string().max(200).nullish(),
                limit: z.number().int().min(1).max(100).optional(),
              })
              .default({}),
          )
          .query(({ ctx, input }) =>
            ctx.services.integrations.webhooks.listInboundEndpoints(ctx.session, {
              enabled: input.enabled,
              cursor: input.cursor ?? undefined,
              limit: input.limit,
            }),
          ),
        get: adminProcedure
          .input(z.strictObject({ publicId: ulidParamSchema }))
          .query(({ ctx, input }) =>
            ctx.services.integrations.webhooks.getInboundEndpoint(ctx.session, input.publicId),
          ),
        create: webhooksManageProcedure
          .input(
            z.strictObject({
              name: z.string().trim().min(1).max(120),
              endpointKey: z.string().trim().min(3).max(64),
              description: z.string().trim().max(280).nullable().optional(),
              enabled: z.boolean().optional(),
              toleranceSeconds: z.number().int().min(30).max(300).optional(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.createInboundEndpoint(ctx.session, input)),
        update: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
              name: z.string().trim().min(1).max(120).optional(),
              description: z.string().trim().max(280).nullable().optional(),
              toleranceSeconds: z.number().int().min(30).max(300).optional(),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.updateInboundEndpoint(ctx.session, input)),
        setEnabled: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
              enabled: z.boolean(),
            }),
          )
          .mutation(({ ctx, input }) =>
            ctx.services.integrations.webhooks.setInboundEndpointEnabled(ctx.session, input),
          ),
        rotateSecret: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
              overlapMinutes: z.number().int().min(0).max(1440).optional(),
            }),
          )
          .mutation(({ ctx, input }) =>
            ctx.services.integrations.webhooks.rotateInboundEndpointSecret(ctx.session, input),
          ),
        remove: webhooksManageProcedure
          .input(
            z.strictObject({
              publicId: ulidParamSchema,
              expectedVersion: z.number().int().min(1),
            }),
          )
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.deleteInboundEndpoint(ctx.session, input)),
      }),

      deliveries: router({
        list: adminProcedure
          .input(
            z
              .strictObject({
                direction: z.enum(WEBHOOK_DIRECTIONS).optional(),
                subscriptionPublicId: ulidParamSchema.optional(),
                inboundEndpointPublicId: ulidParamSchema.optional(),
                eventKey: z.string().trim().max(120).optional(),
                status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
                from: z.date().optional(),
                to: z.date().optional(),
                correlationId: z.string().trim().max(64).optional(),
                search: z.string().trim().max(120).optional(),
                cursor: z.string().max(200).nullish(),
                limit: z.number().int().min(1).max(100).optional(),
              })
              .default({}),
          )
          .query(({ ctx, input }) =>
            ctx.services.integrations.webhooks.listDeliveries(ctx.session, {
              ...input,
              cursor: input.cursor ?? undefined,
            }),
          ),
        get: adminProcedure
          .input(z.strictObject({ publicId: ulidParamSchema }))
          .query(({ ctx, input }) => ctx.services.integrations.webhooks.getDelivery(ctx.session, input.publicId)),
        redeliver: apiReplayProcedure
          .meta({ rateLimit: "expensive" })
          .input(z.strictObject({ publicId: ulidParamSchema }))
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.redeliver(ctx.session, input)),
        reprocessInbound: apiReplayProcedure
          .meta({ rateLimit: "expensive" })
          .input(z.strictObject({ publicId: ulidParamSchema }))
          .mutation(({ ctx, input }) => ctx.services.integrations.webhooks.reprocessInbound(ctx.session, input)),
      }),
    }),
  }),

  production: router({
    settings: router({
      get: adminProcedure.query(({ ctx }) => ctx.services.integrations.production.getSettings()),
      update: manageProcedure
        .input(updateProductionSettingsSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.updateSettings(ctx.session, input)),
      test: manageProcedure
        .meta({ rateLimit: "expensive" })
        .input(testProductionDestinationSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.testDestination(ctx.session, input)),
    }),

    order: router({
      preview: productionTriggerProcedure
        .input(previewProductionOrderSchema)
        .query(({ ctx, input }) => ctx.services.integrations.production.previewOrder(ctx.session, input)),
      requestP101: productionTriggerProcedure
        .input(requestP101Schema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.requestP101(ctx.session, input)),
      requestP201: productionTriggerProcedure
        .input(requestP201Schema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.requestP201(ctx.session, input)),
      requestP301: productionTriggerProcedure
        .input(requestLaterPhaseSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.requestP301(ctx.session, input)),
      requestP401: productionTriggerProcedure
        .input(requestLaterPhaseSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.requestP401(ctx.session, input)),
      retry: productionTriggerProcedure
        .input(retryProductionDispatchSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.retry(ctx.session, input)),
      redeliver: productionRedeliverProcedure
        .meta({ rateLimit: "expensive" })
        .input(redeliverProductionDispatchSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.redeliver(ctx.session, input)),
      resend: productionResendProcedure
        .input(resendProductionSchema)
        .mutation(({ ctx, input }) => ctx.services.integrations.production.resend(ctx.session, input)),
      history: productionTriggerProcedure
        .input(productionOrderHistorySchema)
        .query(({ ctx, input }) => ctx.services.integrations.production.orderHistory(ctx.session, input)),
    }),

    admin: router({
      listDispatches: adminProcedure
        .input(listProductionDispatchesSchema.optional())
        .query(({ ctx, input }) => ctx.services.integrations.production.listDispatches(ctx.session, input)),
    }),
  }),
});
