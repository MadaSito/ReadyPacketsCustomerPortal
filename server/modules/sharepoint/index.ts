/**
 * SharePoint module (increment 03): registers the Graph drive storage adapters (sharepoint, onedrive), the
 * order-data list sync worker, the order change listener and the "Sync order to SharePoint" automation action.
 * Everything ships disabled. Other modules reach it through `deps.services.sharepoint` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { graphDriveDefinitions } from "../storage/adapters/graphDrive.js";
import { createGraphDrivePort, type PublishedGraphClient } from "../storage/adapters/graphDriveGraph.js";
import { GraphTransportError, type GraphCredentials, type GraphHttpPort } from "../storage/adapters/graphDrivePort.js";
import "./automation.js";
import { BACKFILL_JOB, SYNC_JOB, createSharepointService, type BackfillJobPayload, type SharepointService, type SyncJobPayload } from "./service.js";

export type { OrderSyncSettingsView, OrderSyncTestCode } from "./service.js";

export interface SharepointModule extends ModuleLifecycle, Omit<SharepointService, "runSync"> {}

/** Structural view of the integrations Graph surface (API.md §1.2), resolved lazily at call time. */
interface IntegrationsGraphSurface {
  graph?: PublishedGraphClient;
  createScopedGraphClient?: (credentials: GraphCredentials & { credentialVersion?: string | number }) => PublishedGraphClient;
}

/** Port backed by services.integrations; fails closed (NOT configured) until that runtime exists. */
export function integrationsGraphPort(deps: ModuleDeps): GraphHttpPort {
  const surface = () => deps.services.integrations as unknown as IntegrationsGraphSurface | undefined;
  return createGraphDrivePort(
    (credentials) => {
      const factory = surface()?.createScopedGraphClient;
      if (!factory) throw new GraphTransportError("EGRESS_DENIED", false);
      return factory(credentials);
    },
    () => {
      const client = surface()?.graph;
      if (!client) throw new GraphTransportError("EGRESS_DENIED", false);
      return client;
    },
  );
}

export function createSharepointModule(deps: ModuleDeps, options: { port?: GraphHttpPort } = {}): SharepointModule {
  const port = options.port ?? integrationsGraphPort(deps);
  const service = createSharepointService(deps, port);
  // Mostly network I/O guarded by fences and remote-id lookup: an interrupted attempt re-runs the lookup by
  // RpOrderId before creating, so it cannot create a second item for the same order.
  deps.jobs.register<SyncJobPayload>(SYNC_JOB, (job) => service.runSync(job), { retrySafe: true });
  deps.jobs.register<BackfillJobPayload>(BACKFILL_JOB, (job) => service.runBackfill(job), { retrySafe: true });

  const { runSync: _runSync, ...api } = service;
  return {
    ...api,
    init() {
      const definitions = graphDriveDefinitions(port);
      deps.services.storageConnections.registerAdapter("sharepoint", definitions.sharepoint);
      deps.services.storageConnections.registerAdapter("onedrive", definitions.onedrive);
      deps.services.orders.registerChangeListener((event, tx) => service.onOrderChange(event, tx));
      deps.services.trash?.register(service.trashParticipant);
    },
    async health(): Promise<ModuleHealth[]> {
      return [{ component: "sharepoint.order_sync", state: "disabled", summary: "SharePoint order sync health is reported in its settings view.", checkedAt: deps.clock.now() }];
    },
  };
}
