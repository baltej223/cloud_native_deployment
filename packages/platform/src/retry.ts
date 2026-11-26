import { setTimeout as sleep } from "node:timers/promises";

export interface RetryOptions {
  attempts: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Retry with exponential backoff. Used for dependency connections at startup. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, initialDelayMs = 500, maxDelayMs = 5_000, onRetry } = options;
  let delay = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      onRetry?.(error, attempt, delay);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

export function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
