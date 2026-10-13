import { classifyError } from './errors.js';

/** `base * 2^(attempt - 1)`, capped. `attempt` is 1-based (1 = the first failure). */
export function exponentialBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/** Delay before execution retry number `attempt`; a provider-supplied delay is never shortened. */
export function executionRetryDelayMs(
  attempt: number,
  error: unknown,
  config: { executionBackoffBaseMs: number; executionBackoffCapMs: number },
): number {
  const scheduled = exponentialBackoffMs(
    attempt,
    config.executionBackoffBaseMs,
    config.executionBackoffCapMs,
  );
  const providerDelay = classifyError(error).retryAfterMs;
  return providerDelay === undefined ? scheduled : Math.max(scheduled, providerDelay);
}
