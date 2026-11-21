/**
 * Knowledge Base module (`server/modules/knowledge`).
 * Owner: engagement_engineer (Increment 04, Package F).
 */
import type { ModuleDeps } from "../../container.js";
import { createKnowledgeService, type KnowledgeModule } from "./service.js";
// Side-effect import registers `feature.knowledge` and `knowledge.config` in the central settings registry.
import "./settings.js";

export function createKnowledgeModule(deps: ModuleDeps): KnowledgeModule {
  return createKnowledgeService(deps);
}

export type { KnowledgeModule } from "./service.js";
export { KNOWLEDGE_RETENTION_JOB } from "./service.js";
export { knowledgeRouter, type KnowledgeRouter } from "./router.js";
export { registerKnowledgeHttpRoutes } from "./http.js";
export { KNOWLEDGE_CONFIG, KNOWLEDGE_FLAG, type KnowledgeConfig } from "./settings.js";
export * from "./types.js";
