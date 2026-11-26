import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { DatabasePool } from "./database.js";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
/** Arbitrary constant; serialises concurrent migration runs. */
const MIGRATION_LOCK_ID = 7_241_998;

/**
 * Apply pending `NNN_name.sql` files in order, each in its own transaction.
 * Applied files are recorded in `schema_migrations` and never re-run.
 */
export async function runMigrations(
  pool: DatabasePool,
  logger: Logger,
  directory = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((row) => row.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(directory, file), "utf8");
      logger.info({ migration: file }, "applying migration");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(file);
    }
    logger.info({ applied: applied.length, total: files.length }, "migrations up to date");
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
