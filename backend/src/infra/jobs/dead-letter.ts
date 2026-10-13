import { logger } from '../../shared/observability/logger.js';
import type { QueueGateway } from './gateway.js';

/**
 * Adds the dead-letter job after the database record is written. A failure here is logged and
 * swallowed: the `DEAD_LETTER` row in PostgreSQL is the durable record and is never lost.
 */
export async function announceDeadLetter(
  gateway: QueueGateway,
  info: {
    outboxEventId: string;
    eventType: string;
    sourceQueue: string;
    errorClass: string;
    requestId?: string;
  },
): Promise<void> {
  const { requestId, ...job } = info;
  try {
    await gateway.publishDeadLetter(job);
  } catch (err) {
    logger.error(
      { err, ...job, requestId, outcome: 'dead_letter_publish_failed' },
      'Dead-letter job could not be published; the outbox row remains DEAD_LETTER',
    );
  }
}
