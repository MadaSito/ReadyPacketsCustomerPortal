import { z } from "zod";
import { defineSetting } from "../platform/settingsRegistry.js";
import type { AutomationSettingsView } from "./contracts.js";

export const automationsConfigSchema = z.strictObject({
  enabled: z.boolean(),
  globalRunsPerMinute: z.number().int().min(5).max(2_000),
  defaultPerAutomationRunsPerHour: z.number().int().min(1).max(600),
  maxPerAutomationRunsPerHour: z.number().int().min(5).max(1_200),
  runRetentionDays: z.number().int().min(7).max(365),
});

export const DEFAULT_AUTOMATIONS_SETTINGS: AutomationSettingsView = Object.freeze({
  enabled: false,
  globalRunsPerMinute: 120,
  defaultPerAutomationRunsPerHour: 60,
  maxPerAutomationRunsPerHour: 600,
  runRetentionDays: 90,
});

export const AUTOMATIONS_CONFIG = defineSetting({
  key: "automations.config",
  owner: "automations",
  group: "engagement",
  label: "Event automations engine",
  description:
    "Controls whether event-triggered and scheduled automations execute, along with global and per-automation rate limits.",
  schema: automationsConfigSchema,
  default: DEFAULT_AUTOMATIONS_SETTINGS,
  sensitivity: "internal",
  exportable: true,
  writeCapability: "automations.manage",
  managedBy: {
    href: "/admin/automations",
    label: "Automations",
  },
  fields: {
    enabled: {
      label: "Enable automations engine",
      help: "Ships off by default. When disabled, no event or schedule triggers execute.",
    },
    globalRunsPerMinute: {
      label: "Global run limit (per minute)",
      help: "Maximum total automation runs allowed across the portal per minute.",
    },
    defaultPerAutomationRunsPerHour: {
      label: "Default per-automation limit (per hour)",
      help: "Default hourly run cap applied when creating a new automation.",
    },
    maxPerAutomationRunsPerHour: {
      label: "Maximum per-automation limit (per hour)",
      help: "Upper ceiling an administrator may configure on any single automation.",
    },
    runRetentionDays: {
      label: "Run history retention (days)",
      help: "Days to retain completed/failed automation run records before automatic purge.",
    },
  },
});
