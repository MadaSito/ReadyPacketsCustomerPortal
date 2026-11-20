/**
 * Shared minimal runtime harness for offline/CLI backup & disaster-recovery scripts.
 * Owner: recovery_ops_engineer.
 *
 * Security rules:
 *  - Secrets and connection strings come strictly from environment / `*_FILE` (never `argv`).
 *  - Any flag resembling `--key`, `--password`, `--secret`, or `--database-url` on `argv` is refused immediately.
 *  - Diagnostic output prints only fixed reason codes and safe identifiers — never driver messages or secrets.
 */
import { ConfigError, loadConfig } from "../../../server/config/env.js";
import type { ModuleDeps, Services } from "../../../server/container.js";
import { systemClock } from "../../../server/core/clock.js";
import { DomainError } from "../../../server/core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../../server/core/requestContext.js";
import type { CoreDeps, JobQueue, Mailer, RateLimiter } from "../../../server/core/types.js";
import { createDatabase } from "../../../server/db/client.js";
import { createAuditEmitter } from "../../../server/modules/audit/emitter.js";
import { createBackupModule, type BackupModule } from "../../../server/modules/backup/index.js";
import "../../../server/modules/backup/settings.js";
import { createObjectStorage } from "../../../server/modules/files/storage.js";
import { createSettingsStore } from "../../../server/modules/platform/settingsStore.js";
import { createLogger } from "../../../server/observability/logger.js";
import { createFieldCrypto } from "../../../server/security/fieldCrypto.js";

const FORBIDDEN_SECRET_FLAGS = /^--(password|secret|key|backup-key|database-url)(=|$)/i;

export function assertNoSecretsInArgv(argv: readonly string[]): void {
  for (const arg of argv) {
    if (FORBIDDEN_SECRET_FLAGS.test(arg)) {
      throw new ConfigError(
        "ARGV",
        "Secrets and database URLs must never be passed on the command line; use environment variables or 0600 *_FILE files.",
      );
    }
  }
}

export async function withBackupCliRuntime<T>(fn: (backup: BackupModule) => Promise<T>): Promise<T> {
  const config = loadConfig(process.env);
  const clock = systemClock;
  const logger = createLogger(config, { component: "ops.backup.cli" });
  const dbHandle = createDatabase(config.databaseUrl, 4);

  try {
    const crypto = createFieldCrypto(config);
    const audit = createAuditEmitter({
      config,
      db: dbHandle.db,
      clock,
      logger,
      crypto,
    });
    const settings = createSettingsStore({
      db: dbHandle.db,
      clock,
      logger,
      crypto,
      audit,
    });
    const storage = createObjectStorage({ config, logger });

    const noopJobs: JobQueue = {
      register() {},
      registerSchedule() {},
      async enqueue() {
        return { jobId: "cli_noop" };
      },
    };
    const noopMailer: Mailer = {
      registerTemplate() {},
      async enqueue() {},
    };
    const noopLimiter: RateLimiter = {
      async consume() {
        return { allowed: true, retryAfterSeconds: 0 };
      },
    };

    const core: CoreDeps = {
      config,
      db: dbHandle.db,
      clock,
      logger,
      audit,
      crypto,
      settings,
      mailer: noopMailer,
      jobs: noopJobs,
      storage,
      rateLimiter: noopLimiter,
    };
    const services = { ...core } as Services;
    const deps: ModuleDeps = { ...core, services };
    const backup = createBackupModule(deps);
    services.backup = backup;

    return await runWithRequestContext(newRequestContext("cli"), () => fn(backup));
  } finally {
    await dbHandle.close().catch(() => undefined);
  }
}

export function handleCliError(operation: string, error: unknown): number {
  if (error instanceof ConfigError) {
    console.error(
      JSON.stringify({
        ok: false,
        operation,
        errorCode: "CONFIGURATION_ERROR",
        reasonCode: "INVALID_CONFIGURATION",
      }),
    );
    return 78;
  }
  if (error instanceof DomainError) {
    console.error(
      JSON.stringify({
        ok: false,
        operation,
        errorCode: error.code,
        reasonCode: error.reasonCode,
        message: error.message,
      }),
    );
    return error.code === "NOT_CONFIGURED" ? 78 : 1;
  }
  console.error(
    JSON.stringify({
      ok: false,
      operation,
      errorCode: "INTERNAL",
      reasonCode: "UNEXPECTED_CLI_FAILURE",
    }),
  );
  return 1;
}
