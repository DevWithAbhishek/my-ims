import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { JobsConfig } from '../../config/env.js';
import { logger } from '../../shared/observability/logger.js';
import { getPrisma } from '../db/prisma.js';
import { executionRetryDelayMs } from './backoff.js';
import { announceDeadLetter } from './dead-letter.js';
import { classifyError, NonRetryableJobError, sanitizeError } from './errors.js';
import { isOutboxEventType, queueForEvent, validatePayload, type QueueName } from './events.js';
import type { QueueGateway } from './gateway.js';
import { deadLetterExecution, markSuccess, recordExecutionRetry } from './outbox.repository.js';
import type { OutboxProcessor } from './registry.js';
import { requestIdOf } from './relay.js';

export type WorkerConfig = Pick<
  JobsConfig,
  | 'executionAttempts'
  | 'executionBackoffBaseMs'
  | 'executionBackoffCapMs'
  | 'processingWindowMs'
  | 'workerConcurrency'
  | 'queueRateLimits'
>;

const jobDataSchema = z.object({
  outboxEventId: z.uuid(),
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  payload: z.unknown(),
});

type JobLike = Pick<Job, 'data' | 'attemptsMade' | 'opts'>;

/**
 * The common wrapper around every consumer. On success the outbox row becomes `SUCCESS`; on failure
 * the error is classified: retryable errors are counted and rethrown so BullMQ retries (up to the
 * configured attempts); non-retryable errors and the last failed attempt write the `DEAD_LETTER`
 * record first and then announce it on the `dead-letter` queue.
 */
export async function processOutboxJob(
  job: JobLike,
  queue: QueueName,
  processor: OutboxProcessor,
  deps: { config: WorkerConfig; gateway: QueueGateway },
): Promise<void> {
  const parsed = jobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    logger.error(
      { queue, outcome: 'unreadable_job' },
      'Job data does not identify an outbox event',
    );
    throw new UnrecoverableError('Unreadable job data');
  }
  const data = parsed.data;

  const db = getPrisma();
  const started = Date.now();
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? deps.config.executionAttempts;
  const requestId = requestIdOf(data.payload);
  const fields = {
    queue,
    jobId: data.outboxEventId,
    outboxEventId: data.outboxEventId,
    eventType: data.eventType,
    attempt,
    maxAttempts,
    requestId,
  };

  try {
    if (!isOutboxEventType(data.eventType) || queueForEvent(data.eventType) !== queue) {
      throw new NonRetryableJobError('UNSUPPORTED_EVENT_TYPE', 'Unsupported event type');
    }
    const checked = validatePayload(data.eventType, data.payload);
    if (!checked.ok) {
      throw new NonRetryableJobError(
        'INVALID_PAYLOAD',
        `Invalid payload fields: ${checked.fields.join(', ')}`,
      );
    }

    await processor({
      outboxEventId: data.outboxEventId,
      eventType: data.eventType,
      aggregateType: data.aggregateType,
      aggregateId: data.aggregateId,
      payload: checked.payload,
      attempt,
    });
    const marked = await markSuccess(db, data.outboxEventId);
    logger.info(
      {
        ...fields,
        outcome: marked ? 'success' : 'success_row_not_processing',
        durationMs: Date.now() - started,
      },
      'Job completed',
    );
  } catch (error) {
    const { retryable, errorClass } = classifyError(error);
    const lastError = sanitizeError(error);
    const durationMs = Date.now() - started;

    if (!retryable || attempt >= maxAttempts) {
      const record = await deadLetterExecution(db, {
        id: data.outboxEventId,
        errorClass,
        lastError,
      });
      logger.error(
        { ...fields, errorClass, retryable, outcome: 'dead_letter', durationMs },
        'Job dead-lettered',
      );
      if (record) {
        await announceDeadLetter(deps.gateway, {
          outboxEventId: data.outboxEventId,
          eventType: data.eventType,
          sourceQueue: queue,
          errorClass,
          requestId,
        });
      }
      throw new UnrecoverableError(lastError);
    }

    const delayMs = executionRetryDelayMs(attempt, error, deps.config);
    await recordExecutionRetry(db, {
      id: data.outboxEventId,
      delayMs,
      processingWindowMs: deps.config.processingWindowMs,
      errorClass,
      lastError,
    });
    logger.warn(
      {
        ...fields,
        errorClass,
        retryable,
        retryInMs: delayMs,
        outcome: 'retry_scheduled',
        durationMs,
      },
      'Job failed; will retry',
    );
    throw error;
  }
}

/** One BullMQ worker for `queue`, running the common wrapper around `processor`. */
export function createJobWorker(
  queue: QueueName,
  processor: OutboxProcessor,
  deps: { config: WorkerConfig; gateway: QueueGateway },
  connection: Redis,
): Worker {
  const limit = deps.config.queueRateLimits[queue];
  const worker = new Worker(queue, (job) => processOutboxJob(job, queue, processor, deps), {
    connection,
    concurrency: deps.config.workerConcurrency,
    limiter: { max: limit.max, duration: limit.durationMs },
    settings: {
      backoffStrategy: (attemptsMade, _type, error) =>
        executionRetryDelayMs(attemptsMade, error, deps.config),
    },
  });
  worker.on('error', (err) => logger.warn({ err, queue }, 'Worker error'));
  worker.on('stalled', (jobId) => logger.warn({ queue, jobId, outcome: 'stalled' }, 'Job stalled'));
  return worker;
}
