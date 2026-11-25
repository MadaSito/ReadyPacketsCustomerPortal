import { z } from "zod";
import { isStageOrderFileFolderTemplate } from "./orderFileFolder.js";

export const DEFAULT_STAGE_FOLDERS = { documents: "{phase_key}/Docs", audio: "{phase_key}/Audio" } as const;
export const DEFAULT_STAGE_FILE_SYNC = { originals: null, conversionStaging: null, intakeDelivery: null } as const;
export const STAGE_FILE_SYNC_ROLES = ["originals", "conversionStaging", "intakeDelivery"] as const;
export const MANAGED_FILE_SYNC_ROLES = [...STAGE_FILE_SYNC_ROLES, "receipt"] as const;
export type ManagedFileSyncRole = (typeof MANAGED_FILE_SYNC_ROLES)[number];
const folder = z.string().refine(isStageOrderFileFolderTemplate, "Use a safe relative phase folder.");
const target = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u).nullable().default(null);

export const stageFoldersSchema = z.strictObject({
  documents: folder.default(DEFAULT_STAGE_FOLDERS.documents),
  audio: folder.default(DEFAULT_STAGE_FOLDERS.audio),
}).default(DEFAULT_STAGE_FOLDERS);

export const stageFileSyncSchema = z.strictObject({
  originals: target,
  conversionStaging: target,
  intakeDelivery: target,
}).default(DEFAULT_STAGE_FILE_SYNC);

export type StageFolders = z.output<typeof stageFoldersSchema>;
export type StageFileSync = z.output<typeof stageFileSyncSchema>;
export interface StageFileSyncPlan { key: string; folders: StageFolders; fileSync: StageFileSync }
