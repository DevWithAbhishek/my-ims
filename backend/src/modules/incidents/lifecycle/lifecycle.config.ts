/**
 * How long a lifecycle transition waits for the incident row lock before it gives up with
 * `409 CONCURRENCY_CONFLICT`. Kept below Prisma's 5 s interactive-transaction timeout, so the
 * lock timeout fires first and the transaction is not aborted for exceeding its own limit.
 */
export const INCIDENT_LOCK_TIMEOUT_MS = 2_000;
