/**
 * Narrow typed client facade over:
 *   - trpc.storage.connections.{list,get,create,update,test}
 *   - trpc.storage.assignments.{list,set}
 *   - trpc.integrations.admin.egress.{presets,setPreset}
 *   - trpc.sharepoint.admin.{discoverSite,listDrives,resolveOneDrive,listFolders}
 *   - trpc.sharepoint.admin.orderSync.{get,listLists,createList,update,test,resyncAll,status}
 *   - Raw HTTP OAuth routes (/api/storage/oauth/redirect-uri/:provider, /start, /disconnect, /finish)
 */
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type {
  EgressPresetKey,
  EgressPresetStatus,
  OrderSyncSettingsView,
  OrderSyncStatusRow,
  OrderSyncTestCode,
  SharePointDiscoveredSite,
  SharePointDriveItem,
  SharePointFolderItem,
  SharePointListSummary,
  SharePointSyncRowState,
  StorageAssignmentView,
  StorageConfig,
  StorageConnectionView,
  StorageCredentials,
  StorageProviderKind,
  StoragePurpose,
  StorageTestResult,
} from "./model";

export type OAuthProvider = "dropbox" | "google_drive";

interface QueryProc<TInput, TOutput> {
  queryOptions(input: TInput): UseQueryOptions<TOutput, Error, TOutput, readonly unknown[]>;
  queryKey(input?: TInput): readonly unknown[];
}

interface QueryProcNoInput<TOutput> {
  queryOptions(): UseQueryOptions<TOutput, Error, TOutput, readonly unknown[]>;
  queryKey(): readonly unknown[];
}

interface MutationProc<TInput, TOutput> {
  mutationOptions(
    opts?: Omit<UseMutationOptions<TOutput, Error, TInput, unknown>, "mutationFn">,
  ): UseMutationOptions<TOutput, Error, TInput, unknown>;
}

export interface StorageCreateInput {
  kind: StorageProviderKind;
  name: string;
  config: StorageConfig;
  credentials?: StorageCredentials;
}

export interface StorageUpdateInput {
  publicId: string;
  expectedVersion: number;
  name?: string;
  config?: StorageConfig;
  credentials?: StorageCredentials | null;
  enabled?: boolean;
}

export interface StorageQueryApi {
  connectionsList: QueryProc<{ cursor?: string; limit?: number }, { items: StorageConnectionView[]; nextCursor: string | null }>;
  connectionGet: QueryProc<{ publicId: string }, StorageConnectionView>;
  assignmentsList: QueryProcNoInput<{ items: StorageAssignmentView[] }>;
  egressPresets: QueryProcNoInput<{ items: EgressPresetStatus[] }>;
  orderSyncGet: QueryProcNoInput<OrderSyncSettingsView>;
  orderSyncStatus: QueryProc<
    { cursor?: string | null; limit?: number; state?: SharePointSyncRowState },
    { items: OrderSyncStatusRow[]; nextCursor: string | null }
  >;
  connectionCreate: MutationProc<StorageCreateInput, StorageConnectionView>;
  connectionUpdate: MutationProc<StorageUpdateInput, StorageConnectionView>;
  connectionTest: MutationProc<{ publicId: string }, StorageTestResult>;
  assignmentSet: MutationProc<{ purpose: StoragePurpose; connectionPublicIds: string[] }, { items: StorageAssignmentView[] }>;
}

export interface StorageDirectClient {
  createConnection(input: StorageCreateInput): Promise<StorageConnectionView>;
  updateConnection(input: StorageUpdateInput): Promise<StorageConnectionView>;
  testConnection(input: { publicId: string }): Promise<StorageTestResult>;
  setAssignment(input: { purpose: StoragePurpose; connectionPublicIds: string[] }): Promise<{ items: StorageAssignmentView[] }>;
  setEgressPreset(input: {
    presetKey: EgressPresetKey;
    enabled: boolean;
    params?: { region?: string; bucket?: string; accountName?: string };
  }): Promise<{ presetKey: EgressPresetKey; enabled: boolean; activeHosts: string[] }>;
  // SharePoint / OneDrive discovery
  discoverSite(input: {
    connectionPublicId: string;
    expectedVersion: number;
    siteUrl: string;
  }): Promise<SharePointDiscoveredSite>;
  listDrives(input: {
    connectionPublicId: string;
    expectedVersion: number;
    siteId: string;
  }): Promise<{ drives: SharePointDriveItem[] }>;
  resolveOneDrive(input: {
    connectionPublicId: string;
    expectedVersion: number;
    userPrincipalName: string;
  }): Promise<{ driveId: string; driveName: string }>;
  listFolders(input: {
    connectionPublicId: string;
    expectedVersion: number;
    kind: "sharepoint" | "onedrive";
    driveId: string;
    parentItemId?: string | null;
    cursor?: string | null;
  }): Promise<{ folders: SharePointFolderItem[]; nextCursor: string | null }>;
  // SharePoint order sync
  listOrderSyncLists(): Promise<{ lists: SharePointListSummary[] }>;
  createOrderSyncList(input: { displayName: string }): Promise<{ listId: string; displayName: string }>;
  updateOrderSync(input: {
    expectedVersion: number;
    enabled: boolean;
    listId: string | null;
    listLabel: string | null;
    includePortalLink: boolean;
  }): Promise<OrderSyncSettingsView>;
  testOrderSync(): Promise<{ ok: boolean; code: OrderSyncTestCode }>;
  resyncAllOrders(): Promise<{ enqueued: number }>;
  backfillOrders(input?: { restart?: boolean }): Promise<OrderSyncSettingsView>;
  // Raw HTTP OAuth endpoints
  getOAuthRedirectUri(provider: OAuthProvider): Promise<{ redirectUri: string }>;
  startOAuth(input: {
    provider: OAuthProvider;
    publicId: string;
    expectedVersion: number;
  }): Promise<{ authorizeUrl: string }>;
  disconnectOAuth(input: {
    provider: OAuthProvider;
    publicId: string;
    expectedVersion: number;
  }): Promise<{ remoteRevoked: boolean }>;
  finishOAuth(attemptHandle: string): Promise<{ connected: true }>;
}

async function parseRawHttpJson<T>(res: Response, fallbackMessage: string): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const rec = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const safeRec = (typeof rec.safe === "object" && rec.safe !== null ? rec.safe : rec) as Record<string, unknown>;
    const domainCode = typeof safeRec.domainCode === "string" ? safeRec.domainCode : res.status === 403 ? "FORBIDDEN" : "INTERNAL";
    const reasonCode = typeof safeRec.reasonCode === "string" ? safeRec.reasonCode : undefined;
    const safeMessage =
      typeof safeRec.safeMessage === "string"
        ? safeRec.safeMessage
        : typeof rec.message === "string"
          ? rec.message
          : fallbackMessage;
    throw Object.assign(new Error(safeMessage), {
      data: {
        safe: {
          domainCode,
          reasonCode,
          safeMessage,
        },
      },
    });
  }
  return body as T;
}

export async function fetchOAuthRedirectUri(provider: OAuthProvider): Promise<{ redirectUri: string }> {
  const res = await sessionFetch(apiUrl(`/api/storage/oauth/redirect-uri/${provider}`), {
    method: "GET",
    cache: "no-store",
  });
  return parseRawHttpJson<{ redirectUri: string }>(res, "Could not load OAuth redirect URI.");
}

export async function postOAuthStart(input: {
  provider: OAuthProvider;
  publicId: string;
  expectedVersion: number;
}): Promise<{ authorizeUrl: string }> {
  const res = await sessionFetch(apiUrl("/api/storage/oauth/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseRawHttpJson<{ authorizeUrl: string }>(res, "Could not start OAuth authorization.");
}

export async function postOAuthDisconnect(input: {
  provider: OAuthProvider;
  publicId: string;
  expectedVersion: number;
}): Promise<{ remoteRevoked: boolean }> {
  const res = await sessionFetch(apiUrl("/api/storage/oauth/disconnect"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseRawHttpJson<{ remoteRevoked: boolean }>(res, "Could not disconnect OAuth provider.");
}

/**
 * Two-step OAuth completion after cross-site 303 redirect:
 * Refreshes CSRF via GET /api/csrf (including anonymous token when session expired so server can
 * burn the parked handle cleanly), then posts { attemptHandle } with first-party Strict cookies.
 */
export async function postOAuthFinish(attemptHandle: string): Promise<{ connected: true }> {
  await sessionFetch(apiUrl("/api/csrf"), {
    method: "GET",
    cache: "no-store",
  });
  const res = await sessionFetch(apiUrl("/api/storage/oauth/finish"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptHandle }),
  });
  return parseRawHttpJson<{ connected: true }>(
    res,
    "OAuth authorization could not be completed. Restart Connect if the consent window expired.",
  );
}

export function useStorageApi(): StorageQueryApi {
  const trpc = useTRPC() as unknown as {
    storage: {
      connections: {
        list: QueryProc<{ cursor?: string; limit?: number }, { items: StorageConnectionView[]; nextCursor: string | null }>;
        get: QueryProc<{ publicId: string }, StorageConnectionView>;
        create: MutationProc<StorageCreateInput, StorageConnectionView>;
        update: MutationProc<StorageUpdateInput, StorageConnectionView>;
        test: MutationProc<{ publicId: string }, StorageTestResult>;
      };
      assignments: {
        list: QueryProcNoInput<{ items: StorageAssignmentView[] }>;
        set: MutationProc<{ purpose: StoragePurpose; connectionPublicIds: string[] }, { items: StorageAssignmentView[] }>;
      };
    };
    integrations: {
      admin: {
        egress: {
          presets: QueryProcNoInput<{ items: EgressPresetStatus[] }>;
        };
      };
    };
    sharepoint: {
      admin: {
        orderSync: {
          get: QueryProcNoInput<OrderSyncSettingsView>;
          status: QueryProc<
            { cursor?: string | null; limit?: number; state?: SharePointSyncRowState },
            { items: OrderSyncStatusRow[]; nextCursor: string | null }
          >;
        };
      };
    };
  };

  return {
    connectionsList: trpc.storage.connections.list,
    connectionGet: trpc.storage.connections.get,
    connectionCreate: trpc.storage.connections.create,
    connectionUpdate: trpc.storage.connections.update,
    connectionTest: trpc.storage.connections.test,
    assignmentsList: trpc.storage.assignments.list,
    assignmentSet: trpc.storage.assignments.set,
    egressPresets: trpc.integrations.admin.egress.presets,
    orderSyncGet: trpc.sharepoint.admin.orderSync.get,
    orderSyncStatus: trpc.sharepoint.admin.orderSync.status,
  };
}

export function useStorageDirectClient(): StorageDirectClient {
  const client = useTRPCClient() as unknown as {
    storage: {
      connections: {
        create: { mutate(input: StorageCreateInput): Promise<StorageConnectionView> };
        update: { mutate(input: StorageUpdateInput): Promise<StorageConnectionView> };
        test: { mutate(input: { publicId: string }): Promise<StorageTestResult> };
      };
      assignments: {
        set: { mutate(input: { purpose: StoragePurpose; connectionPublicIds: string[] }): Promise<{ items: StorageAssignmentView[] }> };
      };
    };
    integrations: {
      admin: {
        egress: {
          setPreset: {
            mutate(input: {
              presetKey: EgressPresetKey;
              enabled: boolean;
              params?: { region?: string; bucket?: string; accountName?: string };
            }): Promise<{ presetKey: EgressPresetKey; enabled: boolean; activeHosts: string[] }>;
          };
        };
      };
    };
    sharepoint: {
      admin: {
        discoverSite: {
          mutate(input: { connectionPublicId: string; expectedVersion: number; siteUrl: string }): Promise<SharePointDiscoveredSite>;
        };
        listDrives: {
          mutate(input: { connectionPublicId: string; expectedVersion: number; siteId: string }): Promise<{ drives: SharePointDriveItem[] }>;
        };
        resolveOneDrive: {
          mutate(input: { connectionPublicId: string; expectedVersion: number; userPrincipalName: string }): Promise<{ driveId: string; driveName: string }>;
        };
        listFolders: {
          mutate(input: {
            connectionPublicId: string;
            expectedVersion: number;
            kind: "sharepoint" | "onedrive";
            driveId: string;
            parentItemId?: string | null;
            cursor?: string | null;
          }): Promise<{ folders: SharePointFolderItem[]; nextCursor: string | null }>;
        };
        orderSync: {
          listLists: { mutate(): Promise<{ lists: SharePointListSummary[] }> };
          createList: { mutate(input: { displayName: string }): Promise<{ listId: string; displayName: string }> };
          update: {
            mutate(input: {
              expectedVersion: number;
              enabled: boolean;
              listId: string | null;
              listLabel: string | null;
              includePortalLink: boolean;
            }): Promise<OrderSyncSettingsView>;
          };
          test: { mutate(): Promise<{ ok: boolean; code: OrderSyncTestCode }> };
          resyncAll: { mutate(): Promise<{ enqueued: number }> };
          backfill: { mutate(input: { restart?: boolean }): Promise<OrderSyncSettingsView> };
        };
      };
    };
  };

  return {
    createConnection: (input) => client.storage.connections.create.mutate(input),
    updateConnection: (input) => client.storage.connections.update.mutate(input),
    testConnection: (input) => client.storage.connections.test.mutate(input),
    setAssignment: (input) => client.storage.assignments.set.mutate(input),
    setEgressPreset: (input) => client.integrations.admin.egress.setPreset.mutate(input),
    discoverSite: (input) => client.sharepoint.admin.discoverSite.mutate(input),
    listDrives: (input) => client.sharepoint.admin.listDrives.mutate(input),
    resolveOneDrive: (input) => client.sharepoint.admin.resolveOneDrive.mutate(input),
    listFolders: (input) => client.sharepoint.admin.listFolders.mutate(input),
    listOrderSyncLists: () => client.sharepoint.admin.orderSync.listLists.mutate(),
    createOrderSyncList: (input) => client.sharepoint.admin.orderSync.createList.mutate(input),
    updateOrderSync: (input) => client.sharepoint.admin.orderSync.update.mutate(input),
    testOrderSync: () => client.sharepoint.admin.orderSync.test.mutate(),
    resyncAllOrders: () => client.sharepoint.admin.orderSync.resyncAll.mutate(),
    backfillOrders: (input = {}) => client.sharepoint.admin.orderSync.backfill.mutate(input),
    getOAuthRedirectUri: fetchOAuthRedirectUri,
    startOAuth: postOAuthStart,
    disconnectOAuth: postOAuthDisconnect,
    finishOAuth: postOAuthFinish,
  };
}
