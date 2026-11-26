import { pino, type Logger } from "pino";

export type { Logger };

/**
 * Structured JSON logger. Every line carries `service`; job-related lines
 * should also carry `projectId` and `deploymentId` so one deployment can be followed through the logs.
 */
export function createLogger(service: string, level = "info"): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: ["env", "*.env", "password", "*.password"], censor: "[redacted]" },
  });
}
