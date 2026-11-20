/**
 * Platform module factory: schema contract, health aggregation, setup state, presentation and
 * configuration transfer. Owner: platform engineer.
 */
import { sql } from "drizzle-orm";
import { DomainError, validation } from "../../core/errors.js";
import { HEALTH_STATES, type HealthState, type ModuleHealth, type ModuleLifecycle } from "../../core/types.js";
import type { ModuleDeps } from "../../container.js";
import type { PlatformFieldCrypto } from "../../security/fieldCrypto.js";
import { createConfigTransfer, type ConfigTransfer } from "./configTransfer.js";
import type { HealthReport, PlatformModule, SchemaStatus, SetupChecklistItem } from "./index.js";
import { createPresentationService, type PresentationService } from "./presentation.js";
import { computeSchemaStatus, schemaContractError } from "./schemaContract.js";
import { PRESENTATION_SLIDES, slidesSchema } from "./settings.js";
import { getSettingDefinition } from "./settingsRegistry.js";
import { isPlatformSettingsStore, type PlatformSettingsStore, type SettingView } from "./settingsStore.js";

export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const READINESS_CACHE_MS = 2_000;
const MODULE_KEYS = [
  "platform",
  "auditCenter",
  "jobAdmin",
  "identity",
  "assurance",
  "orders",
  "files",
  "engagement",
  "compliance",
  "siem",
  "portable",
  "backup",
  "integrations",
] as const;
const COMPONENT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,4}$/;
const CRITICAL_COMPONENTS = new Set(["platform.database", "platform.schema", "platform.keys"]);

export interface PlatformInternals {
  /** Admin settings operations (require the database-backed store). */
  settingsAdmin(): PlatformSettingsStore;
  /** Validated update incl. cross-record checks (e.g. slideshow images exist). */
  updateSetting(key: string, value: unknown, expectedVersion: number): Promise<SettingView>;
  presentationService: PresentationService;
  configTransfer(): ConfigTransfer;
}

export type PlatformModuleImpl = PlatformModule & PlatformInternals;

function isPlatformCrypto(crypto: unknown): crypto is PlatformFieldCrypto {
  return typeof (crypto as Partial<PlatformFieldCrypto>).keyringStatus === "function";
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function overallState(components: readonly ModuleHealth[]): HealthState {
  if (components.some((c) => c.state === "failing")) return "failing";
  if (components.some((c) => c.state === "degraded")) return "degraded";
  return "ok";
}

function sanitizeComponent(component: ModuleHealth, fallbackName: string, now: Date): ModuleHealth {
  const valid =
    typeof component === "object" &&
    component !== null &&
    typeof component.component === "string" &&
    COMPONENT.test(component.component) &&
    (HEALTH_STATES as readonly string[]).includes(component.state) &&
    typeof component.summary === "string";
  if (!valid) return { component: `${fallbackName}.health`, state: "degraded", summary: "Health probe returned an invalid report.", checkedAt: now };
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(component.metrics ?? {}).slice(0, 16)) {
    if (/^[a-z][a-z0-9_]{0,39}$/.test(key) && Number.isFinite(value)) metrics[key] = value;
  }
  return {
    component: component.component,
    state: component.state,
    summary: component.summary.slice(0, 200),
    metrics,
    checkedAt: component.checkedAt instanceof Date ? component.checkedAt : now,
  };
}

export function createPlatformModule(deps: ModuleDeps): PlatformModuleImpl {
  const { db, clock, logger, config, audit, storage } = deps;
  const log = logger.child({ component: "platform" });
  const migrationsDir = config.migrationsDir ?? "migrations";
  let readinessCache: { at: number; value: { ready: boolean; state: HealthState } } | null = null;

  const settingsAdmin = (): PlatformSettingsStore => {
    if (!isPlatformSettingsStore(deps.settings)) {
      throw new DomainError("NOT_CONFIGURED", "SETTINGS_STORE_UNAVAILABLE", "Settings administration is not available.");
    }
    return deps.settings;
  };

  const presentationService = createPresentationService({ db, clock, audit, settings: deps.settings, storage });

  async function schemaStatus(): Promise<SchemaStatus> {
    try {
      return await computeSchemaStatus(db, migrationsDir);
    } catch {
      return { state: "unknown", releaseCount: 0, appliedCount: 0, lastReleaseTag: null };
    }
  }

  async function ownHealth(): Promise<ModuleHealth[]> {
    const now = clock.now();
    const components: ModuleHealth[] = [];
    const started = Date.now();
    const ping = await withTimeout(
      db.execute(sql`select 1`).then(
        () => true,
        () => false,
      ),
      DEFAULT_HEALTH_TIMEOUT_MS,
    );
    components.push({
      component: "platform.database",
      state: ping === true ? "ok" : "failing",
      summary: ping === true ? "Database reachable." : ping === "timeout" ? "Database did not respond in time." : "Database unreachable.",
      metrics: { latency_ms: Date.now() - started },
      checkedAt: now,
    });
    const schema = ping === true ? await schemaStatus() : null;
    components.push({
      component: "platform.schema",
      state: schema?.state === "current" ? "ok" : "failing",
      summary: !schema
        ? "Schema not checked (database unreachable)."
        : schema.state === "current"
          ? "Database schema matches this release."
          : `Database schema does not match this release (${schema.state}).`,
      metrics: { release_migrations: schema?.releaseCount ?? 0, applied_migrations: schema?.appliedCount ?? 0 },
      checkedAt: now,
    });
    if (isPlatformCrypto(deps.crypto)) {
      const ring = deps.crypto.keyringStatus();
      components.push({
        component: "platform.keys",
        state: "ok",
        summary: ring.blindIndexTransition
          ? "Key material loaded; a blind-index transition is in progress."
          : ring.retiredKeyCount > 0
            ? "Key material loaded; retired data keys retained for dual-read."
            : "Key material loaded.",
        metrics: { data_keys: ring.keyIds.length, retired_data_keys: ring.retiredKeyCount, blind_index_transition: ring.blindIndexTransition ? 1 : 0 },
        checkedAt: now,
      });
    } else {
      components.push({ component: "platform.keys", state: "ok", summary: "Key material loaded.", checkedAt: now });
    }
    if (ping === true && isPlatformSettingsStore(deps.settings)) {
      try {
        const views = await deps.settings.describe();
        const invalid = views.filter((view) => view.invalidStored).length;
        components.push({
          component: "platform.settings",
          state: invalid > 0 ? "degraded" : "ok",
          summary: invalid > 0 ? "Some stored settings are invalid; defaults are in effect." : "Settings valid.",
          metrics: { declared: views.length, invalid },
          checkedAt: now,
        });
      } catch {
        components.push({ component: "platform.settings", state: "degraded", summary: "Settings could not be read.", checkedAt: now });
      }
    }
    return components;
  }

  async function healthReport(options: { timeoutMs?: number } = {}): Promise<HealthReport> {
    const timeoutMs = Math.max(100, Math.min(10_000, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS));
    const now = clock.now();
    const services = deps.services;
    const modules: readonly ModuleLifecycle[] = services.allModules ?? [];
    const nameOf = (module: ModuleLifecycle, index: number): string => {
      const key = MODULE_KEYS.find((k) => (services as unknown as Record<string, unknown>)[k] === module);
      return key ? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : `module_${index}`;
    };
    const results = await Promise.all(
      modules.map(async (module, index): Promise<ModuleHealth[]> => {
        const name = nameOf(module, index);
        if (module === self) return ownHealth();
        if (typeof module.health !== "function") return [];
        try {
          const result = await withTimeout(Promise.resolve().then(() => module.health!()), timeoutMs);
          if (result === "timeout") return [{ component: `${name}.health`, state: "failing", summary: "Health probe timed out.", checkedAt: now }];
          if (!Array.isArray(result)) return [{ component: `${name}.health`, state: "degraded", summary: "Health probe returned an invalid report.", checkedAt: now }];
          return result.slice(0, 32).map((component) => sanitizeComponent(component, name, now));
        } catch (error) {
          log.warn("platform.health.probe_failed", { module: name, errorName: error instanceof Error ? error.name : "unknown" });
          return [{ component: `${name}.health`, state: "failing", summary: "Health probe failed.", checkedAt: now }];
        }
      }),
    );
    let components = results.flat();
    if (!modules.includes(self)) components = [...(await ownHealth()), ...components];
    return { state: overallState(components), checkedAt: now, components };
  }

  async function readiness(): Promise<{ ready: boolean; state: HealthState }> {
    const nowMs = clock.now().getTime();
    if (readinessCache && nowMs - readinessCache.at < READINESS_CACHE_MS) return readinessCache.value;
    // Readiness depends ONLY on the platform's own critical components (database, schema, keys): a slow or
    // failing peer module (SMTP, SIEM, backup…) must never take the portal out of the load balancer.
    const own = await ownHealth();
    const criticalFailing = own.some((c) => CRITICAL_COMPONENTS.has(c.component) && c.state === "failing");
    const value = { ready: !criticalFailing, state: overallState(own) };
    readinessCache = { at: nowMs, value };
    return value;
  }

  async function hasAdministrator(): Promise<boolean | null> {
    const identity = deps.services.identity as unknown as { hasActiveAdministrator?: () => Promise<boolean> } | undefined;
    if (!identity || typeof identity.hasActiveAdministrator !== "function") return null;
    try {
      return await identity.hasActiveAdministrator();
    } catch {
      return null;
    }
  }

  async function setupChecklist(): Promise<SetupChecklistItem[]> {
    const report = await healthReport();
    const find = (predicate: (name: string) => boolean) => report.components.filter((c) => predicate(c.component));
    const fromHealth = (components: ModuleHealth[], labels: { missing: string; off: string; ok: string; failing: string }): Pick<SetupChecklistItem, "state" | "summary"> => {
      if (components.length === 0) return { state: "unknown", summary: labels.missing };
      if (components.every((c) => c.state === "not_configured" || c.state === "disabled")) return { state: "not_configured", summary: labels.off };
      if (components.some((c) => c.state === "failing")) return { state: "incomplete", summary: labels.failing };
      return { state: "complete", summary: labels.ok };
    };
    const admin = await hasAdministrator();
    const origin = new URL(config.canonicalOrigin);
    const schema = report.components.find((c) => c.component === "platform.schema");
    const keys = isPlatformCrypto(deps.crypto) ? deps.crypto.keyringStatus() : null;
    const mfaComponents = find((n) => n === "assurance.mfa_policy");
    return [
      {
        id: "admin_exists",
        required: true,
        ...(admin === null
          ? { state: "unknown" as const, summary: "Administrator status could not be determined." }
          : admin
            ? { state: "complete" as const, summary: "At least one active administrator exists." }
            : { state: "incomplete" as const, summary: "No active administrator. Create one with the create-admin command on the server." }),
      },
      {
        id: "mfa_enforced",
        required: true,
        ...(mfaComponents.length > 0
          ? fromHealth(mfaComponents, {
              missing: "",
              off: "Multi-factor policy is reported as not configured.",
              ok: "Multi-factor authentication is mandatory for every local account.",
              failing: "Multi-factor policy reports a problem.",
            })
          : { state: "complete" as const, summary: "Multi-factor authentication is mandatory for every local account by design; there is no setting to turn it off." }),
      },
      {
        id: "canonical_origin",
        required: true,
        ...(origin.protocol === "https:"
          ? { state: "complete" as const, summary: "The portal uses a single HTTPS canonical origin." }
          : { state: "incomplete" as const, summary: "The canonical origin is not HTTPS (development only)." }),
      },
      {
        id: "keys_distinct",
        required: true,
        state: "complete",
        summary: keys && keys.retiredKeyCount > 0
          ? "All keys are present and distinct; retired data keys are retained for reading old records."
          : "All keys are present and distinct (checked at startup).",
      },
      {
        id: "schema",
        required: true,
        ...(schema?.state === "ok"
          ? { state: "complete" as const, summary: "Database schema matches this release." }
          : { state: "incomplete" as const, summary: "Database schema does not match this release." }),
      },
      {
        id: "smtp",
        required: false,
        ...fromHealth(find((n) => n === "mail.smtp"), {
          missing: "Mail delivery status is not reported.",
          off: "Outgoing mail is not configured. Verification and reset e-mails cannot be sent.",
          ok: "Outgoing mail is configured.",
          failing: "Outgoing mail is configured but failing.",
        }),
      },
      {
        id: "backups",
        required: false,
        ...fromHealth(find((n) => n.startsWith("backup.")), {
          missing: "Backup status is not reported.",
          off: "Backups are not configured.",
          ok: "Backups are configured.",
          failing: "Backups are configured but failing.",
        }),
      },
      {
        id: "siem",
        required: false,
        ...fromHealth(find((n) => n.startsWith("siem.")), {
          missing: "Log forwarding status is not reported.",
          off: "Log forwarding to a SIEM or syslog receiver is not configured.",
          ok: "Log forwarding is configured.",
          failing: "Log forwarding is configured but failing.",
        }),
      },
    ];
  }

  async function updateSetting(key: string, value: unknown, expectedVersion: number): Promise<SettingView> {
    const store = settingsAdmin();
    const def = getSettingDefinition(key);
    if (!def) throw validation("UNKNOWN_SETTING", "That setting does not exist.");
    if (def.key === PRESENTATION_SLIDES.key) {
      const parsed = slidesSchema.safeParse(value);
      if (parsed.success) await presentationService.assertSlidesReferenceKnownImages(parsed.data);
    }
    await store.update(key, value, { expectedVersion });
    return store.describeOne(key);
  }

  const self: PlatformModuleImpl = {
    async assertSchemaContract() {
      const status = await computeSchemaStatus(db, migrationsDir).catch(
        (): SchemaStatus => ({ state: "unknown", releaseCount: 0, appliedCount: 0, lastReleaseTag: null }),
      );
      const error = schemaContractError(status);
      if (error) {
        log.error("platform.schema.contract_refused", { state: status.state, releaseCount: status.releaseCount, appliedCount: status.appliedCount });
        audit.note({
          category: "release",
          eventName: "platform.schema.contract.refused",
          action: "verify",
          outcome: "refused",
          severity: "ERROR",
          reasonCode: error.reasonCode,
          actor: { role: "system" },
          safeCounts: { release_migrations: status.releaseCount, applied_migrations: status.appliedCount },
        });
        throw error;
      }
    },
    schemaStatus,
    healthReport,
    readiness,
    async setupStatus() {
      // Fail closed: when unknown, claim an administrator exists so no first-run path is advertised.
      const admin = await hasAdministrator();
      return { administratorExists: admin ?? true };
    },
    setupChecklist,
    async presentation() {
      return presentationService.publicPresentation();
    },
    async health() {
      // Platform's own components are produced by healthReport(); this keeps generic callers working.
      return ownHealth();
    },
    settingsAdmin,
    updateSetting,
    presentationService,
    configTransfer: () =>
      createConfigTransfer({ db, clock, audit, settings: settingsAdmin(), installationId: config.installationId, releaseRef: config.releaseRef }),
  };
  return self;
}
