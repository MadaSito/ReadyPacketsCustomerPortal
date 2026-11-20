/** Public types of the orders module (imported by other modules through ./index.js). */
import type { DbOrTx, Tx } from "../../core/types.js";
import type { Deliverable, PacketTier, ORDER_LOCK_STATES, GRANT_ROLES, GRANT_STATUSES, NOTE_VISIBILITIES } from "./schema.js";
import type { WorkflowDefinition } from "./workflowTypes.js";
import type { BundleQuote } from "./pricing.js";
import type { input as ZodInput } from "zod";
import type { importOrderInputSchema } from "./portable.js";

export type OrderLockState = (typeof ORDER_LOCK_STATES)[number];
export type GrantRole = (typeof GRANT_ROLES)[number];
export type GrantStatus = (typeof GRANT_STATUSES)[number];
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];
export type OrderAccessRole = "owner" | "contributor" | "viewer" | "staff" | "admin";
export type OrderWriteKind = "order" | "sharing" | "file" | "message" | "intake" | "invoice" | "status";

export interface OrderAccessView {
  /** Internal numeric id — server-side only, never send to clients. */
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  ownerPublicId: string;
  statusKey: string;
  lockState: OrderLockState;
  locked: boolean;
  readOnlyImported: boolean;
  accessRole: OrderAccessRole;
  /** Cosmetic hint: may this principal write kind=order right now. */
  canWrite: boolean;
  origin: "portal" | "import";
  version: number;
  workflowVersionId: number;
}

export interface AccessOptions {
  tx?: DbOrTx;
  /** SELECT … FOR UPDATE (only meaningful inside a transaction). */
  forUpdate?: boolean;
}

export interface OrderSummary {
  publicId: string;
  reference: string;
  projectName: string;
  statusKey: string;
  statusLabel: string;
  statusTone: string;
  lockState: OrderLockState;
  totalMinor: number;
  currency: string;
  accessRole: OrderAccessRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderRef {
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  lockState: OrderLockState;
  statusKey: string;
}

export type AccessibleOrderIds = { all: true } | { all: false; orderIds: number[]; truncated: boolean };

/* ------------------------------------------------------------- portable */

export interface PortableLineItem {
  publicId: string;
  productPublicId: string | null;
  productVersion: number | null;
  name: string;
  description: string;
  features: string[];
  packetNumber: number | null;
  tier: PacketTier | null;
  outcome: string;
  timeline: string;
  deliverables: Deliverable[];
  unitPriceMinor: number;
  currency: string;
  quantity: number;
  lineTotalMinor: number;
}

export interface PortableStatusEvent {
  publicId: string;
  fromStatus: string | null;
  toStatus: string;
  actorRole: string;
  reasonCode: string;
  occurredAt: Date;
}

export interface PortableNote {
  publicId: string;
  body: string;
  createdAt: Date;
}

export interface PortableOrder {
  id: number;
  publicId: string;
  reference: string;
  retiredReferences: string[];
  ownerUserId: number;
  projectName: string;
  statusKey: string;
  workflowKey: string;
  lockState: OrderLockState;
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  totalMinor: number;
  currency: string;
  origin: "portal" | "import";
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  lineItems: PortableLineItem[];
  statusHistory: PortableStatusEvent[];
  customerNotes: PortableNote[];
}

export interface PortableSelection {
  after?: number;
  limit: number;
  customerIds?: number[];
  orderIds?: number[];
}

export type ImportOrderInput = ZodInput<typeof importOrderInputSchema>;
export type { ImportReceipt as ImportOrderResult } from "./portable.js";

export interface OrderSearchHit {
  publicId: string;
  reference: string;
  projectName: string;
  statusLabel: string;
  updatedAt: Date;
}

export type { WorkflowDefinition, Tx };

/* ------------------------------------------------------- increment 02 */

export type { Deliverable, PacketTier };
export type { BundleRule } from "./settings.js";
export type { BundleQuote };
export type {
  CatalogActor,
  CatalogGroupView,
  CatalogProductView,
  CatalogSystemActor,
  OfferingsImportInput,
  OfferingsImportResult,
} from "./catalog.js";

/** Server-computed price of a selection (`orders.quote`); the same figures `orders.create` stores. */
export interface OrderQuote {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  totalMinor: number;
  bundle: BundleQuote | null;
}

/** Trusted production scope for P101/P201 payloads (`OrdersModule.getProductionScope`). */
export interface OrderProductionScope {
  orderId: number;
  orderPublicId: string;
  reference: string;
  ownerUserId: number;
  statusKey: string;
  lockState: OrderLockState;
  origin: "portal" | "import";
  /** One entry per packet, ascending packet number. */
  packets: { packetNumber: number; tier: PacketTier }[];
  /** Line items without a packet number. */
  otherItemCount: number;
}
