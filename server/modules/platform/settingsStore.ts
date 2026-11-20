/**
 * Database-backed settings + feature flags with encrypted secrets. Owner: platform engineer.
 *
 *  - Only DECLARED keys (settingsRegistry.ts) can be written; values are validated by the declared schema.
 *  - Secrets are AES-256-GCM envelopes (AAD `platform_settings.secret:<key>`); plaintext is never cached and
 *    never returned to a browser (describe() reports `configured` only).
 *  - Optimistic concurrency via a per-row version (absent row = version 0); SELECT … FOR UPDATE serializes writers.
 *  - Every change is durably audited inside the same transaction (audit failure ⇒ no write).
 *  - Short process-local cache (TTL 5 s) of rows, invalidated on local writes; other processes converge within TTL.
 */
import { eq } from "drizzle-orm";
import { CryptoError, DomainError, conflict, validation } from "../../core/errors.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { AuditEmitter, AuditEventInput, Clock, Db, FieldCrypto, Logger, SafeAttributeValue, SettingsStore, Tx } from "../../core/types.js";
import { platformSettings } from "./schema.js";
import { flagKey, getSettingDefinition, listSettingDefinitions, type AnySettingDefinition, type SettingGroup } from "./settingsRegistry.js";

export interface SettingsStoreDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  crypto: FieldCrypto;
  audit: AuditEmitter;
}

export const SETTINGS_CACHE_TTL_MS = 5_000;

export interface SettingView {
  key: string;
  kind: "value" | "secret" | "flag";
  group: SettingGroup;
  owner: string;
  label: string;
  description: string;
  sensitivity: "public" | "internal" | "secret";
  exportable: boolean;
  /** 0 when never written. */
  version: number;
  updatedAt: Date | null;
  /** Non-secret only: effective value (stored if valid, else default). Absent for secrets. */
  value?: unknown;
  defaultValue?: unknown;
  /** True when a stored value exists (secrets: an envelope exists). */
  configured: boolean;
  /** Non-secret only: the stored value failed validation and the default is in effect. */
  invalidStored?: boolean;
}

export interface WriteOptions {
  /** Optimistic concurrency; omit only for internal writes that legitimately overwrite. */
  expectedVersion?: number;
  tx?: Tx;
}

export interface PlatformSettingsStore extends SettingsStore {
  /** Loads every settings row into the cache (one query). Call outside transactions to pre-warm. */
  warm(): Promise<void>;
  describe(filter?: { group?: SettingGroup; kinds?: readonly SettingView["kind"][] }): Promise<SettingView[]>;
  describeOne(key: string): Promise<SettingView>;
  /** Returns the new version. */
  update(key: string, value: unknown, options?: WriteOptions): Promise<number>;
  updateSecret(key: string, value: string | null, options?: WriteOptions): Promise<number>;
  setFeature(flag: string, enabled: boolean, options?: WriteOptions): Promise<number>;
  /** Raw stored JSON for a declared value/flag key (export); undefined when unset or invalid. */
  storedValue(key: string): Promise<unknown>;
  invalidate(key?: string): void;
}

type Row = typeof platformSettings.$inferSelect;

const SAFE_SCALAR = /^[A-Za-z0-9._:/@ -]{0,64}$/;

/** Old/new appear in audit only when they are clearly non-personal scalars. */
function auditableScalar(value: unknown): SafeAttributeValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && SAFE_SCALAR.test(value) && !value.includes("@")) return value;
  return undefined;
}

function secretAad(key: string): string {
  return `platform_settings.secret:${key}`;
}

export function createSettingsStore(deps: SettingsStoreDeps): PlatformSettingsStore {
  const { db, clock, logger, crypto, audit } = deps;
  const cache = new Map<string, { expires: number; row: Row | null }>();
  const log = logger.child({ component: "platform.settings" });

  /**
   * Cached read. On a miss the WHOLE (bounded) settings table is loaded in one query so a burst of reads
   * costs one pooled connection. When `tx` is given the read runs on the caller's connection (no second
   * pool checkout inside a transaction) and bypasses the cache.
   */
  async function loadRow(key: string, tx?: Tx): Promise<Row | null> {
    if (tx) {
      const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.settingKey, key)).limit(1);
      return row ?? null;
    }
    const now = clock.now().getTime();
    const hit = cache.get(key);
    if (hit && hit.expires > now) return hit.row;
    const rows = await loadAll();
    const expires = clock.now().getTime() + SETTINGS_CACHE_TTL_MS;
    for (const def of listSettingDefinitions()) cache.set(def.key, { expires, row: rows.get(def.key) ?? null });
    for (const [rowKey, row] of rows) cache.set(rowKey, { expires, row });
    const value = rows.get(key) ?? null;
    cache.set(key, { expires, row: value });
    return value;
  }

  async function loadAll(): Promise<Map<string, Row>> {
    const rows = await db.select().from(platformSettings).limit(2000);
    return new Map(rows.map((row) => [row.settingKey, row]));
  }

  function requireDefinition(key: string): AnySettingDefinition {
    const def = getSettingDefinition(key);
    if (!def) throw validation("UNKNOWN_SETTING", "That setting does not exist.");
    return def;
  }

  function parseStored(def: AnySettingDefinition, row: Row | null): { value: unknown; valid: boolean } | undefined {
    if (!row || def.kind === "secret" || row.valueJson === null || row.valueJson === undefined) return undefined;
    const parsed = def.schema.safeParse(row.valueJson);
    return parsed.success ? { value: parsed.data, valid: true } : { value: undefined, valid: false };
  }

  async function write(
    def: AnySettingDefinition,
    apply: { valueJson?: unknown; secretEnc?: string | null },
    event: (previous: Row | null, version: number) => AuditEventInput,
    options: WriteOptions,
  ): Promise<number> {
    const actorUserId = getRequestContext()?.actor?.userId ?? null;
    const run = async (tx: Tx): Promise<number> => {
      const [current] = await tx.select().from(platformSettings).where(eq(platformSettings.settingKey, def.key)).limit(1).for("update");
      const currentVersion = current?.version ?? 0;
      if (options.expectedVersion !== undefined && options.expectedVersion !== currentVersion) {
        throw conflict("VERSION_MISMATCH", "This setting was changed by someone else. Reload and try again.");
      }
      const nextVersion = currentVersion + 1;
      if (current) {
        await tx
          .update(platformSettings)
          .set({ ...apply, version: nextVersion, updatedByUserId: actorUserId, updatedAt: clock.now() })
          .where(eq(platformSettings.id, current.id));
      } else {
        try {
          await tx.insert(platformSettings).values({
            settingKey: def.key,
            kind: def.kind,
            valueJson: apply.valueJson ?? null,
            secretEnc: apply.secretEnc ?? null,
            version: nextVersion,
            updatedByUserId: actorUserId,
            createdAt: clock.now(),
            updatedAt: clock.now(),
          });
        } catch (error) {
          if (isDuplicate(error)) throw conflict("VERSION_MISMATCH", "This setting was changed by someone else. Reload and try again.");
          throw error;
        }
      }
      await audit.record(event(current ?? null, nextVersion), tx);
      return nextVersion;
    };
    cache.delete(def.key);
    try {
      return options.tx ? await run(options.tx) : await db.transaction(run);
    } finally {
      cache.delete(def.key);
    }
  }

  function valueEvent(def: AnySettingDefinition, previous: Row | null, next: unknown, version: number): AuditEventInput {
    const oldValue = parseStored(def, previous)?.value;
    const attributes: Record<string, SafeAttributeValue> = { setting_key: def.key, version };
    const oldSafe = auditableScalar(oldValue ?? null);
    const newSafe = auditableScalar(next);
    if (oldSafe !== undefined && newSafe !== undefined) {
      attributes.old_value = oldSafe;
      attributes.new_value = newSafe;
    } else {
      attributes.value_changed = JSON.stringify(oldValue ?? null) !== JSON.stringify(next);
    }
    return {
      category: "admin",
      eventName: def.kind === "flag" ? "platform.feature.changed" : "platform.setting.changed",
      action: "update",
      outcome: "completed",
      severity: def.kind === "flag" ? "WARN" : "INFO",
      resource: { type: "platform_setting" },
      attributes,
    };
  }

  async function view(def: AnySettingDefinition, row: Row | null): Promise<SettingView> {
    const base = {
      key: def.key,
      kind: def.kind,
      group: def.group,
      owner: def.owner,
      label: def.label,
      description: def.description,
      sensitivity: def.sensitivity,
      exportable: def.exportable,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
    };
    if (def.kind === "secret") return { ...base, configured: Boolean(row?.secretEnc) };
    const stored = parseStored(def, row);
    return {
      ...base,
      value: stored?.valid ? stored.value : def.default,
      defaultValue: def.default,
      configured: stored !== undefined,
      invalidStored: stored !== undefined && !stored.valid,
    };
  }

  const store: PlatformSettingsStore = {
    async get<T>(key: string, parse: (raw: unknown) => T, fallback: T, tx?: Tx): Promise<T> {
      const def = getSettingDefinition(key);
      if (def?.kind === "secret") return fallback;
      const row = await loadRow(key, tx);
      if (!row || row.valueJson === null || row.valueJson === undefined) return fallback;
      try {
        if (def) def.schema.parse(row.valueJson);
        return parse(row.valueJson);
      } catch {
        log.warn("platform.setting.invalid_stored_value", { settingKey: key });
        return fallback;
      }
    },

    async set(key, value, tx) {
      await store.update(key, value, { tx });
    },

    async getSecret(key: string, tx?: Tx) {
      const def = requireDefinition(key);
      if (def.kind !== "secret") throw validation("SETTING_KIND_MISMATCH", "That setting is not a secret.");
      const row = await loadRow(key, tx);
      if (!row?.secretEnc) return null;
      try {
        return crypto.decrypt(row.secretEnc, secretAad(key));
      } catch (error) {
        const reasonCode = error instanceof CryptoError ? error.reasonCode : "UNKNOWN";
        log.error("platform.secret.unreadable", { settingKey: key, reasonCode });
        throw new DomainError("UNAVAILABLE", "SECRET_UNREADABLE", "A required configuration secret could not be read.");
      }
    },

    async setSecret(key, value, tx) {
      await store.updateSecret(key, value, { tx });
    },

    async isFeatureEnabled(flag: string, tx?: Tx) {
      const def = getSettingDefinition(flagKey(flag));
      if (!def || def.kind !== "flag") return false;
      const row = await loadRow(def.key, tx);
      return row?.valueJson === true;
    },

    async update(key, value, options = {}) {
      const def = requireDefinition(key);
      if (def.kind === "secret") throw validation("SETTING_KIND_MISMATCH", "Secrets are changed separately.");
      const parsed = def.schema.safeParse(value);
      if (!parsed.success) {
        throw validation("INVALID_SETTING_VALUE", "The value is not valid for this setting.", {
          fields: parsed.error.issues.slice(0, 10).map((issue) => issue.path.join(".") || "_"),
        });
      }
      return write(def, { valueJson: parsed.data }, (previous, version) => valueEvent(def, previous, parsed.data, version), options);
    },

    async updateSecret(key, value, options = {}) {
      const def = requireDefinition(key);
      if (def.kind !== "secret") throw validation("SETTING_KIND_MISMATCH", "That setting is not a secret.");
      let envelope: string | null = null;
      if (value !== null) {
        const parsed = def.schema.safeParse(value);
        if (!parsed.success) throw validation("INVALID_SETTING_VALUE", "The value is not valid for this setting.");
        envelope = crypto.encrypt(parsed.data, secretAad(key));
      }
      return write(
        def,
        { secretEnc: envelope, valueJson: null },
        (_previous, version) => ({
          category: "security",
          eventName: "platform.secret.changed",
          action: value === null ? "delete" : "update",
          outcome: "completed",
          severity: "WARN",
          resource: { type: "platform_setting" },
          attributes: { setting_key: def.key, configured: value !== null, version },
        }),
        options,
      );
    },

    async setFeature(flag, enabled, options = {}) {
      const def = getSettingDefinition(flagKey(flag));
      if (!def || def.kind !== "flag") throw validation("UNKNOWN_SETTING", "That feature does not exist.");
      return store.update(def.key, enabled, options);
    },

    async describe(filter = {}) {
      const rows = await loadAll();
      const defs = listSettingDefinitions().filter(
        (def) => (!filter.group || def.group === filter.group) && (!filter.kinds || filter.kinds.includes(def.kind)),
      );
      return Promise.all(defs.map((def) => view(def, rows.get(def.key) ?? null)));
    },

    async describeOne(key) {
      const def = requireDefinition(key);
      cache.delete(key);
      return view(def, await loadRow(key));
    },

    async storedValue(key) {
      const def = requireDefinition(key);
      if (def.kind === "secret") throw validation("SETTING_KIND_MISMATCH", "That setting is a secret.");
      const stored = parseStored(def, await loadRow(key));
      return stored?.valid ? stored.value : undefined;
    },

    async warm() {
      const rows = await loadAll();
      const expires = clock.now().getTime() + SETTINGS_CACHE_TTL_MS;
      for (const def of listSettingDefinitions()) cache.set(def.key, { expires, row: rows.get(def.key) ?? null });
    },

    invalidate(key) {
      if (key) cache.delete(key);
      else cache.clear();
    },
  };
  return store;
}

function isDuplicate(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && current !== null && (current as { code?: string }).code === "ER_DUP_ENTRY") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Narrowing helper for consumers holding the core interface. */
export function isPlatformSettingsStore(store: SettingsStore): store is PlatformSettingsStore {
  return typeof (store as Partial<PlatformSettingsStore>).describe === "function";
}
