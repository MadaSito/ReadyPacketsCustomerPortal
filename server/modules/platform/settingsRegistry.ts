/**
 * Typed settings / secrets / feature-flag declarations. Owner: platform engineer.
 *
 * Every module declares the settings it reads in a module-level file of its own; declarations register
 * on import (ES modules evaluate once per process). The database-backed store refuses writes to
 * undeclared keys, validates every value with the declared Zod schema and never returns secrets.
 * The helpers below work against the core `SettingsStore` contract, so they also work with test fakes.
 */
import { z } from "zod";
import type { SettingsStore, Tx } from "../../core/types.js";

export const SETTING_GROUPS = [
  "general",
  "presentation",
  "security",
  "identity",
  "mail",
  "integrations",
  "observability",
  "backup",
  "jobs",
  "files",
  "orders",
  "engagement",
  "compliance",
  "portable",
  "analytics",
  "features",
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** `public` = safe for unauthenticated presentation; `internal` = administrators only; `secret` = never leaves the server. */
export type SettingSensitivity = "public" | "internal" | "secret";

export const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
export const MAX_SETTING_KEY_LENGTH = 96;
const FLAG_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

interface CommonDefinition {
  key: string;
  owner: string;
  group: SettingGroup;
  label: string;
  description: string;
}

export interface ValueSettingDefinition<T> extends CommonDefinition {
  kind: "value";
  schema: z.ZodType<T>;
  default: T;
  sensitivity: "public" | "internal";
  /** Included in configuration export / accepted by import. */
  exportable: boolean;
}

export interface SecretSettingDefinition extends CommonDefinition {
  kind: "secret";
  schema: z.ZodType<string>;
  sensitivity: "secret";
  exportable: boolean;
}

export interface FeatureFlagDefinition extends CommonDefinition {
  kind: "flag";
  flag: string;
  schema: z.ZodType<boolean>;
  default: false;
  sensitivity: "internal";
  exportable: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySettingDefinition = ValueSettingDefinition<any> | SecretSettingDefinition | FeatureFlagDefinition;

const registry = new Map<string, AnySettingDefinition>();

function assertCommon(def: { key: string; owner: string; label: string; description: string }): void {
  if (!SETTING_KEY_PATTERN.test(def.key) || def.key.length > MAX_SETTING_KEY_LENGTH) {
    throw new Error(`invalid setting key ${def.key}`);
  }
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(def.owner)) throw new Error(`invalid setting owner for ${def.key}`);
  if (def.label.length === 0 || def.label.length > 80) throw new Error(`invalid label for ${def.key}`);
  if (def.description.length > 400) throw new Error(`description too long for ${def.key}`);
}

function register<D extends AnySettingDefinition>(def: D): D {
  const existing = registry.get(def.key);
  if (existing && existing !== def) throw new Error(`duplicate setting key ${def.key}`);
  registry.set(def.key, Object.freeze(def) as AnySettingDefinition);
  return registry.get(def.key) as D;
}

export function defineSetting<T>(input: {
  key: string;
  owner: string;
  group: SettingGroup;
  label: string;
  description: string;
  schema: z.ZodType<T>;
  default: T;
  sensitivity?: "public" | "internal";
  exportable?: boolean;
}): ValueSettingDefinition<T> {
  assertCommon(input);
  if (input.key.startsWith("feature.")) throw new Error("use defineFeatureFlag for feature.* keys");
  const parsedDefault = input.schema.safeParse(input.default);
  if (!parsedDefault.success) throw new Error(`default for ${input.key} does not satisfy its schema`);
  return register<ValueSettingDefinition<T>>({
    kind: "value",
    key: input.key,
    owner: input.owner,
    group: input.group,
    label: input.label,
    description: input.description,
    schema: input.schema,
    default: input.default,
    sensitivity: input.sensitivity ?? "internal",
    exportable: input.exportable ?? true,
  });
}

const defaultSecretSchema = z.string().min(1).max(8192);

export function defineSecret(input: {
  key: string;
  owner: string;
  group: SettingGroup;
  label: string;
  description: string;
  schema?: z.ZodType<string>;
  exportable?: boolean;
}): SecretSettingDefinition {
  assertCommon(input);
  if (input.key.startsWith("feature.")) throw new Error("secrets cannot use the feature.* namespace");
  return register<SecretSettingDefinition>({
    kind: "secret",
    key: input.key,
    owner: input.owner,
    group: input.group,
    label: input.label,
    description: input.description,
    schema: input.schema ?? defaultSecretSchema,
    sensitivity: "secret",
    exportable: input.exportable ?? true,
  });
}

/** Feature flags ALWAYS default to off. The stored key is `feature.<flag>`. */
export function defineFeatureFlag(input: {
  flag: string;
  owner: string;
  label: string;
  description: string;
  group?: SettingGroup;
}): FeatureFlagDefinition {
  if (!FLAG_PATTERN.test(input.flag)) throw new Error(`invalid feature flag ${input.flag}`);
  const key = `feature.${input.flag}`;
  assertCommon({ ...input, key });
  return register<FeatureFlagDefinition>({
    kind: "flag",
    key,
    flag: input.flag,
    owner: input.owner,
    group: input.group ?? "features",
    label: input.label,
    description: input.description,
    schema: z.boolean(),
    default: false,
    sensitivity: "internal",
    exportable: true,
  });
}

export function getSettingDefinition(key: string): AnySettingDefinition | undefined {
  return registry.get(key);
}

export function listSettingDefinitions(): AnySettingDefinition[] {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function flagKey(flag: string): string {
  return `feature.${flag}`;
}

/* ------------------------------------------------------------------ typed helpers */

export async function readSetting<T>(settings: SettingsStore, def: ValueSettingDefinition<T>, tx?: Tx): Promise<T> {
  return settings.get(def.key, (raw) => def.schema.parse(raw), def.default, tx);
}

export async function writeSetting<T>(settings: SettingsStore, def: ValueSettingDefinition<T>, value: T, tx?: Tx): Promise<void> {
  await settings.set(def.key, def.schema.parse(value), tx);
}

export async function readSecret(settings: SettingsStore, def: SecretSettingDefinition, tx?: Tx): Promise<string | null> {
  return settings.getSecret(def.key, tx);
}

export async function isSecretConfigured(settings: SettingsStore, def: SecretSettingDefinition, tx?: Tx): Promise<boolean> {
  return (await settings.getSecret(def.key, tx)) !== null;
}

export async function isFlagEnabled(settings: SettingsStore, def: FeatureFlagDefinition, tx?: Tx): Promise<boolean> {
  return settings.isFeatureEnabled(def.flag, tx);
}
