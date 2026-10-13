import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditEventType } from '../../generated/prisma/enums.js';
import type { TransactionClient } from '../db/prisma.js';

export type AuditEventInput = {
  incidentId: string | null;
  eventType: AuditEventType;
  actorId: string | null;
  metadata: Prisma.InputJsonObject;
};

/** Last `createdAt` (epoch ms) handed out per transaction handle. */
const lastCreatedAt = new WeakMap<TransactionClient, number>();

/**
 * The event's `createdAt`: the current time, but always at least 1 ms after the previous event
 * written on the same transaction. The database default would be the transaction start time and
 * the column has millisecond precision, so without this events of one command could tie.
 */
function nextCreatedAt(tx: TransactionClient): Date {
  const previous = lastCreatedAt.get(tx) ?? Number.NEGATIVE_INFINITY;
  const next = Math.max(Date.now(), previous + 1);
  lastCreatedAt.set(tx, next);
  return new Date(next);
}

/**
 * Appends one audit event on the caller's transaction, so it commits or rolls back with the change
 * it describes. It never opens or commits a transaction and offers no update or delete path.
 * Events written by one command appear in the order written.
 */
export async function appendAuditEvent(tx: TransactionClient, input: AuditEventInput) {
  await tx.auditEvent.create({
    data: {
      eventType: input.eventType,
      actor: input.actorId,
      incidentId: input.incidentId,
      metadata: input.metadata,
      createdAt: nextCreatedAt(tx),
    },
  });
}
