import type { TransactionClient } from '../db/prisma.js';
import * as auditModule from './append-audit-event.js';
import { appendAuditEvent } from './append-audit-event.js';

function fakeTx() {
  const created: { eventType: string; createdAt: Date }[] = [];
  const tx = {
    auditEvent: {
      create: ({ data }: { data: { eventType: string; createdAt: Date } }) => {
        created.push(data);
        return Promise.resolve(data);
      },
    },
  } as unknown as TransactionClient;
  return { tx, created };
}

const input = { incidentId: null, actorId: null, metadata: {} } as const;

describe('appendAuditEvent', () => {
  it('stamps each event on one transaction strictly later than the previous one', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { tx, created } = fakeTx();

    await appendAuditEvent(tx, { ...input, eventType: 'ASSIGNED' });
    await appendAuditEvent(tx, { ...input, eventType: 'ACKNOWLEDGED' });
    await appendAuditEvent(tx, { ...input, eventType: 'RESOLVED' });

    expect(created.map((row) => row.createdAt.getTime())).toEqual([
      Date.parse('2026-01-01T00:00:00.000Z'),
      Date.parse('2026-01-01T00:00:00.001Z'),
      Date.parse('2026-01-01T00:00:00.002Z'),
    ]);
    jest.useRealTimers();
  });

  it('follows the clock when it moves past the previous event', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { tx, created } = fakeTx();

    await appendAuditEvent(tx, { ...input, eventType: 'ASSIGNED' });
    jest.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    await appendAuditEvent(tx, { ...input, eventType: 'ACKNOWLEDGED' });

    expect(created[1].createdAt.toISOString()).toBe('2026-01-01T00:00:05.000Z');
    jest.useRealTimers();
  });

  it('keeps separate transactions independent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const first = fakeTx();
    const second = fakeTx();

    await appendAuditEvent(first.tx, { ...input, eventType: 'ASSIGNED' });
    await appendAuditEvent(first.tx, { ...input, eventType: 'ACKNOWLEDGED' });
    await appendAuditEvent(second.tx, { ...input, eventType: 'ASSIGNED' });

    expect(second.created[0].createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    jest.useRealTimers();
  });

  it('is the only export of the audit store: append-only, no update or delete path', () => {
    expect(Object.keys(auditModule)).toEqual(['appendAuditEvent']);
  });
});
