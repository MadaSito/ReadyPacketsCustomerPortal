/**
 * Orders module — public service surface and factory. Owner: orders module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.orders` at call time.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleLifecycle } from "../../core/types.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OrdersModule extends ModuleLifecycle {}

export function createOrdersModule(_deps: ModuleDeps): OrdersModule {
  return {};
}
