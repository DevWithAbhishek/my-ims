import { Prisma } from '../../generated/prisma/client.js';
import type { TransactionClient } from '../db/prisma.js';

/** Anything that can run raw SQL: the Prisma client or a transaction handle. */
export type Db = Pick<TransactionClient, '$queryRaw' | '$executeRaw'>;

/**
 * Timestamps in `OutboxEvent` are `timestamp` columns holding UTC, so every comparison and
 * assignment here uses the database clock converted to UTC.
 */
const NOW = Prisma.sql`timezone('UTC', now())`;
const ms = (value: number) => Prisma.sql`(${value}::double precision * interval '1 millisecond')`;

export type ClaimedEvent = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  publishAttemptCount: number;
  executionAttemptCount: number;
  /** The claim's lease expiry as stored, used to prove the claim is still ours on later updates. */
  lease: string;
};

/**
 * Claims up to `batchSize` publishable rows in one statement: `FOR UPDATE SKIP LOCKED` picks rows no
 * other relay holds and the lease is set before the locks are released, so each row has one claimant.
 */
export function claimBatch(
  db: Db,
  batchSize: number,
  claimLeaseMs: number,
): Promise<ClaimedEvent[]> {
  return db.$queryRaw<ClaimedEvent[]>(Prisma.sql`
    UPDATE "OutboxEvent" SET "leaseExpiresAt" = ${NOW} + ${ms(claimLeaseMs)}
    WHERE "id" IN (
      SELECT "id" FROM "OutboxEvent"
      WHERE "status" = 'PENDING'
        AND "availableAt" <= ${NOW}
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${NOW})
      ORDER BY "availableAt", "id"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "eventType", "aggregateType", "aggregateId", "payload",
      "publishAttemptCount", "executionAttemptCount", "leaseExpiresAt"::text AS "lease"`);
}

const holdsClaim = (id: string, lease: string) =>
  Prisma.sql`"id" = ${id}::uuid AND "status" = 'PENDING' AND "leaseExpiresAt"::text = ${lease}`;

/** The job is in BullMQ: `PENDING → PROCESSING` if the claim is still ours. */
export async function markPublished(
  db: Db,
  id: string,
  lease: string,
  processingWindowMs: number,
): Promise<boolean> {
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "OutboxEvent" SET "status" = 'PROCESSING', "publishedAt" = ${NOW},
      "publishAttemptCount" = "publishAttemptCount" + 1,
      "leaseExpiresAt" = ${NOW} + ${ms(processingWindowMs)},
      "errorClass" = NULL, "lastError" = NULL
    WHERE ${holdsClaim(id, lease)}`);
  return changed > 0;
}

/** Retryable publication failure: stay `PENDING`, release the claim, retry after `delayMs`. */
export async function schedulePublishRetry(
  db: Db,
  args: { id: string; lease: string; delayMs: number; errorClass: string; lastError: string },
): Promise<boolean> {
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "OutboxEvent" SET "publishAttemptCount" = "publishAttemptCount" + 1,
      "errorClass" = ${args.errorClass}, "lastError" = ${args.lastError},
      "leaseExpiresAt" = NULL, "availableAt" = ${NOW} + ${ms(args.delayMs)}
    WHERE ${holdsClaim(args.id, args.lease)}`);
  return changed > 0;
}

/** Non-retryable publication failure: the durable failure record. */
export async function deadLetterUnpublished(
  db: Db,
  args: { id: string; lease: string; errorClass: string; lastError: string },
): Promise<boolean> {
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "OutboxEvent" SET "status" = 'DEAD_LETTER',
      "publishAttemptCount" = "publishAttemptCount" + 1,
      "errorClass" = ${args.errorClass}, "lastError" = ${args.lastError}, "leaseExpiresAt" = NULL
    WHERE ${holdsClaim(args.id, args.lease)}`);
  return changed > 0;
}

/** The worker finished the job: `PROCESSING → SUCCESS`. */
export async function markSuccess(db: Db, id: string): Promise<boolean> {
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "OutboxEvent" SET "status" = 'SUCCESS', "processedAt" = ${NOW}, "leaseExpiresAt" = NULL
    WHERE "id" = ${id}::uuid AND "status" = 'PROCESSING'`);
  return changed > 0;
}

/** A retryable execution failure: count it and keep the row alive until the retry is due. */
export async function recordExecutionRetry(
  db: Db,
  args: {
    id: string;
    delayMs: number;
    processingWindowMs: number;
    errorClass: string;
    lastError: string;
  },
): Promise<boolean> {
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "OutboxEvent" SET "executionAttemptCount" = "executionAttemptCount" + 1,
      "errorClass" = ${args.errorClass}, "lastError" = ${args.lastError},
      "leaseExpiresAt" = ${NOW} + ${ms(args.delayMs)} + ${ms(args.processingWindowMs)}
    WHERE "id" = ${args.id}::uuid AND "status" = 'PROCESSING'`);
  return changed > 0;
}

export type DeadLettered = {
  id: string;
  eventType: string;
  publishAttemptCount: number;
  executionAttemptCount: number;
};

/** Terminal execution failure: `PROCESSING → DEAD_LETTER` with the failure record. */
export async function deadLetterExecution(
  db: Db,
  args: { id: string; errorClass: string; lastError: string },
): Promise<DeadLettered | null> {
  const rows = await db.$queryRaw<DeadLettered[]>(Prisma.sql`
    UPDATE "OutboxEvent" SET "status" = 'DEAD_LETTER',
      "executionAttemptCount" = "executionAttemptCount" + 1,
      "errorClass" = ${args.errorClass}, "lastError" = ${args.lastError}, "leaseExpiresAt" = NULL
    WHERE "id" = ${args.id}::uuid AND "status" = 'PROCESSING'
    RETURNING "id", "eventType", "publishAttemptCount", "executionAttemptCount"`);
  return rows[0] ?? null;
}

/** `PROCESSING` rows whose deadline passed (worker or Redis lost) go back to `PENDING`. */
export function recoverStaleProcessing(db: Db): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE "OutboxEvent" SET "status" = 'PENDING', "availableAt" = ${NOW}, "leaseExpiresAt" = NULL
    WHERE "status" = 'PROCESSING' AND "leaseExpiresAt" < ${NOW}`);
}

/** Deletes finished rows older than the retention window; `DEAD_LETTER` rows are never touched. */
export function deleteExpiredSuccess(db: Db, retentionMs: number): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    DELETE FROM "OutboxEvent"
    WHERE "status" = 'SUCCESS' AND "processedAt" < ${NOW} - ${ms(retentionMs)}`);
}
