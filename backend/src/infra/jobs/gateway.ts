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

/** The only door to Redis for business jobs, so tests can replace it. */
export interface QueueGateway {
  publish(queue: QueueName, data: JobData): Promise<void>;
  publishDeadLetter(data: DeadLetterJobData): Promise<void>;
  close(): Promise<void>;
}

/**
 * BullMQ-backed gateway. Jobs use the outbox event id as `jobId` (BullMQ de-duplicates while the
 * job exists), finished jobs are removed (the outbox row is the durable record), and retries use
 * the custom backoff strategy the workers register.
 */
export function createBullmqGateway(connection: Redis, executionAttempts: number): QueueGateway {
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
