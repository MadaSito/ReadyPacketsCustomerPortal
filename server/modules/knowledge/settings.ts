/**
 * Knowledge Base module — feature flag and settings declarations (Increment 04, Package F).
 * Ships disabled (`feature.knowledge = false`) until an administrator enables it.
 */
import { z } from "zod";
import { defineFeatureFlag, defineSetting } from "../platform/settingsRegistry.js";

export const KNOWLEDGE_FLAG = defineFeatureFlag({
  flag: "knowledge",
  owner: "knowledge",
  group: "features",
  label: "Knowledge base and help centre",
  description:
    "Enable the customer /help centre, article search, contextual support-ticket suggestions, and API v1 knowledge listing.",
  clientVisible: true,
});

export const knowledgeConfigSchema = z.strictObject({
  /** Retention window for anonymous aggregated search terms (7..365 days). */
  searchLogRetentionDays: z.number().int().min(7).max(365),
  /** Whether readers may include an optional plain-text note when voting Helpful Yes / No. */
  allowFeedbackComments: z.boolean(),
});

export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema>;

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  searchLogRetentionDays: 90,
  allowFeedbackComments: true,
};

export const KNOWLEDGE_CONFIG = defineSetting<KnowledgeConfig>({
  key: "knowledge.config",
  owner: "knowledge",
  group: "engagement",
  label: "Knowledge base settings",
  description: "Retention for anonymised search analytics and reader feedback options.",
  schema: knowledgeConfigSchema,
  default: DEFAULT_KNOWLEDGE_CONFIG,
  sensitivity: "internal",
  exportable: true,
  writeCapability: "platform.settings.manage",
  managedBy: {
    href: "/admin/knowledge",
    label: "Knowledge base",
  },
  fields: {
    searchLogRetentionDays: {
      label: "Search analytics retention (days)",
      help: "Aggregated search terms without user identity are pruned after this many days (7–365).",
    },
    allowFeedbackComments: {
      label: "Allow optional feedback comments",
      help: "Let signed-in readers attach an encrypted plain-text note to Helpful Yes / No votes.",
    },
  },
});
