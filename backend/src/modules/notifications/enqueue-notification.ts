import type { AuditEventType } from '../../generated/prisma/enums.js';
import type { TransactionClient } from '../../infra/db/prisma.js';
import { enqueueOutbox } from '../../infra/jobs/index.js';

/** Producer contract of SLICE-09: what happened (`occurrenceId` = the audit event) and its context. */
export type EnqueueNotificationInput = {
  eventType: AuditEventType;
  occurrenceId: string;
  incidentId?: string;
  serviceId?: string;
  teamId?: string;
  alertSourceId?: string;
  subjectUserId?: string;
};

/**
 * MINIMAL STAND-IN for the SLICE-09 producer contract, created by SLICE-05 because SLICE-09 is not
 * implemented yet (approved by the project owner). It inserts one `ALERT` `Notification` and its
 * `NOTIFICATION_REQUESTED` outbox event on the caller's transaction, once per occurrence
 * (`idempotencyKey` = `<eventType>:<occurrenceId>`).
 *
 * It does NOT resolve recipients: `recipients` stays empty. The recipient rules belong to SLICE-09,
 * which replaces the body of this function and keeps its signature.
 */
export async function enqueueNotification(
  tx: TransactionClient,
  input: EnqueueNotificationInput,
): Promise<string> {
  const notification = await tx.notification.create({
    data: {
      notificationType: 'ALERT',
      idempotencyKey: `${input.eventType}:${input.occurrenceId}`,
      recipients: [],
      incidentId: input.incidentId ?? null,
    },
    select: { id: true },
  });

  await enqueueOutbox(tx, {
    eventType: 'NOTIFICATION_REQUESTED',
    aggregateType: 'NOTIFICATION',
    aggregateId: notification.id,
    payload: {
      kind: input.eventType,
      notificationId: notification.id,
      ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
    },
  });
  return notification.id;
}
