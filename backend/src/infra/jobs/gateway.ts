import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../../shared/observability/logger.js';
import { DEAD_LETTER_QUEUE, type QueueName } from './events.js';

/** What a BullMQ job carries: the outbox row's identity and its (ids-only) payload. */
export type JobData = {
  outboxEventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
};

/** Describes one dead-lettered outbox event on the shared `dead-letter` queue. */
export type DeadLetterJobData = {
  outboxEventId: string;
  eventType: string;
  sourceQueue: string;
  errorClass: string;
};

/** Job names of delayed jobs start with this prefix; outbox jobs are named after their event type. */
export const DELAYED_JOB_PREFIX = 'delayed.';

/**
 * A job that runs once after `delayMs`, not backed by an outbox row. `jobId` identifies it: while a
 * job with that id waits, scheduling it again replaces it. `data` carries ids only.
 */
export type DelayedJob = {
  jobId: string;
  name: string;
  data: Record<string, string>;
  delayMs: number;
};

/** Schedules delayed jobs (SLICE-07). Redis is never the source of truth for what they decide. */
export interface DelayedJobScheduler {
  scheduleDelayed(queue: QueueName, job: DelayedJob): Promise<void>;
}

/** The only door to Redis for business jobs, so tests can replace it. */
export interface QueueGateway {
  publish(queue: QueueName, data: JobData): Promise<void>;
  publishDeadLetter(data: DeadLetterJobData): Promise<void>;
  close(): Promise<void>;
}

/**
 * BullMQ-backed gateway. Jobs use the outbox event id as `jobId` (BullMQ de-duplicates while the
 * job exists), finished jobs are removed (the outbox row is the durable record), and retries use
 * the custom backoff strategy the workers register. Delayed jobs (no outbox row) are removed when
 * they finish or fail for good, so their id can be scheduled again.
 */
export function createBullmqGateway(
  connection: Redis,
  executionAttempts: number,
): QueueGateway & DelayedJobScheduler {
  const queues = new Map<string, Queue>();

  const queueFor = (name: string): Queue => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection });
      queue.on('error', (err) => logger.warn({ err, queue: name }, 'Queue error'));
      queues.set(name, queue);
    }
    return queue;
  };

  return {
    async publish(queue, data) {
      await queueFor(queue).add(data.eventType, data, {
        jobId: data.outboxEventId,
        attempts: executionAttempts,
        backoff: { type: 'custom' },
        removeOnComplete: true,
        removeOnFail: true,
      });
    },
    async scheduleDelayed(queue, job) {
      const target = queueFor(queue);
      const existing = await target.getJob(job.jobId);
      if (existing) {
        // A job that is running cannot be removed; it re-reads the incident under the lock anyway.
        await existing.remove().catch(() => undefined);
      }
      await target.add(`${DELAYED_JOB_PREFIX}${job.name}`, job.data, {
        jobId: job.jobId,
        delay: job.delayMs,
        attempts: executionAttempts,
        backoff: { type: 'custom' },
        removeOnComplete: true,
        removeOnFail: true,
      });
    },
    async publishDeadLetter(data) {
      await queueFor(DEAD_LETTER_QUEUE).add('DEAD_LETTERED', data, {
        removeOnComplete: true,
      });
    },
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close().catch(() => undefined)));
      queues.clear();
    },
  };
}
