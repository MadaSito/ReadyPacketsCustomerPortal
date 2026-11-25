/**
 * Orders module — public service surface and factory. Owner: orders module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.orders` at call time.
 * See ./API.md for the contract (access policy, hooks, procedures, audit events).
 */
import type { ModuleDeps, Services } from "../../container.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import { createActorCheck } from "./actor.js";
import { createCatalogService, type CatalogService } from "./catalog.js";
import { registerOrderMailTemplates } from "./mail.js";
import "./automationTriggers.js";
import { createOrderService, type OrderChangeListener, type OrderService, type OrderSyncView } from "./orderService.js";
export type { OrderChangeEvent, OrderChangeKind, OrderChangeListener, OrderSyncView } from "./orderService.js";
import { createOrderPolicy } from "./policy.js";
import { createPortableHooks, type ImportReceipt, type PortableHooks } from "./portable.js";
import { createSharingService, type SharingService } from "./sharing.js";
import type {
  AccessibleOrderIds,
  AccessOptions,
  ImportOrderInput,
  OrderAccessView,
  OrderRef,
  OrderSearchHit,
  OrderSummary,
  OrderWriteKind,
  PortableOrder,
  PortableSelection,
  OrderProductionScope,
} from "./types.js";
import { createWorkflowService, type WorkflowService } from "./workflows.js";
import { createOrdersApiProvider } from "./publicApiProvider.js";
import { createAccessService, type AccessService } from "./access.js";
import { createRequirementsService, type FileUploadSlot, type FileUploadSlots, type RequirementsService } from "./requirements.js";
export type { FileUploadSlot, FileUploadSlots, RequirementsView } from "./requirements.js";
import { createGatesService, type OrderGatesService } from "./gates.js";
import { createAgreementGateService, type AgreementGateService } from "./agreementGate.js";
export type { AgreementRequirement } from "./gates.js";
export { AGREEMENT_GATE_KEY } from "./gates.js";
export type { AcceptanceGate, OrderGateAction, OrderGateContext, OrderGatePoint, OrderGateProvider, OrderGatesService } from "./gates.js";
import { createFolderRouting, type OrderFileFolderRouting } from "./folders.js";
export type { OrderFileFolderRouting } from "./folders.js";
import type { OrderPaymentSummaryProvider } from "./orderService.js";
export type { OrderPaymentState, OrderPaymentSummaryProvider } from "./orderService.js";
import { readSetting, writeSetting } from "../platform/index.js";
import { ORDER_AGREEMENT_GATE, ORDER_WORKFLOW_RULES_ENABLED, ORDER_WORKFLOW_TRANSFER_ENABLED, parseAgreementGate } from "./settings.js";
import { createWorkflowTransferService, type WorkflowTransferService } from "./workflowTransferService.js";
export type { TransferApplyInput, TransferApplyResult, TransferPreview, TransferSelection, TransferStatus } from "./workflowTransferService.js";
import { createOrderStatusCatalogService, type OrderStatusCatalogService } from "./statusCatalog.js";
export type { AttentionCountsView, OrderStatusCatalogService } from "./statusCatalog.js";
import { createStageRuntime } from "./stageRuntime.js";
import { createOrderPaymentsPort, createStagesService } from "./stages.js";
export type { StageWorkspace, StageViewState } from "./stages.js";
import { createPhaseWorkServices } from "./questionsRouter.js";
import { createStageStartup, STAGE_STARTUP_JOB } from "./stageStartup.js";
import { ulid } from "../../core/ids.js";
import { checkStageTargets } from "./stageTargets.js";

export type * from "./types.js";

export interface OrdersModule extends ModuleLifecycle {
  /* ---- access policy (contract §5.6) ---- */
  assertCanReadOrder(principal: SessionPrincipal, orderPublicId: string, options?: AccessOptions): Promise<OrderAccessView>;
  assertCanWriteOrder(principal: SessionPrincipal, orderPublicId: string, options: AccessOptions & { kind: OrderWriteKind }): Promise<OrderAccessView>;
  assertCanReadOrderById(principal: SessionPrincipal, orderId: number, options?: AccessOptions): Promise<OrderAccessView>;
  assertCanWriteOrderById(principal: SessionPrincipal, orderId: number, options: AccessOptions & { kind: OrderWriteKind }): Promise<OrderAccessView>;
  listAccessibleOrderIds(principal: SessionPrincipal, options?: { limit?: number; tx?: DbOrTx }): Promise<AccessibleOrderIds>;
  getOrderSummary(principal: SessionPrincipal, orderPublicId: string): Promise<OrderSummary>;
  /** Trusted lookup for jobs/collectors that already authorised. */
  /** `forUpdate` (requires tx) locks the order row — use it before acting on lockState (e.g. retention purge). */
  getOrderRefById(orderId: number, tx?: DbOrTx, options?: { forUpdate?: boolean }): Promise<OrderRef | null>;
  /** Increment 03 (storage copy automation): same as getOrderRefById, by public id; null when unknown. */
  getOrderRefByPublicId(orderPublicId: string, tx?: DbOrTx, options?: { forUpdate?: boolean }): Promise<OrderRef | null>;
  /** Trusted packet scope for P101/P201 (caller authorises first). Runs in the caller's tx when given; no locks. */
  getProductionScope(orderId: number, opts?: { tx?: DbOrTx }): Promise<OrderProductionScope | null>;
  searchOrders(principal: SessionPrincipal, query: string, limit?: number): Promise<OrderSearchHit[]>;

  /* ---- portable hooks ---- */
  portableOrders(tx: DbOrTx, selection: PortableSelection): Promise<{ items: PortableOrder[]; nextAfter: number | null }>;
  importOrder(input: ImportOrderInput, tx: Tx): Promise<ImportReceipt>;
  findImportedOrder: PortableHooks["findImportedOrder"];
  /** Write-free; unknown statuses are refused by importOrder (IMPORT_STATUS_UNSUPPORTED), never mapped. */
  isPortableStatusSupported: PortableHooks["isPortableStatusSupported"];
  /** Pure preflight (schema, currency, exact line math, summed total); importOrder re-runs it. */
  preflightImportOrder: PortableHooks["preflightImportOrder"];
  checkCatalogViability(items: { productPublicId?: string; name: string; currency: string }[]): Promise<{ matched: number; unmatched: number }>;

  /** Increment 03: in-transaction change hook (SharePoint order sync). Register at wiring time; a throw aborts the write. */
  registerChangeListener(listener: OrderChangeListener): void;
  /** Increment 03: trusted read for the order-data sync worker; null when the order does not exist. */
  getOrderSyncView(orderPublicId: string, tx?: DbOrTx): Promise<OrderSyncView | null>;
  /** Increment 03: trusted keyset listing (ascending publicId, limit ≤ 500) for the sync backfill; ids only. */
  listOrderPublicIdsForSync(input: { afterPublicId?: string | null; limit: number }, tx?: DbOrTx): Promise<{ publicIds: string[]; nextAfter: string | null }>;

  /** Increment 04 (Files port): writable upload slots of the current status for this actor. */
  getFileUploadSlots(principal: SessionPrincipal, orderPublicId: string, tx?: Tx): Promise<FileUploadSlots>;
  /** Increment 04 (Files port): throws PHASE_LOCKED / ORDER_LOCKED for writes tied to a read-only status. */
  assertFileStatusWritable(principal: SessionPrincipal, orderPublicId: string, statusKey: string, tx?: Tx): Promise<void>;
  /** Increment 04 (Files custody, trusted): slot definition from the pinned version; no actor filtering. */
  getFileSlotForCustody(orderPublicId: string, statusKey: string, slotKey: string, tx: Tx): Promise<FileUploadSlot | null>;
  /** Increment 04: is data tied to `statusKey` read-only because its phase is locked (trusted, in-tx). */
  isStatusPhaseLocked(orderId: number, workflowVersionId: number, statusKey: string, tx: Tx): Promise<boolean>;

  /** Increment 04 (cart checkout): customer order creation inside the caller's transaction. */
  createOrderFromCheckoutInTx: OrderService["createOrderFromCheckoutInTx"];

  /** Part B (B6): acceptance gate port — call `gates.assertCustomerMayWork` inside the protected write's tx. */
  gates: OrderGatesService;
  /** Part B (B7, trusted): storage folder templates from the pinned version; null for an unknown order. */
  getOrderFileFolderRouting(input: { orderPublicId: string; statusKey: string; slotKey: string | null }, tx: Tx): Promise<OrderFileFolderRouting | null>;
  /** Part B (S2, trusted — caller authorised first): status transitions newest first. */
  listStatusTransitions: OrderService["listStatusTransitions"];
  /** Part B (B2): renames for the Order history tab (trusted; caller authorizes; customerView hides staff ids). */
  listNameHistory: OrderService["listNameHistory"];
  /** Part B (B1): compliance registers the console payment badge source at init. */
  registerPaymentSummaryProvider(provider: OrderPaymentSummaryProvider): void;

  /* ---- services used by the router ---- */
  requirements: RequirementsService;
  access: AccessService;
  catalog: CatalogService;
  workflows: WorkflowService;
  /** Increment 05 (A1): workflow export / import (`orders.admin.workflows.transfer.*`). */
  workflowTransfer: WorkflowTransferService;
  /** Increment 06 (D14): order agreement (MNDA) setting administration and customer status. */
  agreementGate: AgreementGateService;
  /** Increment 07 (D2): admin-managed order status catalogue (`orders.statusCatalog.*`). */
  statusCatalog: OrderStatusCatalogService;
  /** Increment 07 (D1/D3/D8): `orders.stages.*` and the stage ports (resolveStageForUpload, listForOrder, ...). */
  stages: ReturnType<typeof createStagesService>;
  /** Increment 07 (D9): payment state writes (compliance calls these in its own tx). */
  payments: ReturnType<typeof createOrderPaymentsPort>;
  /** Increment 07 (D4/D5): phase questions and admin tasks (assurance). */
  phaseWork: ReturnType<typeof createPhaseWorkServices>;
  orders: OrderService;
  sharing: SharingService;
}

export function createOrdersModule(deps: ModuleDeps): OrdersModule {
  registerOrderMailTemplates(deps.mailer);
  const policy = createOrderPolicy({ db: deps.db, clock: deps.clock, audit: deps.audit });
  const actorCheck = createActorCheck(deps.services, deps.clock);
  const catalog = createCatalogService({ db: deps.db, clock: deps.clock, audit: deps.audit, settings: deps.settings, actorCheck });
  const workflows = createWorkflowService({
    db: deps.db,
    clock: deps.clock,
    audit: deps.audit,
    actorCheck,
    rulesEnabled: (tx) => readSetting(deps.settings, ORDER_WORKFLOW_RULES_ENABLED, tx),
    checkStageTargets: (stages, tx) => checkStageTargets(deps.services, stages, tx),
  });
  const gates = createGatesService({
    db: deps.db,
    policy,
    workflows,
    agreementGate: (tx) => deps.settings.get(ORDER_AGREEMENT_GATE.key, parseAgreementGate, parseAgreementGate(undefined), tx as Tx | undefined),
  });
  const requirements = createRequirementsService({ ...deps, policy, workflows, actorCheck, gates });
  const access = createAccessService({ ...deps, policy, actorCheck });
  let paymentProvider: OrderPaymentSummaryProvider | null = null;
  const stageRuntime = createStageRuntime({ db: deps.db, clock: deps.clock, services: deps.services, workflows });
  const orders = createOrderService({ ...deps, policy, catalog, workflows, requirements, access, gates, stageRuntime, paymentSummary: () => paymentProvider });
  const stages = createStagesService({
    db: deps.db,
    clock: deps.clock,
    audit: deps.audit,
    crypto: deps.crypto,
    logger: deps.logger,
    policy,
    actorCheck,
    workflows,
    requirements,
    gates,
    orders,
    runtime: stageRuntime,
  });
  const payments = createOrderPaymentsPort({ clock: deps.clock, audit: deps.audit, logger: deps.logger, workflows, orders, runtime: stageRuntime });
  const phaseWork = createPhaseWorkServices({
    db: deps.db,
    audit: deps.audit,
    clock: deps.clock,
    crypto: deps.crypto,
    policy,
    actorCheck,
    gates,
    resolveStage: stages.resolveQuestionStage,
    refreshAttentionInTx: stages.refreshAttentionInTx,
  });
  const stageStartup = createStageStartup({ db: deps.db, clock: deps.clock, audit: deps.audit, logger: deps.logger, paymentSummary: () => paymentProvider, recalcStoredProgress: stageRuntime.recalcStored });
  deps.jobs.register(STAGE_STARTUP_JOB, async (job) => {
    await job.assertStillOwned();
    return stageStartup.job();
  });
  deps.jobs.registerSchedule({ name: STAGE_STARTUP_JOB, type: STAGE_STARTUP_JOB, everyMs: 10 * 60_000 });
  const getOrderFileFolderRouting = createFolderRouting({ workflows });
  const sharing = createSharingService({ ...deps, policy });
  const portable = createPortableHooks({ ...deps, workflows });

  const workflowTransfer = createWorkflowTransferService({
    db: deps.db,
    clock: deps.clock,
    audit: deps.audit,
    services: deps.services,
    actorCheck,
    enabled: (tx) => readSetting(deps.settings, ORDER_WORKFLOW_TRANSFER_ENABLED, tx),
    writeEnabled: (value, tx) => writeSetting(deps.settings, ORDER_WORKFLOW_TRANSFER_ENABLED, value, tx),
    rulesEnabled: (tx) => readSetting(deps.settings, ORDER_WORKFLOW_RULES_ENABLED, tx),
    release: deps.config.releaseRef,
    installationLabel: deps.config.installationId,
  });

  const agreementGate = createAgreementGateService({ db: deps.db, audit: deps.audit, settings: deps.settings, services: deps.services, actorCheck, gates });
  const statusCatalog = createOrderStatusCatalogService({ db: deps.db, clock: deps.clock, audit: deps.audit, actorCheck });

  const apiProvider = createOrdersApiProvider({ db: deps.db, services: deps.services, workflows, catalog, orders });

  return {
    init() {
      // Increment 04 (package H): /api/v1 orders provider. Absent public API module ⇒ nothing to register.
      const publicApi = (deps.services as Partial<Services>).publicApi as unknown as { registerProvider?: (key: "orders", provider: unknown) => void } | undefined;
      publicApi?.registerProvider?.("orders", apiProvider);
      // Lead QA: run the increment-07 start-up work once right after boot as well (the 10-minute schedule stays), so an
      // upgraded install shows recalculated progress immediately. Per-boot idempotency key; the job itself is idempotent.
      void deps.jobs
        .enqueue(STAGE_STARTUP_JOB, {}, { idempotencyKey: `${STAGE_STARTUP_JOB}:boot:${ulid(deps.clock.now().getTime())}` })
        .catch((err: unknown) => {
          deps.logger.warn("orders increment 07 start-up enqueue deferred", { errorName: err instanceof Error ? err.name : "unknown" });
        });
      void statusCatalog.ensureSeeded().catch((err: unknown) => {
        deps.logger.warn("orders status catalogue startup seed deferred", {
          errorName: err instanceof Error ? err.name : "unknown",
        });
      });
    },
    assertCanReadOrder: policy.assertCanReadOrder,
    assertCanWriteOrder: policy.assertCanWriteOrder,
    assertCanReadOrderById: policy.assertCanReadOrderById,
    assertCanWriteOrderById: policy.assertCanWriteOrderById,
    listAccessibleOrderIds: policy.listAccessibleOrderIds,
    getOrderSummary: orders.getOrderSummary,
    getOrderRefById: orders.getOrderRefById,
    getOrderRefByPublicId: orders.getOrderRefByPublicId,
    getProductionScope: orders.getProductionScope,
    registerChangeListener: orders.registerChangeListener,
    getOrderSyncView: orders.getOrderSyncView,
    listOrderPublicIdsForSync: orders.listOrderPublicIdsForSync,
    searchOrders: orders.searchOrders,
    portableOrders: portable.portableOrders,
    importOrder: portable.importOrder,
    findImportedOrder: portable.findImportedOrder,
    isPortableStatusSupported: portable.isPortableStatusSupported,
    preflightImportOrder: portable.preflightImportOrder,
    checkCatalogViability: catalog.checkViability,
    getFileUploadSlots: requirements.getFileUploadSlots,
    assertFileStatusWritable: requirements.assertFileStatusWritable,
    isStatusPhaseLocked: requirements.isStatusPhaseLocked,
    getFileSlotForCustody: requirements.getFileSlotForCustody,
    createOrderFromCheckoutInTx: orders.createOrderFromCheckoutInTx,
    gates,
    getOrderFileFolderRouting,
    listStatusTransitions: orders.listStatusTransitions,
    listNameHistory: orders.listNameHistory,
    registerPaymentSummaryProvider(provider) {
      if (typeof provider !== "function") throw new Error("invalid payment summary provider");
      paymentProvider = provider;
    },
    requirements,
    access,
    catalog,
    workflows,
    workflowTransfer,
    agreementGate,
    statusCatalog,
    stages,
    payments,
    phaseWork,
    orders,
    sharing,
    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const empty = await catalog.isEmpty();
        const workflow = await workflows.currentDefault(deps.db);
        return [
          {
            component: "orders.catalog",
            state: empty ? "not_configured" : "ok",
            summary: empty ? "No active catalog products have been configured." : "Catalog has active products.",
            checkedAt,
          },
          {
            component: "orders.workflow",
            state: "ok",
            summary: workflow ? "A default workflow is configured." : "The standard workflow will be installed with the first order.",
            checkedAt,
          },
        ];
      } catch {
        return [{ component: "orders.catalog", state: "failing", summary: "Order data could not be read.", checkedAt }];
      }
    },
  };
}
