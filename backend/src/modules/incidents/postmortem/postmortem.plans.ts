import type { Plan } from '../lifecycle/lifecycle.types.js';

/**
 * The `RESOLVED → CLOSED` transition shared by P3 and P5: the incident is closed by the caller,
 * and the two audit events are written in this order, `POSTMORTEM_REVIEWED` then `CLOSED`. The
 * kernel adds one notification per event.
 */
export function planClosure(postmortemId: string, reviewerId: string, now: Date): Plan {
  return {
    changes: { status: 'CLOSED', closedById: reviewerId, closedTimestamp: now },
    events: [
      {
        eventType: 'POSTMORTEM_REVIEWED',
        metadata: { postmortemId, reviewedBy: reviewerId },
      },
      { eventType: 'CLOSED', metadata: { closedAt: now.toISOString() } },
    ],
    outbox: [],
  };
}
