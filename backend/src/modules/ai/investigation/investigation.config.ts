const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** N1 rate limit (SLICE-12 §4.1; ladder memory and window type owner-approved). */
export const REQUEST_RATE_LIMIT = {
  requestsPerWindow: 3,
  windowMs: MINUTE_MS,
  /** Block per violation; the last step is the final stage, which also repeats for later violations. */
  blockStepsMs: [10 * MINUTE_MS, 20 * MINUTE_MS, 60 * MINUTE_MS, 4 * HOUR_MS, 8 * HOUR_MS],
  /** How long violations are remembered; each violation refreshes it. */
  ladderMemoryMs: DAY_MS,
  /** How long one request owns the right to write the Admin notice of a block. */
  noticeLockMs: 10_000,
} as const;

/** Seconds a client is told to wait when Redis or the database cannot be reached. */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** Investigations (and their evidence) older than this are deleted (SLICE-12 §4.4). */
export const INVESTIGATION_RETENTION_MS = 14 * DAY_MS;
