import type { TransactionClient } from '../../infra/db/prisma.js';
import { enqueueOutbox, OUTBOX_EVENT_TYPES } from '../../infra/jobs/index.js';
import {
  recordNotification,
  type EnqueueNotificationInput,
  type EnqueueNotificationResult,
} from './record-notification.js';

export type { EnqueueNotificationInput, EnqueueNotificationResult };

/**
 * The producer contract of SLICE-09. Called inside the producer's transaction: it never opens or
 * commits one and never touches Redis or the email provider. It resolves the recipients now,
 * stores one `Notification` per occurrence (a repeat returns `created = false`) and, when there is
 * at least one recipient, writes the `NOTIFICATION_REQUESTED` outbox event. The row and the event
 * commit or roll back with the producer's change.
 */
export async function enqueueNotification(
  tx: TransactionClient,
  input: EnqueueNotificationInput,
): Promise<EnqueueNotificationResult> {
  const recorded = await recordNotification(tx, input);

  if (recorded.created && recorded.hasRecipients) {
    await enqueueOutbox(tx, {
      eventType: OUTBOX_EVENT_TYPES.NOTIFICATION_REQUESTED,
      aggregateType: 'NOTIFICATION',
      aggregateId: recorded.notificationId!,
      payload: {
        kind: input.eventType,
        notificationId: recorded.notificationId,
        ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
        ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
        ...(input.alertSourceId === undefined ? {} : { alertSourceId: input.alertSourceId }),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });
  }
  return { notificationId: recorded.notificationId, created: recorded.created };
}
