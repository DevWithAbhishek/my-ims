import { planClosure } from './postmortem.plans.js';

describe('planClosure', () => {
  const now = new Date('2026-10-17T12:00:00.000Z');
  const plan = planClosure('pm-1', 'user-1', now);

  it('closes the incident for the caller', () => {
    expect(plan.changes).toEqual({ status: 'CLOSED', closedById: 'user-1', closedTimestamp: now });
    expect(plan.outbox).toEqual([]);
  });

  it('writes POSTMORTEM_REVIEWED and then CLOSED', () => {
    expect(plan.events).toEqual([
      {
        eventType: 'POSTMORTEM_REVIEWED',
        metadata: { postmortemId: 'pm-1', reviewedBy: 'user-1' },
      },
      { eventType: 'CLOSED', metadata: { closedAt: '2026-10-17T12:00:00.000Z' } },
    ]);
  });
});
