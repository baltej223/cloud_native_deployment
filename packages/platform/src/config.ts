import { z } from "zod";

/**
 * Environment-variable fragments. Each process composes the fragments it needs
 * and validates them once at startup, so misconfiguration fails fast with a
 * readable message instead of surfacing later as a connection error.
 */
export const baseEnv = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
};

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== "" ? value : undefined));

export const databaseEnv = {
  /** Connection URL. Keep the password out of it and set DATABASE_PASSWORD instead. */
  DATABASE_URL: z.string().min(1),
  /** Secret; overrides any password in DATABASE_URL. */
  DATABASE_PASSWORD: optionalString,
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  /** CA certificate (PEM) for DATABASE_SSL=verify-full, e.g. Supabase's or RDS's bundle. */
  DATABASE_SSL_CA_FILE: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * `yes`: use the hosted database in DATABASE_URL and don't start the local
   * postgres container. Empty: use the local container. Compose can only test
   * whether this is set, so any other value is rejected rather than misread.
   */
  USE_SUPABASE: z
    .enum(["", "yes"], {
      errorMap: () => ({ message: 'must be "yes" or empty (use the local postgres container)' }),
    })
    .default(""),
};

/** Database settings from a parsed environment that includes `databaseEnv`. */
export function databaseSettingsFrom(env: {
  USE_SUPABASE?: "" | "yes";
  DATABASE_URL: string;
  DATABASE_PASSWORD?: string;
  DATABASE_SSL: "disable" | "require" | "verify-full";
  DATABASE_SSL_CA_FILE?: string;
  DATABASE_POOL_MAX: number;
}) {
  if (env.USE_SUPABASE === "yes") {
    let host = "";
    try {
      host = new URL(env.DATABASE_URL).hostname;
    } catch {
      // resolveConnectionString reports invalid URLs.
    }
    if (host === "postgres" || host === "localhost" || host === "127.0.0.1") {
      throw new Error(
        "USE_SUPABASE=yes but DATABASE_URL points at the local database; set it to your Supabase URL",
      );
    }
  }
  return {
    url: env.DATABASE_URL,
    password: env.DATABASE_PASSWORD,
    ssl: env.DATABASE_SSL,
    caFile: env.DATABASE_SSL_CA_FILE,
    maxConnections: env.DATABASE_POOL_MAX,
  };
}

export function parseEnv<T extends z.ZodRawShape>(
  shape: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<T>> {
  const result = z.object(shape).safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
