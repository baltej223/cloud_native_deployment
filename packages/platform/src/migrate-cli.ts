#!/usr/bin/env node
import { baseEnv, databaseEnv, parseEnv } from "./config.js";
import { createPool, pingDatabase } from "./database.js";
import { databaseSettingsFrom } from "./config.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./migrations.js";
import { errorSummary, retry } from "./retry.js";

const config = parseEnv({ ...baseEnv, ...databaseEnv });
const logger = createLogger("migrate", config.LOG_LEVEL);
const pool = createPool(databaseSettingsFrom(config));

try {
  await retry(() => pingDatabase(pool), {
    attempts: 20,
    onRetry: (error, attempt) =>
      logger.warn({ attempt, err: errorSummary(error) }, "database not ready, retrying"),
  });
  await runMigrations(pool, logger);
} catch (error) {
  logger.error({ err: error }, "migration failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
