import { baseEnv, databaseEnv, parseEnv } from "@cloud-platform/platform";
import { z } from "zod";

const portRange = z
  .string()
  .regex(/^\d+-\d+$/, 'must look like "8001-8050"')
  .transform((value) => {
    const [min, max] = value.split("-").map(Number) as [number, number];
    return { min, max };
  })
  .refine(({ min, max }) => min >= 1024 && max <= 65_535 && min <= max, {
    message: "must be an ascending range within 1024-65535",
  });

export const loadConfig = () =>
  parseEnv({
    ...baseEnv,
    ...databaseEnv,
    API_PORT: z.coerce.number().int().positive().default(3001),
    /** Comma-separated list of browser origins allowed to call the API. */
    WEB_ORIGIN: z
      .string()
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),

    /** Where apps run. Only "local" (Docker on this machine) exists so far. */
    PLATFORM_DRIVER: z.enum(["local"]).default("local"),
    /** Docker API socket, as seen by the API process. */
    DOCKER_SOCKET: z.string().min(1).default("/var/run/docker.sock"),
    /** Network for app containers; empty to use the engine's default network. */
    APP_NETWORK: z.string().default(""),
    /** Ports handed out to apps, one per project. */
    APP_PORT_RANGE: portRange.default("8001-8050"),
    /** Host name used in the app URLs shown to users. */
    APP_PUBLIC_HOST: z.string().min(1).default("localhost"),
    /** How the API reaches apps for health checks; see LocalRouter. */
    APP_PROBE_VIA: z.enum(["network", "host"]).default("host"),
    APP_PROBE_HOST: z.string().min(1).default("127.0.0.1"),
    APP_MEMORY_MB: z.coerce.number().int().min(64).max(4_096).default(512),
    APP_CPUS: z.coerce.number().min(0.1).max(4).default(0.5),
    MAX_PROJECTS: z.coerce.number().int().min(1).max(1_000).default(10),

    /** Where repositories are cloned for builds (one temporary folder per build). */
    BUILD_WORK_DIR: z.string().min(1).default("/tmp/cloud-platform-builds"),
    /** How long a build (clone + docker build) may take. */
    BUILD_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(900),

    /** How often the deployment controller looks for work. */
    CONTROLLER_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),
    /** How long a started app gets to answer its health check before it fails. */
    DEPLOY_HEALTH_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(120),
    /** Upper bound for the deploy step (after any build), including pulling the image. */
    DEPLOY_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(600),
    /** Stop apps that had no network traffic for this long; 0 turns auto-stop off. */
    AUTO_STOP_IDLE_MINUTES: z.coerce.number().int().min(0).default(120),

    /** Admin password for the dashboard; empty turns login off (local development). */
    ADMIN_PASSWORD: z.string().default(""),
    /** Signs session cookies; random per start when empty (sessions end on restart). */
    SESSION_SECRET: z.string().default(""),
    /** Send the session cookie only over HTTPS. */
    SECURE_COOKIES: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  });

export type ApiConfig = ReturnType<typeof loadConfig>;
