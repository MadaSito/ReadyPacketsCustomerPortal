/**
 * Public API module (increment 04, package H): inbound REST API at /api/v1 authenticated by API keys, the
 * OpenAPI document, the encrypted request log and administrator replay. Ships disabled (api_settings.enabled).
 * Domain modules register read/write providers at init through `registerProvider`.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { createApiEngine, type ApiHttpRequest, type ApiHttpResponse } from "./engine.js";
import type { ProviderKey, PublicApiProviders } from "./ports.js";
import { createPublicApiService, type PublicApiService } from "./service.js";

export type { ApiHttpRequest, ApiHttpResponse } from "./engine.js";
export type { KeyInput, KeyView, LogFilter } from "./service.js";
export * from "./ports.js";

export const PURGE_JOB = "publicApi.log.purge";

export interface PublicApiModule extends ModuleLifecycle, PublicApiService {
  /** Called by owning modules in their `init()`. A second registration for the same key is refused. */
  registerProvider<K extends ProviderKey>(key: K, provider: PublicApiProviders[K]): void;
  /** Entry point for the HTTP adapter (http.ts). Never throws; always returns a response. */
  handle(req: ApiHttpRequest): Promise<ApiHttpResponse>;
}

export function createPublicApiModule(deps: ModuleDeps): PublicApiModule {
  const providers: Partial<PublicApiProviders> = {};
  const engine = createApiEngine(deps, () => providers);
  const service = createPublicApiService(deps, engine);

  deps.jobs.register(PURGE_JOB, async () => {
    const deleted = await engine.purge();
    return { outcome: "completed", safeCounts: { deleted } };
  }, { retrySafe: true });
  deps.jobs.registerSchedule({ name: "publicApi.log.purge.hourly", type: PURGE_JOB, everyMs: 3_600_000 });

  return {
    ...service,
    registerProvider(key, provider) {
      if (providers[key]) throw new Error(`publicApi provider already registered: ${key}`);
      providers[key] = provider;
    },
    handle: (req) => engine.handle(req),
    async health(): Promise<ModuleHealth[]> {
      const { enabled } = await engine.settings();
      return [{ component: "publicApi", state: enabled ? "ok" : "disabled", summary: enabled ? "Public API is enabled." : "Public API is disabled.", checkedAt: deps.clock.now() }];
    },
  };
}
