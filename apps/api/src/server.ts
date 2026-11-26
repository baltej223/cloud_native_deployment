import { LocalRouter, LocalRuntime } from "@cloud-platform/drivers";
import {
  createLogger,
  createPool,
  databaseSettingsFrom,
  errorSummary,
  PostgresProjectRepository,
  retry,
} from "@cloud-platform/platform";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DeploymentController } from "./controller.js";
import { ProjectsService } from "./projects-service.js";

const config = loadConfig();
const logger = createLogger("api", config.LOG_LEVEL);

const pool = createPool(databaseSettingsFrom(config));
const repository = new PostgresProjectRepository(pool);

const runtime = new LocalRuntime({
  socketPath: config.DOCKER_SOCKET,
  network: config.APP_NETWORK || undefined,
  memoryMb: config.APP_MEMORY_MB,
  cpus: config.APP_CPUS,
});
const router = new LocalRouter({
  publicHost: config.APP_PUBLIC_HOST,
  probeVia: config.APP_PROBE_VIA,
  probeHost: config.APP_PROBE_HOST,
});

const readinessChecks = {
  database: () => repository.ping(),
  containerEngine: () => runtime.ping(),
};

// Dependencies may still be starting (especially under Docker Compose).
await retry(() => Promise.all(Object.values(readinessChecks).map((check) => check())), {
  attempts: 30,
  onRetry: (error, attempt, delayMs) =>
    logger.warn({ attempt, delayMs, err: errorSummary(error) }, "dependencies not ready, retrying"),
});
await runtime.prepare();

const app = createApp({
  projects: new ProjectsService(
    repository,
    router,
    { portRange: config.APP_PORT_RANGE, maxProjects: config.MAX_PROJECTS },
    logger,
  ),
  logger,
  allowedOrigins: config.WEB_ORIGIN,
  readinessChecks,
});

const controller = new DeploymentController(repository, runtime, router, logger, {
  intervalMs: config.CONTROLLER_INTERVAL_MS,
  healthTimeoutMs: config.DEPLOY_HEALTH_TIMEOUT_SECONDS * 1000,
  deployTimeoutMs: config.DEPLOY_TIMEOUT_SECONDS * 1000,
});
controller.start();

const server = app.listen(config.API_PORT, "0.0.0.0", () => {
  logger.info({ port: config.API_PORT, driver: config.PLATFORM_DRIVER }, "API listening");
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  server.close();
  // Let the current controller step finish; the next start resumes from the database.
  await controller.stop();
  await pool.end().catch(() => {});
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
