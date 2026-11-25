/**
 * Orders module — tRPC router (mounted at `trpc.orders.*`). Owner: orders module engineer.
 * Routers validate + guard + delegate; resource scope lives in the services (policy.ts).
 */
import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { adminProcedure, protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { GRANT_ROLES, NOTE_VISIBILITIES, ORDER_LOCK_STATES, PACKET_TIERS, WORKFLOW_DRAFT_SOURCES } from "./schema.js";
import { AGREEMENT_SIGNATURE_MODES, bundleRuleSchema } from "./settings.js";
// ── increment 07 router imports (other owners: one import line each, below this anchor; orders_engineer owns the file) ──
import { adminTasksRouter, questionsRouter } from "./questionsRouter.js";
import { statusCatalogRouter } from "./statusCatalogRouter.js";
import { ORDER_ATTENTION, STAGE_REVIEW_OUTCOMES } from "./schema.js";
import { stageKeySchema } from "../../../shared/workflowStages.js";
// ── end increment 07 router imports ──

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

/* ---- increment 05 (A1): workflow export / import. Bodies travel in POST (http caps these two paths). ---- */
const transferPackageText = z.string().min(1).max(2_097_152);
const workflowTransfer = router({
  /** Increment 06 (D10): the on-page switch (audited). */
  setEnabled: adminProcedure
    .use(requireCapability("workflows.manage"))
    .input(z.strictObject({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.services.orders.workflowTransfer.setEnabled(ctx.session, input)),
  status: adminProcedure.use(requireCapability("workflows.manage")).query(({ ctx }) => ctx.services.orders.workflowTransfer.status(ctx.session)),
  export: adminProcedure
    .use(requireCapability("workflows.export"))
    .input(z.strictObject({ selection: z.union([z.strictObject({ all: z.literal(true) }), z.strictObject({ workflowKeys: z.array(statusKey).min(1).max(50) })]) }))
    .mutation(({ ctx, input }) => ctx.services.orders.workflowTransfer.exportPackage(ctx.session, input)),
  preview: adminProcedure
    .use(requireCapability("workflows.import"))
    .meta({ rateLimit: "form_submission" })
    .input(z.strictObject({ packageText: transferPackageText }))
    .mutation(({ ctx, input }) => ctx.services.orders.workflowTransfer.preview(ctx.session, input)),
  // `apply` is a reserved word in tRPC routers.
  applyImport: adminProcedure
    .use(requireCapability("workflows.import"))
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        packageText: transferPackageText,
        idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
        decisions: z.array(z.strictObject({ key: z.string().max(48), action: z.enum(["create", "draft", "skip"]) })).max(50),
        policyMappings: z
          .array(
            z
              .strictObject({ ref: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), localPolicyPublicId: id.optional(), removeGates: z.literal(true).optional() })
              .refine((mapping) => (mapping.localPolicyPublicId === undefined) !== (mapping.removeGates === undefined), { message: "Map to a policy or remove the gates." }),
          )
          .max(100),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.orders.workflowTransfer.applyImport(ctx.session, input)),
});

/* ---- increment 06 (D14): order agreement (MNDA) — the compliance admin card calls these. ---- */
const agreementSettingInput = z.strictObject({
  enabled: z.boolean(),
  policyPublicId: id.nullable(),
  applyTo: z.strictObject({ placeOrder: z.boolean(), workOnOrder: z.boolean() }),
  signatureMode: z.enum(AGREEMENT_SIGNATURE_MODES),
  askAgainOnNewVersion: z.boolean(),
});
const agreementGateAdmin = router({
  get: adminProcedure.use(requireCapability("policies.manage")).query(({ ctx }) => ctx.services.orders.agreementGate.get(ctx.session)),
  update: adminProcedure
    .use(requireCapability("policies.manage"))
    .input(z.strictObject({ setting: agreementSettingInput, expectedEnabled: z.boolean().optional() }))
    .mutation(({ ctx, input }) => ctx.services.orders.agreementGate.update(ctx.session, input)),
});

const workflowsAdmin = router({
  transfer: workflowTransfer,
  list: adminProcedure.use(requireCapability("workflows.manage")).query(({ ctx }) => ctx.services.orders.workflows.list()),
  // Increment 03: the direct create/publish procedures are no longer mounted. Every new version goes through a draft
  // (drafts.publish), which requires a fresh step-up and passes the designer's validation.

  /* ---- increment 03: designer (drafts edited by the wizard and the canvas) ---- */
  installStandard: adminProcedure
    .use(requireCapability("workflows.manage"))
    .mutation(({ ctx }) => ctx.services.orders.workflows.installStandard(ctx.session)),
  versions: adminProcedure
    .use(requireCapability("workflows.manage"))
    .input(z.strictObject({ workflowId: id }))
    .query(({ ctx, input }) => ctx.services.orders.workflows.listVersions(input.workflowId)),
  version: adminProcedure
    .use(requireCapability("workflows.manage"))
    .input(z.strictObject({ versionId: id }))
    .query(({ ctx, input }) => ctx.services.orders.workflows.getVersion(input.versionId)),
  /** Increment 07 QA: the phases notice on /admin/workflows (drafts only; never publishes or edits a workflow). */
  phases: router({
    addStandard: adminProcedure
      .use(requireCapability("workflows.manage"))
      .mutation(({ ctx }) => ctx.services.orders.workflows.addPhasesWorkflow(ctx.session)),
    convertDefault: adminProcedure
      .use(requireCapability("workflows.manage"))
      .mutation(({ ctx }) => ctx.services.orders.workflows.convertDefaultToPhases(ctx.session)),
  }),
  drafts: router({
    list: adminProcedure.use(requireCapability("workflows.manage")).query(({ ctx }) => ctx.services.orders.workflows.listDrafts()),
    get: adminProcedure
      .use(requireCapability("workflows.manage"))
      .input(z.strictObject({ draftId: id }))
      .query(({ ctx, input }) => ctx.services.orders.workflows.getDraft(input.draftId)),
    create: adminProcedure
      .use(requireCapability("workflows.manage"))
      .input(
        z.strictObject({
          // Increment 07 QA: "phases" = the ReadyPackets phases workflow (stored with source "standard").
          from: z.enum([...WORKFLOW_DRAFT_SOURCES, "phases"]),
          copyVersionId: id.optional(),
          workflowId: id.optional(),
          workflowKey: statusKey.optional(),
          name: nfc(1, 120).optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.orders.workflows.createDraft(ctx.session, input)),
    save: adminProcedure
      .use(requireCapability("workflows.manage"))
      .input(z.strictObject({ draftId: id, expectedVersion: version, name: nfc(1, 120), definition: z.unknown(), layout: z.unknown().optional() }))
      .mutation(({ ctx, input }) => ctx.services.orders.workflows.saveDraft(ctx.session, input)),
    validate: adminProcedure
      .use(requireCapability("workflows.manage"))
      .input(z.strictObject({ definition: z.unknown() }))
      // A mutation only so the body travels in POST (no writes, no audit).
      .mutation(({ ctx, input }) => ctx.services.orders.workflows.validate(input.definition)),
    discard: adminProcedure
      .use(requireCapability("workflows.manage"))
      .input(z.strictObject({ draftId: id, expectedVersion: version }))
      .mutation(({ ctx, input }) => ctx.services.orders.workflows.discardDraft(ctx.session, input)),
    publish: adminProcedure
      .use(requireCapability("workflows.manage"))
      .input(z.strictObject({ draftId: id, expectedVersion: version, makeDefault: z.boolean(), changeNote: nfc(0, 500).optional() }))
      .mutation(({ ctx, input }) => ctx.services.orders.workflows.publishDraft(ctx.session, input)),
  }),
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

/** Increment 05: raw code text; promotions normalises it. Bounded and printable only; never logged. */
const promoCode = z.string().trim().min(1).max(64).regex(/^[\x21-\x7E ]+$/);

/** Increment 07 (D1/D3): the phase runtime. Owner-only next/submit are enforced server-side (stages.ts). */
const stageRef = { orderId: id, stageKey: stageKeySchema, expectedVersion: version };
const stagesRouter = router({
  workspace: protectedProcedure.input(z.strictObject({ orderId: id })).query(({ ctx, input }) => ctx.services.orders.stages.workspace(ctx.session, input)),
  next: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(z.strictObject(stageRef))
    .mutation(({ ctx, input }) => ctx.services.orders.stages.next(ctx.session, input)),
  submit: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(z.strictObject({ ...stageRef, ack: z.strictObject({ accepted: z.literal(true), textSha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }))
    .mutation(({ ctx, input }) => ctx.services.orders.stages.submit(ctx.session, input)),
  review: staffProcedure
    .use(requireCapability("orders.stage.review"))
    .input(z.strictObject({ ...stageRef, outcome: z.enum(STAGE_REVIEW_OUTCOMES), note: nfc(1, 2000).optional() }))
    .mutation(({ ctx, input }) => ctx.services.orders.stages.review(ctx.session, input)),
  reopen: adminProcedure
    .use(requireCapability("orders.stage.reopen"))
    .input(z.strictObject({ ...stageRef, reason: nfc(10, 500), confirm: z.literal(true) }))
    .mutation(({ ctx, input }) => ctx.services.orders.stages.reopen(ctx.session, input)),
});

export const ordersRouter = router({
  catalog: router({
    list: protectedProcedure.query(({ ctx }) => ctx.services.orders.catalog.listActive()),
  }),
  /** Server price of a selection (packet rules + bundle discount); same validation as create, writes nothing. */
  quote: protectedProcedure
    .input(z.strictObject({ items: orderItems, forCustomerPublicId: id.optional() }))
    .query(({ ctx, input }) => ctx.services.orders.orders.quote(ctx.session, input)),
  /** Increment 05 (C3): quote with a discount code. A mutation so the code travels in the POST body, never a URL. */
  quoteWithPromo: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(z.strictObject({ items: orderItems, promoCode, forCustomerPublicId: id.optional() }))
    .mutation(({ ctx, input }) => ctx.services.orders.orders.quote(ctx.session, input)),
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
        promoCode: promoCode.optional(),
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
  /** Part B (S1): console order workspace actions. */
  console: router({
    rename: staffProcedure
      .use(requireCapability("orders.rename"))
      .input(z.strictObject({ orderId: id, expectedVersion: version, name: z.string().max(400) }))
      .mutation(({ ctx, input }) => ctx.services.orders.orders.rename(ctx.session, input)),
  }),
  /** Increment 06 (D14): the signed-in user's own agreement state (display only; writes re-check). */
  agreement: router({
    status: protectedProcedure
      .input(z.strictObject({ scope: z.enum(["placeOrder", "workOnOrder"]) }))
      .query(({ ctx, input }) => ctx.services.orders.agreementGate.status(ctx.session, input)),
  }),
  admin: router({
    agreementGate: agreementGateAdmin,
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
          /** Increment 07 (D2): attention filter. */
          attention: z.enum(ORDER_ATTENTION).exclude(["none"]).optional(),
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
          promoCode: promoCode.optional(),
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
    customerLookup: staffProcedure
      .use(requireCapability("customers.read_all"))
      .input(z.strictObject({ query: nfc(2, 120) }))
      .query(({ ctx, input }) => ctx.services.orders.access.customerLookup(ctx.session, input)),
    access: router({
      list: staffProcedure
        .use(requireCapability("orders.read_all"))
        .input(z.union([z.strictObject({ orderId: id }), z.strictObject({ customerPublicId: id })]))
        .query(({ ctx, input }) => ctx.services.orders.access.list(ctx.session, input)),
      grant: adminProcedure
        .use(requireCapability("orders.access.grant"))
        .input(
          z.strictObject({
            scope: z.union([z.strictObject({ orderId: id }), z.strictObject({ customerPublicId: id })]),
            email: z.string().trim().min(3).max(254).email(),
            role: z.enum(GRANT_ROLES),
          }),
        )
        .mutation(({ ctx, input }) => ctx.services.orders.access.grant(ctx.session, input)),
      revoke: adminProcedure
        .use(requireCapability("orders.access.grant"))
        .input(z.strictObject({ grantId: id }))
        .mutation(({ ctx, input }) => ctx.services.orders.access.revoke(ctx.session, input)),
    }),
  }),
  requirements: router({
    forOrder: protectedProcedure.input(z.strictObject({ orderId: id })).query(({ ctx, input }) => ctx.services.orders.requirements.forOrder(ctx.session, input)),
    acknowledge: protectedProcedure
      .input(
        z.strictObject({
          orderId: id,
          statusKey,
          ackKey: statusKey,
          textSha256: z.string().regex(/^[a-f0-9]{64}$/),
          typedName: nfc(0, 120).optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.orders.requirements.acknowledge(ctx.session, input)),
    /** Increment 06 (D8): staff write the per-order note of an `order_note` acknowledgement task. */
    setTaskNote: staffProcedure
      .use(requireCapability("orders.manage"))
      .input(z.strictObject({ orderId: id, statusKey, ackKey: statusKey, body: z.string().min(1).max(4000), expectedVersion: version.optional() }))
      .mutation(({ ctx, input }) => ctx.services.orders.requirements.setTaskNote(ctx.session, input)),
    /** Increment 06 (D8): staff waive one customer task with a reason (audited). */
    waive: staffProcedure
      .use(requireCapability("orders.phase.unlock"))
      .input(z.strictObject({ orderId: id, statusKey, taskKey: statusKey, reason: nfc(10, 500) }))
      .mutation(({ ctx, input }) => ctx.services.orders.requirements.waiveTask(ctx.session, input)),
  }),
  phases: router({
    unlock: staffProcedure
      .use(requireCapability("orders.phase.unlock"))
      .input(z.strictObject({ orderId: id, phaseKey: statusKey, reason: nfc(10, 500), notifyCustomer: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.services.orders.requirements.unlockPhase(ctx.session, input)),
  }),
  // ── increment 07 mounts (other owners: one line each, below this anchor, e.g. `questions: questionsRouter,`) ──
  questions: questionsRouter, adminTasks: adminTasksRouter,
  statusCatalog: statusCatalogRouter,
  stages: stagesRouter,
  // ── end increment 07 mounts ──
});
