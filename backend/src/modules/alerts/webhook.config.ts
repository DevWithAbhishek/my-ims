const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const WEBHOOK = {
  maxBodyBytes: 1024 * 1024,
  maxAlertsPerRequest: 100,
  timestampToleranceSeconds: 300,
  /**
   * A timestamp is accepted up to 300 s in the past and 300 s in the future, so a signed request
   * stays acceptable for 600 s; the replay record outlives that by a small margin.
   */
  replayTtlSeconds: 610,
  /** Seconds a sender is told to wait when Redis or the database cannot be reached. */
  unavailableRetryAfterSeconds: 5,
} as const;

export const SOURCE_RATE_LIMIT = {
  alertsPerWindow: 15,
  windowMs: MINUTE_MS,
  /** Block per violation: 5 min → 20 min → 45 min → 2 h; the next violation is the final stage. */
  blockStepsMs: [5 * MINUTE_MS, 20 * MINUTE_MS, 45 * MINUTE_MS, 2 * HOUR_MS],
  finalBlockMs: 24 * HOUR_MS,
  /** How long violations are remembered; each violation refreshes it. */
  ladderMemoryMs: 24 * HOUR_MS,
  /** How long one request owns the right to write the Admin notice of a block. */
  noticeLockMs: 10_000,
} as const;
