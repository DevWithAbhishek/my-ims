import { randomUUID } from 'node:crypto';
import { appendAuditEvent } from '../../src/infra/audit/append-audit-event';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import {
  createIncident,
  createService,
  createTeam,
  createUser,
  resetState,
} from '../helpers/identity';

beforeEach(resetState);
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

async function incidentFixture() {
  const team = await createTeam();
  const admin = await createUser({ role: 'ADMIN', teamId: team.id });
  const service = await createService(team.id, admin.id);
  const incident = await createIncident(team.id, service.id, 'OPEN');
  return { admin, incident };
}

describe('appendAuditEvent', () => {
  it('gives each event of one transaction a strictly later createdAt, in the order written', async () => {
    const { incident, admin } = await incidentFixture();
    const written: number[] = [];
    await runInTransaction(async (tx) => {
      for (let i = 0; i < 300; i += 1) {
        written.push(i);
        await appendAuditEvent(tx, {
          incidentId: incident.id,
          eventType: 'COMMENT_ADDED',
          actorId: admin.id,
          metadata: { i },
        });
      }
    });

    const rows = await getPrisma().auditEvent.findMany({
      where: { incidentId: incident.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows.map((row) => (row.metadata as { i: number }).i)).toEqual(written);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].createdAt.getTime()).toBeGreaterThan(rows[i - 1].createdAt.getTime());
    }
  });

  it('rolls back with the producer transaction', async () => {
    const { incident, admin } = await incidentFixture();
    await expect(
      runInTransaction(async (tx) => {
        await appendAuditEvent(tx, {
          incidentId: incident.id,
          eventType: 'COMMENT_ADDED',
          actorId: admin.id,
          metadata: {},
        });
        throw new Error('producer failed');
      }),
    ).rejects.toThrow('producer failed');
    expect(await getPrisma().auditEvent.count()).toBe(0);
  });

  it('persists the eight administrative event types with incidentId null', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const types = [
      'USER_UPDATED',
      'USER_DEACTIVATED',
      'TEAM_UPDATED',
      'TEAM_DEACTIVATED',
      'SERVICE_UPDATED',
      'SERVICE_DEACTIVATED',
      'ESCALATION_POLICY_UPDATED',
      'ALERT_SOURCE_UPDATED',
    ] as const;
    await runInTransaction(async (tx) => {
      for (const eventType of types) {
        await appendAuditEvent(tx, {
          incidentId: null,
          eventType,
          actorId: eventType === 'ALERT_SOURCE_UPDATED' ? null : admin.id,
          metadata: { entityId: randomUUID(), changedFields: ['name'] },
        });
      }
    });
    const rows = await getPrisma().auditEvent.findMany();
    expect(rows.map((row) => row.eventType).sort()).toEqual([...types].sort());
    expect(rows.every((row) => row.incidentId === null)).toBe(true);
    expect(rows.find((row) => row.eventType === 'ALERT_SOURCE_UPDATED')?.actor).toBeNull();
  });
});
