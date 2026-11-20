import { z } from "zod";
import { defineSetting } from "../platform/settingsRegistry.js";
import { allowedExtensions } from "./classification.js";

export const hardMaxFileBytes = 100 * 1024 * 1024;
export const hardMaxRequestBytes = 256 * 1024 * 1024;
export const hardMaxFiles = 12;

export const fileRulesSchema = z.strictObject({
  extensions: z.array(z.enum(allowedExtensions)).max(allowedExtensions.length)
    .refine((items) => new Set(items).size === items.length, "Choose each extension only once."),
  maxFileBytes: z.number().int().min(1024).max(hardMaxFileBytes),
  maxRequestBytes: z.number().int().min(4096).max(hardMaxRequestBytes),
  maxFiles: z.number().int().min(1).max(hardMaxFiles),
  retentionDays: z.number().int().min(1).max(90),
}).refine((value) => value.maxFileBytes + 1024 <= value.maxRequestBytes, "The request limit must exceed the file limit.");
export type FileRules = z.infer<typeof fileRulesSchema>;

export const fileRulesSetting = defineSetting({
  key: "files.type_rules",
  owner: "files",
  group: "files",
  label: "Private file admission",
  description: "Enable approved extensions and limit multipart and retention resources.",
  schema: fileRulesSchema,
  default: {
    extensions: [...allowedExtensions],
    maxFileBytes: 25 * 1024 * 1024,
    maxRequestBytes: 52 * 1024 * 1024,
    maxFiles: 8,
    retentionDays: 30,
  },
  sensitivity: "internal",
});
