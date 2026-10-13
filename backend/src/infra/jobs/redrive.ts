import { z } from 'zod';
import { logger } from '../../shared/observability/logger.js';
import { lockRowForUpdate, runInTransaction } from '../db/prisma.js';
import { isOutboxEventType, validatePayload } from './events.js';

export class RedriveError extends Error {
  constructor(
    readonly code:
      'INVALID_ID' | 'NOT_FOUND' | 'NOT_DEAD_LETTER' | 'UNSUPPORTED_EVENT_TYPE' | 'INVALID_PAYLOAD',
    message: string,
  ) {
    super(message);
    this.name = 'RedriveError';
  }
}

/**
 * Operator action: returns a `DEAD_LETTER` outbox row to `PENDING` so the relay publishes it again.
 * The row is validated first (it exists, is dead-lettered, its event type is supported and its
 * payload is valid). Business keys are unchanged, so reprocessing stays idempotent.
 */
export async function redriveOutboxEvent(id: string, operator: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) {
    throw new RedriveError('INVALID_ID', 'The outbox event id must be a UUID');
  }

  await runInTransaction(async (tx) => {
    if (!(await lockRowForUpdate(tx, 'OutboxEvent', id))) {
      throw new RedriveError('NOT_FOUND', 'Outbox event not found');
    }
    const row = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
    if (row.status !== 'DEAD_LETTER') {
      throw new RedriveError('NOT_DEAD_LETTER', `Outbox event is ${row.status}, not DEAD_LETTER`);
    }
    if (!isOutboxEventType(row.eventType)) {
      throw new RedriveError('UNSUPPORTED_EVENT_TYPE', 'The event type is not supported');
    }
    if (!validatePayload(row.eventType, row.payload).ok) {
      throw new RedriveError(
        'INVALID_PAYLOAD',
        'The stored payload is not valid for its event type',
      );
    }

    await tx.outboxEvent.update({
      where: { id },
      data: {
        status: 'PENDING',
        availableAt: new Date(),
        leaseExpiresAt: null,
        executionAttemptCount: 0,
      },
    });
  });

  logger.info(
    { outboxEventId: id, operator, redrivenAt: new Date().toISOString(), outcome: 'redriven' },
    'Dead-letter outbox event re-driven',
  );
}
