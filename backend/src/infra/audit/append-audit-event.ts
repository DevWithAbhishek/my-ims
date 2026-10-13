import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditEventType } from '../../generated/prisma/enums.js';
import type { TransactionClient } from '../db/prisma.js';

export type AuditEventInput = {
  incidentId: string | null;
  eventType: AuditEventType;
  actorId: string | null;
  metadata: Prisma.InputJsonObject;
};

/**
 * Appends one audit event on the caller's transaction, so it commits or rolls back with the change
 * it describes. It never opens or commits a transaction and offers no update or delete path.
 */
export async function appendAuditEvent(tx: TransactionClient, input: AuditEventInput) {
  await tx.auditEvent.create({
    data: {
      eventType: input.eventType,
      actor: input.actorId,
      incidentId: input.incidentId,
      metadata: input.metadata,
    },
  });
}
