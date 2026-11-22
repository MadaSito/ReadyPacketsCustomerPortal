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

export const audioRulesSchema = z.strictObject({
  enabled: z.boolean(),
  maxMinutes: z.number().int().min(1).max(20),
  bitrateKbps: z.number().int().min(24).max(128),
  keepOriginal: z.literal(true),
});
export type AudioRules = z.infer<typeof audioRulesSchema>;
export const audioRulesSetting = defineSetting<AudioRules>({
  key: "files.audio_conversion",
  owner: "files",
  group: "files",
  label: "Order audio recording and conversion",
  description: "Enable microphone recording and local conversion to WebM/Opus. The original is always retained.",
  schema: audioRulesSchema,
  default: { enabled: false, maxMinutes: 5, bitrateKbps: 48, keepOriginal: true },
  sensitivity: "internal",
  managedBy: { href: "/admin/files", label: "File administration" },
});

export const slotKeySchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u);
export const transcriptSchema = z.string().trim().max(4000).refine((value) => !/\p{Cc}/u.test(value.replace(/[\r\n\t]/gu, "")));
