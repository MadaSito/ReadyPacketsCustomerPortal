/**
 * Public API v1 resource contract (increment 04 package H). Owners of the data register a provider in their
 * module's `init()`:
 *
 *   deps.services.publicApi.registerProvider("orders", { list, get, create, transition });
 *
 * The API module authenticates the key, enforces scopes, rate limits, signing, idempotency and logging, then
 * calls the provider with an `ApiCaller` (a service principal bound to scopes — never a user). Providers:
 *  - apply their own business rules (workflow `api` actor, locks, maintenance) and return DTOs exactly in the
 *    shapes below; the API module re-validates every DTO with these Zod schemas and strips unknown fields;
 *  - throw `DomainError` (NOT_FOUND, VALIDATION, CONFLICT, LOCKED, FORBIDDEN, UNAVAILABLE) for refusals;
 *  - record their own durable audit for writes with `actor: { role: "system" }` and
 *    `correlationId: caller.requestId` (the API module also records `api.request.write` for the key).
 * An unregistered provider answers 503 `RESOURCE_UNAVAILABLE` (fail closed).
 */
import { z } from "zod";
import type { Tx } from "../../core/types.js";

export const API_SCOPES = [
  "customers:read",
  "orders:read",
  "orders:write",
  "files:read",
  "invoices:read",
  "tickets:read",
  "tickets:write",
  "knowledge:read",
  "webhooks:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiCaller {
  kind: "api_key";
  keyPublicId: string;
  scopes: readonly ApiScope[];
  /** Request id of this API call (ULID); use as audit correlationId. */
  requestId: string;
  /** True when an administrator re-ran a stored call. */
  replay: boolean;
  /** Present on writes. Providers may use it as their own idempotency key. */
  idempotencyKey?: string;
}

export interface ApiListQuery {
  /** Opaque cursor issued by the same provider (≤ 200 chars), or null for the first page. */
  cursor: string | null;
  /** 1..100. */
  limit: number;
  updatedSince?: Date;
  /** Only the documented, resource-specific filters (already validated). */
  filter: Record<string, string>;
}

export interface ApiPage<T> {
  items: T[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------------------------------------ DTOs */

export const publicIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u).describe("Public id (ULID)");
const ts = z.iso.datetime({ offset: false }).describe("UTC timestamp (ISO 8601)");
const money = z.number().int().describe("Amount in minor units");
const currency = z.string().regex(/^[A-Z]{3}$/u);
const label = (max: number) => z.string().max(max);

export const customerDto = z.object({
  id: publicIdSchema,
  customerRef: label(64).nullable(),
  displayName: label(200),
  email: z.email().max(254).nullable(),
  status: label(32),
  createdAt: ts,
  updatedAt: ts,
});

export const orderDto = z.object({
  id: publicIdSchema,
  reference: label(64),
  customerId: publicIdSchema,
  status: z.object({ key: label(64), label: label(120) }),
  currency,
  subtotalMinor: money,
  discountMinor: money,
  totalMinor: money,
  items: z.array(z.object({ packetNumber: z.number().int().nullable(), tier: label(64).nullable(), name: label(200) })).max(200),
  version: z.number().int().min(0),
  createdAt: ts,
  updatedAt: ts,
  submittedAt: ts.nullable(),
  closedAt: ts.nullable(),
});

export const orderCreateInput = z.strictObject({
  customerId: publicIdSchema,
  items: z.array(z.strictObject({ productId: publicIdSchema, tierKey: z.string().min(1).max(64), quantity: z.number().int().min(1).max(100) })).min(1).max(50),
  customerNote: z.string().max(2000).optional(),
});

export const orderTransitionInput = z.strictObject({
  toStatusKey: z.string().min(1).max(64),
  expectedVersion: z.number().int().min(0),
  note: z.string().max(2000).optional(),
});

export const orderFileDto = z.object({
  id: publicIdSchema,
  orderId: publicIdSchema,
  displayName: label(255),
  category: label(64),
  contentType: label(255),
  size: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: ts,
});

export const invoiceDto = z.object({
  id: publicIdSchema,
  number: label(64),
  customerId: publicIdSchema,
  orderIds: z.array(publicIdSchema).max(100),
  status: label(32),
  currency,
  totalMinor: money,
  amountDueMinor: money,
  issuedAt: ts.nullable(),
  dueAt: ts.nullable(),
  paidAt: ts.nullable(),
});

export const ticketDto = z.object({
  id: publicIdSchema,
  number: label(64),
  customerId: publicIdSchema,
  orderId: publicIdSchema.nullable(),
  subject: label(200),
  status: label(32),
  priority: label(32),
  createdAt: ts,
  updatedAt: ts,
});

export const ticketCreateInput = z.strictObject({
  customerId: publicIdSchema,
  orderId: publicIdSchema.optional(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
});

export const knowledgeArticleDto = z.object({
  id: publicIdSchema,
  slug: z.string().regex(/^[a-z0-9-]{1,120}$/u),
  title: label(200),
  summary: label(500),
  /** Already sanitised by the knowledge module's allow-list. */
  bodyHtml: z.string().max(200_000),
  tags: z.array(label(64)).max(50),
  categoryId: publicIdSchema.nullable(),
  updatedAt: ts,
});

export const webhookSubscriptionDto = z.object({
  id: publicIdSchema,
  name: label(120),
  /** Host only; never the full URL (path/query may carry material). */
  targetUrlHost: label(253),
  events: z.array(label(120)).max(200),
  status: label(32),
  consecutiveFailures: z.number().int().min(0),
  createdAt: ts,
  updatedAt: ts,
});

export type CustomerDto = z.input<typeof customerDto>;
export type OrderDto = z.input<typeof orderDto>;
export type OrderFileDto = z.input<typeof orderFileDto>;
export type InvoiceDto = z.input<typeof invoiceDto>;
export type TicketDto = z.input<typeof ticketDto>;
export type KnowledgeArticleDto = z.input<typeof knowledgeArticleDto>;
export type WebhookSubscriptionDto = z.input<typeof webhookSubscriptionDto>;

/* ---------------------------------------------------------------------------------------- providers */

interface Readable<T> {
  list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<T>>;
  get(publicId: string, caller: ApiCaller): Promise<T | null>;
}

export interface PublicApiProviders {
  /** identity_engineer. Filters: `status`, `search` (≤ 100 chars). Customers only (no staff/admin accounts). */
  customers: Readable<CustomerDto>;
  /** orders_engineer. Filters: `customerId`, `status`. `transition` only where the workflow allows actor `api`. */
  orders: Readable<OrderDto> & {
    create(input: z.output<typeof orderCreateInput>, caller: ApiCaller, tx?: Tx): Promise<OrderDto>;
    transition(publicId: string, input: z.output<typeof orderTransitionInput>, caller: ApiCaller): Promise<OrderDto>;
  };
  /** files_engineer. Metadata only, never bytes or storage keys. Current (non-superseded, non-deleted) files. */
  orderFiles: { list(orderPublicId: string, query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<OrderFileDto> | null> };
  /** compliance_engineer. Filters: `customerId`, `status`. */
  invoices: Readable<InvoiceDto>;
  /** engagement_engineer. Filters: `customerId`, `status`. */
  tickets: Readable<TicketDto> & { create(input: z.output<typeof ticketCreateInput>, caller: ApiCaller): Promise<TicketDto> };
  /** engagement_engineer (knowledge). Published, audience `customers` only. Filters: `tag`, `search`. */
  knowledge: Readable<KnowledgeArticleDto>;
  /** integrations_engineer. Never secrets. Filters: `status`. */
  webhookSubscriptions: Readable<WebhookSubscriptionDto>;
}

export type ProviderKey = keyof PublicApiProviders;
