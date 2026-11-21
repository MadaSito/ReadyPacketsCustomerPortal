/**
 * Community forum — enable switch and configuration. Owner: audit_engineer (package M).
 * The flag defaults OFF (defineFeatureFlag guarantees it); it is client-visible so the shell can hide navigation.
 */
import { z } from "zod";
import { defineFeatureFlag, defineSetting } from "../platform/index.js";

export const COMMUNITY_FLAG = defineFeatureFlag({
  flag: "community",
  owner: "community",
  label: "Community forum",
  description: "Lets signed-in users read and post in the community forum under a display name. Off by default.",
  clientVisible: true,
});

const word = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}' -]*$/u, "letters, digits, apostrophes, spaces and hyphens only");

export const communityConfigSchema = z
  .object({
    editWindowMinutes: z.number().int().min(0).max(1440),
    newMemberDays: z.number().int().min(0).max(90),
    newMemberDailyPosts: z.number().int().min(1).max(100),
    newMemberReviewPosts: z.number().int().min(0).max(20),
    maxPostsPerHour: z.number().int().min(1).max(200),
    autoHideReportCount: z.number().int().min(1).max(50),
    blockedWords: z.array(word).max(200),
    heldWords: z.array(word).max(200),
  })
  .strict();
export type CommunityConfig = z.infer<typeof communityConfigSchema>;

export const DEFAULT_COMMUNITY_CONFIG: CommunityConfig = Object.freeze({
  editWindowMinutes: 30,
  newMemberDays: 7,
  newMemberDailyPosts: 5,
  newMemberReviewPosts: 2,
  maxPostsPerHour: 20,
  autoHideReportCount: 3,
  blockedWords: [],
  heldWords: [],
}) as CommunityConfig;

export const COMMUNITY_CONFIG = defineSetting({
  key: "community.config",
  owner: "community",
  group: "features",
  label: "Community forum rules",
  description: "Edit window, new-member limits, posting rate, report threshold and word filters for the community forum.",
  schema: communityConfigSchema,
  default: DEFAULT_COMMUNITY_CONFIG,
  sensitivity: "internal",
  exportable: true,
  writeCapability: "community.manage",
  managedBy: { href: "/admin/community/settings", label: "Community settings" },
});
