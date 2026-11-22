/**
 * Promotions module — public service surface and factory. Owner: siem_engineer (Increment 05, Package C1).
 */
import "./settings.js";
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { createPromotionsService, type PromotionsService } from "./service.js";

export * from "./settings.js";
export * from "./contracts.js";
export type {
  CreatePromotionInput,
  GenerateBatchInput,
  ListPromotionsInput,
  PromotionsService,
  UpdatePromotionInput,
} from "./service.js";

export interface PromotionsModule extends ModuleLifecycle, PromotionsService {}

export function createPromotionsModule(deps: ModuleDeps): PromotionsModule {
  const service = createPromotionsService(deps);

  return {
    ...service,
    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const { enabled, activePromotions } = await service.healthCounts();
        return [
          {
            component: "promotions",
            state: enabled ? "ok" : "disabled",
            summary: enabled
              ? "Discount codes and links are enabled."
              : "Discount codes and links are disabled.",
            metrics: { activePromotions },
            checkedAt,
          },
        ];
      } catch {
        return [
          {
            component: "promotions",
            state: "failing",
            summary: "Promotions store health check failed.",
            checkedAt,
          },
        ];
      }
    },
  };
}
