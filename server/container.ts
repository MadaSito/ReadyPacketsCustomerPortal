/**
 * COMPOSITION ROOT. Owner: integrator (/root). Do not edit; ask /root for changes.
 *
 * Construction order (each layer may use only the layers above it):
 *   1. config, clock, logger, database
 *   2. crypto                         (platform: server/security/fieldCrypto.ts)
 *   3. audit emitter                  (audit:    server/modules/audit/emitter.ts)
 *   4. settings store                 (platform: server/modules/platform/settingsStore.ts)
 *   5. rate limiter, object storage, job queue, mailer
 *   6. domain modules — every factory receives `ModuleDeps` = CoreDeps + `services`
 *
 * `deps.services` is the fully-typed registry of all modules. It is populated as factories return, so a
 * factory MUST NOT dereference `deps.services.<module>` while it is being constructed — only inside
 * methods called later. This keeps cross-module dependencies explicit, typed and cycle-safe
 * (identity ⇄ assurance, files → orders, …) without ordering hazards.
 */
import type { AppConfig } from "./config/env.js";
import { systemClock } from "./core/clock.js";
import type { Clock, CoreDeps, Db, Logger, MaintainableRateLimiter, ModuleLifecycle, SessionResolver } from "./core/types.js";
import { createDatabase, type DatabaseHandle } from "./db/client.js";
import { createLogger } from "./observability/logger.js";
import { createFieldCrypto } from "./security/fieldCrypto.js";
import { createRateLimiter } from "./security/rateLimiter.js";
import { createAuditEmitter } from "./modules/audit/emitter.js";
import { createSettingsStore } from "./modules/platform/settingsStore.js";
import { createJobQueue, createMailer } from "./modules/jobs/queue.js";
import { createObjectStorage } from "./modules/files/storage.js";
import { createIdentityModule, type IdentityModule } from "./modules/identity/index.js";
import { createAssuranceModule, type AssuranceModule } from "./modules/assurance/index.js";
import { createOrdersModule, type OrdersModule } from "./modules/orders/index.js";
import { createFilesModule, type FilesModule } from "./modules/files/index.js";
import { createEngagementModule, type EngagementModule } from "./modules/engagement/index.js";
import { createComplianceModule, type ComplianceModule } from "./modules/compliance/index.js";
import { createAuditModule, type AuditModule } from "./modules/audit/index.js";
import { createSiemModule, type SiemModule } from "./modules/siem/index.js";
import { createPlatformModule, type PlatformModule } from "./modules/platform/index.js";
import { createJobsModule, type JobsModule } from "./modules/jobs/index.js";
import { createPortableModule, type PortableModule } from "./modules/portable/index.js";
import { createBackupModule, type BackupModule } from "./modules/backup/index.js";
import { createIntegrationsModule, type IntegrationsModule } from "./modules/integrations/index.js";
import { createStorageModule, type StorageModule } from "./modules/storage/index.js";
import { registerStorageOAuthAdapters } from "./modules/storage/oauth/register.js";
import { createSharepointModule, type SharepointModule } from "./modules/sharepoint/index.js";
import { createMailTemplatesModule, type MailTemplatesModule } from "./modules/mailTemplates/index.js";
import { createAutomationsModule, type AutomationsModule } from "./modules/automations/index.js";
import { createProtectionModule, type ProtectionModule } from "./modules/protection/index.js";

export interface ModuleRegistry {
  identity: IdentityModule;
  assurance: AssuranceModule;
  orders: OrdersModule;
  files: FilesModule;
  engagement: EngagementModule;
  compliance: ComplianceModule;
  /** The audit MODULE (audit center). `services.audit` is the AuditEmitter from CoreDeps. */
  auditCenter: AuditModule;
  siem: SiemModule;
  platform: PlatformModule;
  /** The jobs MODULE (administration, scheduler, worker). `services.jobs` is the JobQueue from CoreDeps. */
  jobAdmin: JobsModule;
  portable: PortableModule;
  backup: BackupModule;
  integrations: IntegrationsModule;
  storageConnections: StorageModule;
  sharepoint: SharepointModule;
  mailTemplates: MailTemplatesModule;
  automations: AutomationsModule;
  protection: ProtectionModule;
}

/** Everything a request handler can reach: infrastructure + every module. */
export type Services = CoreDeps &
  ModuleRegistry & {
    /** All modules, populated after construction (platform health aggregation iterates this). */
    allModules: readonly ModuleLifecycle[];
    /** Provided by the identity module (`IdentityModule.sessionResolver`). */
    sessionResolver: SessionResolver;
  };

/** What every module factory receives. */
export type ModuleDeps = CoreDeps & { services: Services };

export interface ContainerOverrides {
  db?: Db;
  clock?: Clock;
  logger?: Logger;
  /** Replace any infrastructure piece (tests). */
  core?: Partial<CoreDeps>;
}

export interface Container {
  services: Services;
  /** Every module, for health aggregation. */
  modules: readonly ModuleLifecycle[];
  close(): Promise<void>;
}

export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? createLogger(config);
  let handle: DatabaseHandle | undefined;
  const db = overrides.db ?? (handle = createDatabase(config.databaseUrl, config.databasePoolSize)).db;

  const crypto = overrides.core?.crypto ?? createFieldCrypto(config);
  const audit = overrides.core?.audit ?? createAuditEmitter({ config, db, clock, logger, crypto });
  const settings = overrides.core?.settings ?? createSettingsStore({ db, clock, logger, crypto, audit });
  const rateLimiter = overrides.core?.rateLimiter ?? createRateLimiter({ db, clock, logger, settings, tokenHashKey: config.tokenHashKey, protectionDisabled: config.protectionDisabled });
  const storage = overrides.core?.storage ?? createObjectStorage({ config, logger });
  const queueDeps = { config, db, clock, logger, audit, crypto, settings };
  const jobs = overrides.core?.jobs ?? createJobQueue(queueDeps);
  const mailer = overrides.core?.mailer ?? createMailer({ ...queueDeps, jobs });
  if (!overrides.core?.rateLimiter && "registerMaintenance" in rateLimiter) {
    (rateLimiter as MaintainableRateLimiter).registerMaintenance(jobs);
  }

  const core: CoreDeps = { config, db, clock, logger, audit, crypto, settings, mailer, jobs, storage, rateLimiter };
  const services = { ...core } as Services;
  const deps: ModuleDeps = { ...core, services };

  services.platform = createPlatformModule(deps);
  services.auditCenter = createAuditModule(deps);
  services.jobAdmin = createJobsModule(deps);
  services.identity = createIdentityModule(deps);
  services.assurance = createAssuranceModule(deps);
  services.orders = createOrdersModule(deps);
  services.files = createFilesModule(deps);
  services.engagement = createEngagementModule(deps);
  services.compliance = createComplianceModule(deps);
  services.siem = createSiemModule(deps);
  services.portable = createPortableModule(deps);
  services.backup = createBackupModule(deps);
  services.integrations = createIntegrationsModule(deps);
  services.storageConnections = createStorageModule(deps);
  registerStorageOAuthAdapters(services);
  services.sharepoint = createSharepointModule(deps);
  services.mailTemplates = createMailTemplatesModule(deps);
  services.automations = createAutomationsModule(deps);
  services.protection = createProtectionModule(deps);
  services.sessionResolver = {
    // Late-bound so the identity module owns session truth without the container knowing its shape.
    resolve: (credentials) => services.identity.sessionResolver.resolve(credentials),
  };

  // Post-construction hooks: the first point at which modules may touch `deps.services.*`.
  const modules: ModuleLifecycle[] = [
    services.platform,
    services.auditCenter,
    services.jobAdmin,
    services.identity,
    services.assurance,
    services.orders,
    services.files,
    services.engagement,
    services.compliance,
    services.siem,
    services.portable,
    services.backup,
    services.integrations,
    services.storageConnections,
    services.sharepoint,
    services.mailTemplates,
    services.automations,
    services.protection,
  ];
  services.allModules = modules;
  for (const module of modules) module.init?.();

  return {
    services,
    modules,
    async close() {
      await handle?.close();
    },
  };
}
