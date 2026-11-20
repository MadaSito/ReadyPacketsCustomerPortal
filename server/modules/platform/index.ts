/**
 * Platform module — public service surface and factory. Owner: platform module engineer.
 * Other modules import TYPES and the pure declaration helpers from here and reach the instance through
 * `deps.services.platform` at call time.
 */
import type { HealthState, ModuleHealth, ModuleLifecycle } from "../../core/types.js";

export {
  SETTING_GROUPS,
  defineFeatureFlag,
  defineSecret,
  defineSetting,
  getSettingDefinition,
  isFlagEnabled,
  isSecretConfigured,
  listSettingDefinitions,
  readSecret,
  readSetting,
  writeSetting,
  type AnySettingDefinition,
  type FeatureFlagDefinition,
  type SecretSettingDefinition,
  type SettingGroup,
  type SettingSensitivity,
  type ValueSettingDefinition,
} from "./settingsRegistry.js";

export interface SchemaStatus {
  state: "current" | "behind" | "ahead" | "unknown" | "unreadable";
  releaseCount: number;
  appliedCount: number;
  lastReleaseTag: string | null;
}

export interface HealthReport {
  state: HealthState;
  checkedAt: Date;
  components: ModuleHealth[];
}

export const SETUP_CHECKLIST_IDS = [
  "admin_exists",
  "mfa_enforced",
  "canonical_origin",
  "keys_distinct",
  "schema",
  "smtp",
  "backups",
  "siem",
] as const;
export type SetupChecklistId = (typeof SETUP_CHECKLIST_IDS)[number];
export type SetupItemState = "complete" | "incomplete" | "not_configured" | "unknown";
export interface SetupChecklistItem {
  id: SetupChecklistId;
  state: SetupItemState;
  /** Fixed safe sentence. */
  summary: string;
  /** Whether the installation can operate safely without this item. */
  required: boolean;
}

export interface PublicSlide {
  id: string;
  title: string;
  body: string;
  /** `url` is a same-origin path: an allowlisted /brand/… asset or /api/platform/presentation/images/<id>. */
  image: { id: string; alt: string; url: string } | null;
}
export interface PublicPresentation {
  slides: PublicSlide[];
  /** Auto-advance is off by default; clients must also honour prefers-reduced-motion and offer pause. */
  slideshow: { autoAdvance: boolean; intervalSeconds: number };
  supportText: string;
  announcement: { text: string; tone: "info" | "warning" } | null;
}

export interface PlatformModule extends ModuleLifecycle {
  /** Compares the live database with the release's migration inventory; throws if incompatible (fail closed). */
  assertSchemaContract(): Promise<void>;
  /** Non-throwing schema state (counts and last release tag only). */
  schemaStatus(): Promise<SchemaStatus>;
  /** Aggregated health of every module, each probe bounded by a timeout. */
  healthReport(options?: { timeoutMs?: number }): Promise<HealthReport>;
  /** Summary for /readyz — never component details. */
  readiness(): Promise<{ ready: boolean; state: HealthState }>;
  /** Public first-run state; reveals nothing beyond whether an administrator exists. */
  setupStatus(): Promise<{ administratorExists: boolean }>;
  setupChecklist(): Promise<SetupChecklistItem[]>;
  /** Public sign-in presentation fields only. */
  presentation(): Promise<PublicPresentation>;
}

export { createPlatformModule } from "./module.js";
