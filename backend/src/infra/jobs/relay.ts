import type { JobsConfig } from '../../config/env.js';
import { logger } from '../../shared/observability/logger.js';
import { getPrisma, runInTransaction } from '../db/prisma.js';
import { exponentialBackoffMs } from './backoff.js';
import { announceDeadLetter } from './dead-letter.js';
import { classifyError, RetryableJobError, sanitizeError } from './errors.js';
import { queueForEvent, isOutboxEventType, validatePayload } from './events.js';
import type { QueueGateway } from './gateway.js';
import {
  claimBatch,
  deadLetterUnpublished,
  markPublished,
  schedulePublishRetry,
  type ClaimedEvent,
} from './outbox.repository.js';

export type RelayConfig = Pick<
  JobsConfig,
  | 'relayBatchSize'
  | 'claimLeaseMs'
  | 'processingWindowMs'
  | 'publishTimeoutMs'
  | 'publishBackoffBaseMs'
  | 'publishBackoffCapMs'
>;

export type RelayCycleResult = {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  /** Rows whose claim expired and was taken over before this relay could update them. */
  lostClaims: number;
};

export function requestIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { requestId } = payload as { requestId?: unknown };
  return typeof requestId === 'string' && requestId.length <= 128 ? requestId : undefined;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RetryableJobError('REDIS_UNAVAILABLE', 'Publishing timed out')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Outcome = 'published' | 'retried' | 'dead_lettered' | 'lost_claim';

/** Publishes one claimed row and records the result. Never throws for a row-level failure. */
async function relayOne(
  row: ClaimedEvent,
  config: RelayConfig,
  gateway: QueueGateway,
): Promise<Outcome> {
  const started = Date.now();
  const db = getPrisma();
  const queue = queueForEvent(row.eventType);
  const requestId = requestIdOf(row.payload);
  const fields = {
    outboxEventId: row.id,
    jobId: row.id,
    eventType: row.eventType,
    queue,
    requestId,
    publishAttempt: row.publishAttemptCount + 1,
    executionAttempts: row.executionAttemptCount,
  };

  const deadLetter = async (errorClass: string, lastError: string): Promise<Outcome> => {
    const won = await deadLetterUnpublished(db, {
      id: row.id,
      lease: row.lease,
      errorClass,
      lastError,
    });
    if (!won) return 'lost_claim';
    logger.error(
      {
        ...fields,
        errorClass,
        retryable: false,
        outcome: 'dead_letter',
        durationMs: Date.now() - started,
      },
      'Outbox event dead-lettered at publication',
    );
    await announceDeadLetter(gateway, {
      outboxEventId: row.id,
      eventType: row.eventType,
      sourceQueue: queue ?? 'unknown',
      errorClass,
      requestId,
    });
    return 'dead_lettered';
  };

  if (!queue || !isOutboxEventType(row.eventType)) {
    return deadLetter('UNSUPPORTED_EVENT_TYPE', 'Unsupported event type');
  }
  const checked = validatePayload(row.eventType, row.payload);
  if (!checked.ok) {
    return deadLetter('INVALID_PAYLOAD', `Invalid payload fields: ${checked.fields.join(', ')}`);
  }

  try {
    await withTimeout(
      gateway.publish(queue, {
        outboxEventId: row.id,
        eventType: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: checked.payload,
      }),
      config.publishTimeoutMs,
    );
  } catch (error) {
    // Publication is retried without a maximum: a Redis outage must never dead-letter work.
    const errorClass = classifyError(error).errorClass;
    const delayMs = exponentialBackoffMs(
      row.publishAttemptCount + 1,
      config.publishBackoffBaseMs,
      config.publishBackoffCapMs,
    );
    const scheduled = await schedulePublishRetry(db, {
      id: row.id,
      lease: row.lease,
      delayMs,
      errorClass,
      lastError: sanitizeError(error),
    });
    logger.warn(
      {
        ...fields,
        errorClass,
        retryable: true,
        retryInMs: delayMs,
        outcome: 'publish_retry_scheduled',
        durationMs: Date.now() - started,
      },
      'Outbox publication failed; will retry',
    );
    return scheduled ? 'retried' : 'lost_claim';
  }

  const marked = await markPublished(db, row.id, row.lease, config.processingWindowMs);
  logger.info(
    {
      ...fields,
      outcome: marked ? 'published' : 'published_claim_lost',
      durationMs: Date.now() - started,
    },
    'Outbox event published',
  );
  return marked ? 'published' : 'lost_claim';
}

/** One relay pass: claim a batch in a short transaction, then publish it outside any transaction. */
export async function runRelayCycle(
  config: RelayConfig,
  gateway: QueueGateway,
): Promise<RelayCycleResult> {
  const claimed = await runInTransaction((tx) =>
    claimBatch(tx, config.relayBatchSize, config.claimLeaseMs),
  );

  const outcomes = await Promise.all(
    claimed.map(async (row) => {
      try {
        return await relayOne(row, config, gateway);
      } catch (err) {
        // A database failure while recording the result: the lease expires and the row is reclaimed.
        logger.error(
          { err, outboxEventId: row.id, eventType: row.eventType, outcome: 'relay_update_failed' },
          'Could not record the publication result',
        );
        return 'lost_claim' as const;
      }
    }),
  );

  const count = (outcome: Outcome) => outcomes.filter((o) => o === outcome).length;
  return {
    claimed: claimed.length,
    published: count('published'),
    retried: count('retried'),
    deadLettered: count('dead_lettered'),
    lostClaims: count('lost_claim'),
  };
}
