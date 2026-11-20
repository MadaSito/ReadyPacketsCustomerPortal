/**
 * Orders module — public service surface and factory. Owner: orders module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.orders` at call time.
 * See ./API.md for the contract (access policy, hooks, procedures, audit events).
 */
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, ModuleHealth, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import { createCatalogService, type CatalogService } from "./catalog.js";
import { registerOrderMailTemplates } from "./mail.js";
import { createOrderService, type OrderService } from "./orderService.js";
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
} from "./types.js";
import { createWorkflowService, type WorkflowService } from "./workflows.js";

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
  getOrderRefById(orderId: number, tx?: DbOrTx): Promise<OrderRef | null>;
  searchOrders(principal: SessionPrincipal, query: string, limit?: number): Promise<OrderSearchHit[]>;

  /* ---- portable hooks ---- */
  portableOrders(tx: DbOrTx, selection: PortableSelection): Promise<{ items: PortableOrder[]; nextAfter: number | null }>;
  importOrder(input: ImportOrderInput, tx: Tx): Promise<ImportReceipt>;
  findImportedOrder: PortableHooks["findImportedOrder"];
  checkCatalogViability(items: { productPublicId?: string; name: string; currency: string }[]): Promise<{ matched: number; unmatched: number }>;

  /* ---- services used by the router ---- */
  catalog: CatalogService;
  workflows: WorkflowService;
  orders: OrderService;
  sharing: SharingService;
}

export function createOrdersModule(deps: ModuleDeps): OrdersModule {
  registerOrderMailTemplates(deps.mailer);
  const policy = createOrderPolicy({ db: deps.db, clock: deps.clock, audit: deps.audit });
  const catalog = createCatalogService({ db: deps.db, clock: deps.clock, audit: deps.audit });
  const workflows = createWorkflowService({ db: deps.db, clock: deps.clock, audit: deps.audit });
  const orders = createOrderService({ ...deps, policy, catalog, workflows });
  const sharing = createSharingService({ ...deps, policy });
  const portable = createPortableHooks({ ...deps, workflows });

  return {
    assertCanReadOrder: policy.assertCanReadOrder,
    assertCanWriteOrder: policy.assertCanWriteOrder,
    assertCanReadOrderById: policy.assertCanReadOrderById,
    assertCanWriteOrderById: policy.assertCanWriteOrderById,
    listAccessibleOrderIds: policy.listAccessibleOrderIds,
    getOrderSummary: orders.getOrderSummary,
    getOrderRefById: orders.getOrderRefById,
    searchOrders: orders.searchOrders,
    portableOrders: portable.portableOrders,
    importOrder: portable.importOrder,
    findImportedOrder: portable.findImportedOrder,
    checkCatalogViability: catalog.checkViability,
    catalog,
    workflows,
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
