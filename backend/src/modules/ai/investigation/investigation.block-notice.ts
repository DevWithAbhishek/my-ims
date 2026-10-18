import { runInTransaction } from '../../../infra/db/prisma.js';
import { enqueueNotification } from '../../notifications/index.js';
import type { BlockNotice } from './investigation.rate-limit.js';

export type BlockNoticeContext = {
  userId: string;
  teamId: string;
  incidentId: string;
  requestId?: string;
  notice: BlockNotice;
};

/**
 * N1 Admin notice (SLICE-12 §4.5): `INVESTIGATION_REQUEST_BLOCKED` to all active Admins. The block
 * window (the user and the instant the block started) is the occurrence, so a repeat within the
 * same block is recorded once. The notification is keyed on the requester's team, the only entity
 * the request has; nothing is written to an incident timeline.
 */
export async function writeBlockNotice(context: BlockNoticeContext): Promise<void> {
  await runInTransaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: context.userId },
      select: { name: true },
    });
    await enqueueNotification(tx, {
      eventType: 'INVESTIGATION_REQUEST_BLOCKED',
      occurrenceId: `${context.userId}-${context.notice.startedAtMs}`,
      teamId: context.teamId,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      details: {
        userId: context.userId,
        ...(user === null ? {} : { userName: user.name }),
        attemptCount: context.notice.attemptCount,
        latestAction: `Requested an investigation of incident ${context.incidentId}`,
      },
    });
  });
}
