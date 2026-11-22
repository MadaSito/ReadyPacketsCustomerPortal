/**
 * Route table of /api/v1 — the single source for dispatch, scope checks and the OpenAPI document.
 */
import { z } from "zod";
import {
  type ApiCaller,
  type ApiListQuery,
  type ApiScope,
  type PublicApiProviders,
  type ProviderKey,
  customerDto,
  invoiceDto,
  knowledgeArticleDto,
  orderCreateInput,
  orderDto,
  orderFileDto,
  orderTransitionInput,
  publicIdSchema,
  ticketCreateInput,
  ticketDto,
  webhookSubscriptionDto,
} from "./ports.js";

export type ApiMethod = "GET" | "POST";

export interface RouteCall {
  params: Record<string, string>;
  query: ApiListQuery;
  body: unknown;
  caller: ApiCaller;
}

export interface ApiRoute {
  operationId: string;
  method: ApiMethod;
  /** `/orders/:id` (audit/log template). */
  template: string;
  scope: ApiScope;
  provider: ProviderKey;
  kind: "list" | "get" | "create" | "action";
  summary: string;
  tag: string;
  filters: readonly string[];
  body?: z.ZodType;
  response: z.ZodType;
  /** Returns the DTO (or page) or null for not found. */
  invoke(providers: Partial<PublicApiProviders>, call: RouteCall): Promise<unknown>;
}

function need<K extends ProviderKey>(providers: Partial<PublicApiProviders>, key: K): PublicApiProviders[K] {
  const provider = providers[key];
  if (!provider) throw new ResourceUnavailable();
  return provider;
}

export class ResourceUnavailable extends Error {
  constructor() {
    super("RESOURCE_UNAVAILABLE");
  }
}

const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), next_cursor: z.string().max(200).nullable() });

function readable<K extends "customers" | "invoices" | "tickets" | "knowledge" | "webhookSubscriptions">(
  key: K,
  base: string,
  dto: z.ZodType,
  scope: ApiScope,
  tag: string,
  noun: string,
  filters: readonly string[],
): ApiRoute[] {
  return [
    {
      operationId: `list${tag.replace(/\s/gu, "")}`,
      method: "GET",
      template: base,
      scope,
      provider: key,
      kind: "list",
      summary: `List ${noun}`,
      tag,
      filters,
      response: page(dto),
      invoke: (p, c) => need(p, key).list(c.query, c.caller),
    },
    {
      operationId: `get${tag.replace(/\s/gu, "")}`,
      method: "GET",
      template: `${base}/:id`,
      scope,
      provider: key,
      kind: "get",
      summary: `Get one of ${noun}`,
      tag,
      filters: [],
      response: dto,
      invoke: (p, c) => need(p, key).get(c.params.id!, c.caller),
    },
  ];
}

export const API_ROUTES: readonly ApiRoute[] = [
  ...readable("customers", "/customers", customerDto, "customers:read", "Customers", "customers", ["status", "search"]),
  {
    operationId: "listOrders",
    method: "GET",
    template: "/orders",
    scope: "orders:read",
    provider: "orders",
    kind: "list",
    summary: "List orders",
    tag: "Orders",
    filters: ["customerId", "status"],
    response: page(orderDto),
    invoke: (p, c) => need(p, "orders").list(c.query, c.caller),
  },
  {
    operationId: "getOrder",
    method: "GET",
    template: "/orders/:id",
    scope: "orders:read",
    provider: "orders",
    kind: "get",
    summary: "Get an order",
    tag: "Orders",
    filters: [],
    response: orderDto,
    invoke: (p, c) => need(p, "orders").get(c.params.id!, c.caller),
  },
  {
    operationId: "createOrder",
    method: "POST",
    template: "/orders",
    scope: "orders:write",
    provider: "orders",
    kind: "create",
    summary: "Create an order for a customer",
    tag: "Orders",
    filters: [],
    body: orderCreateInput,
    response: orderDto,
    invoke: (p, c) => need(p, "orders").create(c.body as z.output<typeof orderCreateInput>, c.caller),
  },
  {
    operationId: "transitionOrder",
    method: "POST",
    template: "/orders/:id/transitions",
    scope: "orders:write",
    provider: "orders",
    kind: "action",
    summary: "Move an order to another status (where the workflow allows the API actor)",
    tag: "Orders",
    filters: [],
    body: orderTransitionInput,
    response: orderDto,
    invoke: (p, c) => need(p, "orders").transition(c.params.id!, c.body as z.output<typeof orderTransitionInput>, c.caller),
  },
  {
    operationId: "listOrderFiles",
    method: "GET",
    template: "/orders/:id/files",
    scope: "files:read",
    provider: "orderFiles",
    kind: "list",
    summary: "List file metadata of an order",
    tag: "Order files",
    filters: [],
    response: page(orderFileDto),
    invoke: (p, c) => need(p, "orderFiles").list(c.params.id!, c.query, c.caller),
  },
  ...readable("invoices", "/invoices", invoiceDto, "invoices:read", "Invoices", "invoices", ["customerId", "status"]),
  ...readable("tickets", "/tickets", ticketDto, "tickets:read", "Tickets", "support tickets", ["customerId", "status"]),
  {
    operationId: "createTicket",
    method: "POST",
    template: "/tickets",
    scope: "tickets:write",
    provider: "tickets",
    kind: "create",
    summary: "Open a support ticket for a customer",
    tag: "Tickets",
    filters: [],
    body: ticketCreateInput,
    response: ticketDto,
    invoke: (p, c) => need(p, "tickets").create(c.body as z.output<typeof ticketCreateInput>, c.caller),
  },
  ...readable("knowledge", "/knowledge/articles", knowledgeArticleDto, "knowledge:read", "Knowledge articles", "published knowledge articles", ["tag", "search"]),
  ...readable("webhookSubscriptions", "/webhook-subscriptions", webhookSubscriptionDto, "webhooks:read", "Webhook subscriptions", "webhook subscriptions", ["status"]),
];

const SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

/** Matches method + path (no query) to a route; `methodMismatch` when the path exists for another method. */
export function matchRoute(method: string, path: string): { route: ApiRoute; params: Record<string, string> } | { methodMismatch: true } | null {
  const segments = path.split("/").slice(1);
  let pathExists = false;
  for (const route of API_ROUTES) {
    const parts = route.template.split("/").slice(1);
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const value = segments[i]!;
      if (part.startsWith(":")) {
        if (!SEGMENT.test(value)) {
          ok = false;
          break;
        }
        params[part.slice(1)] = value;
      } else if (part !== value) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathExists = true;
    if (route.method === method || (method === "HEAD" && route.method === "GET")) return { route, params };
  }
  return pathExists ? { methodMismatch: true } : null;
}

/* ----------------------------------------------------------------------------------- OpenAPI */

const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  request_id: z.string(),
  detail: z.string().optional(),
});

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorResponses = Object.fromEntries(
    [
      ["401", "Missing, unknown, expired or revoked key, or invalid signature"],
      ["403", "Key lacks the scope, or the client address is not allowed"],
      ["404", "Not found"],
      ["409", "Conflict (version or idempotency in progress)"],
      ["422", "Validation failed"],
      ["429", "Rate limit exceeded"],
      ["503", "Resource or API not available"],
    ].map(([code, description]) => [code, { description, content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } }]),
  );
  for (const route of API_ROUTES) {
    const path = route.template.replace(/:([a-z]+)/gu, "{$1}");
    const parameters: unknown[] = [];
    if (route.template.includes(":id")) parameters.push({ name: "id", in: "path", required: true, schema: jsonSchema(publicIdSchema, "input") });
    if (route.kind === "list") {
      parameters.push(
        { name: "cursor", in: "query", schema: { type: "string", maxLength: 200 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
        { name: "updated_since", in: "query", schema: { type: "string", format: "date-time" } },
        ...route.filters.map((name) => ({ name, in: "query", schema: { type: "string", maxLength: 100 } })),
      );
    }
    if (route.body) parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" } });
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.tag],
      security: [{ apiKey: [] }],
      "x-required-scope": route.scope,
      parameters,
      responses: {
        [route.kind === "create" ? "201" : "200"]: { description: "OK", content: { "application/json": { schema: jsonSchema(route.response, "output") } } },
        ...errorResponses,
      },
    };
    if (route.body) operation.requestBody = { required: true, content: { "application/json": { schema: jsonSchema(route.body, "input") } } };
    (paths[path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ReadyPackets Portal API",
      version: "1.0.0",
      description:
        "Service API for integrations. Authenticate with an API key created by an administrator (`Authorization: Bearer rpk_…`). " +
        "Optional request signing: `X-RP-Timestamp` (unix seconds) and `X-RP-Signature: v1=<hex HMAC-SHA256(signing secret, timestamp \\n METHOD \\n path?query \\n body)>`. " +
        "Writes require `Idempotency-Key`. Errors use RFC 9457 problem details.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", bearerFormat: "rpk_<prefix>_<secret>" } },
      schemas: { Problem: jsonSchema(problem, "output") },
    },
    paths,
  };
}
