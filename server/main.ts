/**
 * Process entry point. Owner: integrator (/root).
 *   RP_ROLE=web     HTTP only            (readypackets-portal.service)
 *   RP_ROLE=worker  background jobs only (readypackets-worker.service)
 *   RP_ROLE=all     both in one process  (development / preview)
 */
import path from "node:path";
import { ConfigError, loadConfig } from "./config/env.js";
import { createContainer } from "./container.js";
import { createApp } from "./http/app.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration errors name variables and rules only — never values.
    process.stderr.write(`${error instanceof ConfigError ? error.message : "Configuration could not be loaded."}\n`);
    process.exit(78);
  }
  const container = createContainer(config);
  const { services } = container;
  const log = services.logger.child({ component: "main" });

  // Refuse to serve traffic against an incompatible schema (fail closed).
  await services.platform.assertSchemaContract();

  const shutdownTasks: (() => Promise<void>)[] = [];
  if (config.role === "web" || config.role === "all") {
    const staticDir = process.env.RP_STATIC_DIR ?? path.resolve(import.meta.dirname, "../dist/public");
    const app = createApp(services, { staticDir });
    const server = app.listen(config.port, config.host, () => {
      log.info("http listening", { host: config.host, port: config.port, profile: config.deploymentProfile });
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 30_000;
    server.keepAliveTimeout = 65_000;
    shutdownTasks.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          setTimeout(() => server.closeAllConnections(), 15_000).unref();
        }),
    );
  }
  if (config.role === "worker" || config.role === "all") {
    const worker = await services.jobAdmin.startWorker();
    shutdownTasks.push(() => worker.stop());
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutdown requested", { signal });
    const timer = setTimeout(() => process.exit(1), 30_000);
    timer.unref();
    await Promise.allSettled(shutdownTasks.map((task) => task()));
    await container.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { errorName: reason instanceof Error ? reason.name : "unknown" });
  });
}

void main();
