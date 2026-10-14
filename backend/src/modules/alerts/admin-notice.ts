import { runInTransaction } from '../../infra/db/prisma.js';
import { enqueueOutbox, OUTBOX_EVENT_TYPES } from '../../infra/jobs/index.js';

export const ALERT_SOURCE_BLOCKED = 'ALERT_SOURCE_BLOCKED';

export type BlockedNotice = {
  alertSourceId: string;
  attemptCount: number;
  requestId: string;
};

/**
 * Final stage of the rate-limit ladder: asks (through the outbox, never a direct publish) for all
 * active Admins to be told that the source is blocked. Own small transaction; the payload carries
 * ids and the minimum facts only. Recipients are resolved at delivery (SLICE-09); nothing is
 * written to any incident timeline.
 */
export function writeBlockedNotice(notice: BlockedNotice): Promise<void> {
  return runInTransaction(async (tx) => {
    await enqueueOutbox(tx, {
      eventType: OUTBOX_EVENT_TYPES.NOTIFICATION_REQUESTED,
      aggregateType: 'ALERT_SOURCE',
      aggregateId: notice.alertSourceId,
      payload: {
        kind: ALERT_SOURCE_BLOCKED,
        alertSourceId: notice.alertSourceId,
        attemptCount: notice.attemptCount,
        requestId: notice.requestId,
      },
    });
  });
}
