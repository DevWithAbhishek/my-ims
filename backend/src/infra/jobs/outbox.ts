import type { Prisma } from '../../generated/prisma/client.js';
import type { TransactionClient } from '../db/prisma.js';
import { isOutboxEventType, validatePayload } from './events.js';

export type EnqueueOutboxInput = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  availableAt?: Date;
};

/** Thrown to the producer when the event or its payload is not acceptable; nothing is written. */
export class OutboxContractError extends Error {
  constructor(
    readonly reason: 'UNSUPPORTED_EVENT_TYPE' | 'INVALID_PAYLOAD' | 'INVALID_AGGREGATE',
    message: string,
  ) {
    super(message);
    this.name = 'OutboxContractError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Writes one `PENDING` outbox row on the caller's transaction. It never commits, opens a
 * transaction or touches Redis: the row exists exactly when the producer's change commits.
 */
export async function enqueueOutbox(
  tx: TransactionClient,
  input: EnqueueOutboxInput,
): Promise<string> {
  if (!isOutboxEventType(input.eventType)) {
    throw new OutboxContractError('UNSUPPORTED_EVENT_TYPE', 'Unsupported outbox event type');
  }
  if (!UUID.test(input.aggregateId)) {
    throw new OutboxContractError('INVALID_AGGREGATE', 'aggregateId must be a UUID');
  }
  const checked = validatePayload(input.eventType, input.payload);
  if (!checked.ok) {
    throw new OutboxContractError(
      'INVALID_PAYLOAD',
      `Invalid payload for ${input.eventType}: ${checked.fields.join(', ')}`,
    );
  }

  const row = await tx.outboxEvent.create({
    data: {
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: checked.payload as Prisma.InputJsonObject,
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
    },
    select: { id: true },
  });
  return row.id;
}
