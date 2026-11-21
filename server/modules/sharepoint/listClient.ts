/**
 * SharePoint list operations for the order-data sync, over the same narrow Graph port as the drive adapter.
 * Errors are StorageAdapterError with fixed codes (no provider bodies, ids or labels).
 * Every write takes a `beforeSend` fence the transport calls immediately before sending.
 */
import { StorageAdapterError, fromStatus, toAdapterError } from "../storage/adapters/graphDriveErrors.js";
import type { GraphCredentials, GraphHttpPort, GraphRequest, GraphResponse } from "../storage/adapters/graphDrivePort.js";
import { LIST_COLUMNS, ORDER_ID_COLUMN, columnDefinition, isCompatible, type ListFields } from "./fields.js";

const ID_RE = /^[A-Za-z0-9!._,{}-]{1,200}$/u;
const ORDER_PUBLIC_ID_RE = /^[0-9A-Z]{26}$/u;
const MAX_LISTS = 50;

export type Fence = () => Promise<void>;

export interface ListSummary {
  listId: string;
  displayName: string;
  compatible: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new StorageAdapterError("PROVIDER_UNAVAILABLE", false);
  return value;
}

export function assertId(value: string): void {
  if (!ID_RE.test(value)) throw new StorageAdapterError("INVALID_INPUT", false);
}

export function createListClient(graph: GraphHttpPort, creds: GraphCredentials, siteId: string) {
  assertId(siteId);
  const site = `/sites/${encodeURIComponent(siteId)}`;

  const call = async (req: GraphRequest, ...okStatuses: number[]): Promise<GraphResponse> => {
    let fenceLost: { error: unknown } | null = null;
    const fence = req.beforeSend;
    const tracked = fence
      ? async () => {
          try {
            await fence();
          } catch (error) {
            fenceLost = { error };
            throw error;
          }
        }
      : undefined;
    let res: GraphResponse;
    try {
      res = await graph.request(creds, tracked ? { ...req, beforeSend: tracked } : req);
    } catch (error) {
      if (fenceLost) throw (fenceLost as { error: unknown }).error;
      throw toAdapterError(error);
    }
    if (okStatuses.length > 0 && !okStatuses.includes(res.status)) throw fromStatus(res.status);
    return res;
  };

  const columnsOf = async (listId: string): Promise<Record<string, unknown>[]> => {
    const res = await call({ method: "GET", path: `${site}/lists/${encodeURIComponent(listId)}/columns`, query: { $top: "200" } }, 200);
    const value = record(res.body).value;
    return Array.isArray(value) ? value.map(record) : [];
  };

  return {
    async listLists(): Promise<ListSummary[]> {
      const res = await call({ method: "GET", path: `${site}/lists`, query: { $select: "id,displayName,list", $top: String(MAX_LISTS) } }, 200);
      const value = record(res.body).value;
      const lists = (Array.isArray(value) ? value : []).map(record).slice(0, MAX_LISTS);
      const out: ListSummary[] = [];
      for (const l of lists) {
        if (typeof l.id !== "string" || !ID_RE.test(l.id) || typeof l.displayName !== "string") continue;
        out.push({ listId: l.id, displayName: l.displayName.slice(0, 255), compatible: isCompatible(await columnsOf(l.id)) });
      }
      return out;
    },

    async checkList(listId: string): Promise<"OK" | "LIST_NOT_FOUND" | "LIST_INCOMPATIBLE"> {
      assertId(listId);
      try {
        return isCompatible(await columnsOf(listId)) ? "OK" : "LIST_INCOMPATIBLE";
      } catch (error) {
        if (error instanceof StorageAdapterError && error.code === "DESTINATION_NOT_FOUND") return "LIST_NOT_FOUND";
        throw error;
      }
    },

    async createList(displayName: string, beforeSend: Fence): Promise<{ listId: string; displayName: string }> {
      const res = await call(
        {
          method: "POST",
          path: `${site}/lists`,
          body: { displayName, columns: LIST_COLUMNS.map(columnDefinition), list: { template: "genericList" } },
          beforeSend,
        },
        201,
        200,
      );
      const body = record(res.body);
      return { listId: id(body.id), displayName: typeof body.displayName === "string" ? body.displayName.slice(0, 255) : displayName };
    },

    /** Item id whose RpOrderId equals the order public id; null if none. Several matches → conflict. */
    async findByOrderId(listId: string, orderPublicId: string): Promise<string | null> {
      assertId(listId);
      if (!ORDER_PUBLIC_ID_RE.test(orderPublicId)) throw new StorageAdapterError("INVALID_INPUT", false);
      const res = await call(
        {
          method: "GET",
          path: `${site}/lists/${encodeURIComponent(listId)}/items`,
          query: { $filter: `fields/${ORDER_ID_COLUMN} eq '${orderPublicId}'`, $expand: `fields($select=${ORDER_ID_COLUMN})`, $top: "5" },
          headers: { prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" },
        },
        200,
      );
      const value = record(res.body).value;
      const matches = (Array.isArray(value) ? value : []).map(record).filter((i) => record(i.fields)[ORDER_ID_COLUMN] === orderPublicId);
      if (matches.length > 1) throw new StorageAdapterError("DESTINATION_CONFLICT", false);
      return matches.length === 1 ? id(matches[0]!.id) : null;
    },

    /** Verifies the object identity: the item exists and carries this order's public id. */
    async verifyItem(listId: string, itemId: string, orderPublicId: string): Promise<boolean> {
      assertId(listId);
      assertId(itemId);
      const res = await call({ method: "GET", path: `${site}/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`, query: { $expand: `fields($select=${ORDER_ID_COLUMN})` } });
      if (res.status === 404) return false;
      if (res.status !== 200) throw fromStatus(res.status);
      return record(record(res.body).fields)[ORDER_ID_COLUMN] === orderPublicId;
    },

    async createItem(listId: string, fields: ListFields, beforeSend: Fence): Promise<string> {
      assertId(listId);
      const res = await call({ method: "POST", path: `${site}/lists/${encodeURIComponent(listId)}/items`, body: { fields }, beforeSend }, 201, 200);
      return id(record(res.body).id);
    },

    async updateItem(listId: string, itemId: string, fields: ListFields, beforeSend: Fence): Promise<void> {
      assertId(listId);
      assertId(itemId);
      await call({ method: "PATCH", path: `${site}/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/fields`, body: fields, beforeSend }, 200);
    },
  };
}

export type ListClient = ReturnType<typeof createListClient>;
