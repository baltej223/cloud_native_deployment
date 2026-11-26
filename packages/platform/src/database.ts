import { readFileSync } from "node:fs";
import pg from "pg";

export type DatabasePool = pg.Pool;

export type DatabaseSslMode = "disable" | "require" | "verify-full";

export interface DatabaseSettings {
  /** postgres://user@host:port/db — may omit the password. */
  url: string;
  /** Overrides any password in `url`. Kept separate so the URL holds no secret. */
  password?: string;
  /**
   * - `disable`: plain TCP (local Docker Postgres).
   * - `require`: TLS, without verifying the server certificate.
   * - `verify-full`: TLS, verifying the certificate against `caFile` (or system CAs).
   */
  ssl?: DatabaseSslMode;
  caFile?: string;
  /** Maximum connections this process opens. */
  maxConnections?: number;
}

const PLACEHOLDER = /\[YOUR-[A-Z-]+\]/;

/**
 * Combine a password-less connection URL with a separately supplied password.
 * The password is percent-encoded, so any characters are safe.
 */
export function resolveConnectionString(url: string, password?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (password) {
    parsed.password = encodeURIComponent(password);
  } else if (PLACEHOLDER.test(decodeURIComponent(parsed.password))) {
    throw new Error(
      "DATABASE_URL still contains a placeholder password; set DATABASE_PASSWORD instead",
    );
  }
  return parsed.toString();
}

function sslOptions(settings: DatabaseSettings): pg.PoolConfig["ssl"] {
  switch (settings.ssl ?? "disable") {
    case "disable":
      return undefined;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return {
        rejectUnauthorized: true,
        ...(settings.caFile ? { ca: readFileSync(settings.caFile, "utf8") } : {}),
      };
  }
}

export function createPool(settings: DatabaseSettings | string): DatabasePool {
  const config: DatabaseSettings = typeof settings === "string" ? { url: settings } : settings;
  return new pg.Pool({
    connectionString: resolveConnectionString(config.url, config.password),
    ssl: sslOptions(config),
    max: config.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export async function pingDatabase(pool: DatabasePool): Promise<void> {
  await pool.query("SELECT 1");
}
