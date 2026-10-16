import { randomUUID } from 'node:crypto';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import * as auditModule from '../../src/infra/audit/append-audit-event';
import { getRedis } from '../../src/infra/redis/redis';
import { evaluateIncident } from '../../src/modules/incidents/sla-monitoring/sla.evaluate';
import { nextStep } from '../../src/modules/incidents/sla-monitoring/sla.calculator';
import {
  ALL_MILESTONES,
  milestoneKey,
} from '../../src/modules/incidents/sla-monitoring/sla.milestones';
import {
  createSlaEvaluationProcessor,
  createSlaMilestoneProcessor,
  runSlaScan,
} from '../../src/modules/incidents/sla-monitoring';
import * as evaluateModule from '../../src/modules/incidents/sla-monitoring/sla.evaluate';
import {
  findRecordedMilestones,
  findScanCandidates,
  findSlaIncident,
} from '../../src/modules/incidents/sla-monitoring/sla.repository';
import { enqueueNotification } from '../../src/modules/notifications';
import type { DelayedJob, DelayedJobScheduler } from '../../src/infra/jobs/gateway';
import { createIncidentWith } from '../helpers/incidents';
import { createTeam, createUser, resetState } from '../helpers/identity';

const db = () => getPrisma();
const MIN = 60_000;
const T0 = new Date('2026-10-16T10:00:00.000Z');
const at = (ms: number) => () => new Date(T0.getTime() + ms);

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

/** A team with two engineers, a lead, a fallback admin and a service whose policy uses them. */
async function slaWorld(
  overrides: {
    sla?: Partial<{ P1ResponseSlaMinutes: number; P1ResolutionSlaMinutes: number }>;
  } = {},
) {
  const team = await createTeam();
  const eng1 = await createUser({ role: 'ENGINEER', teamId: team.id, name: 'Eng One' });
  const eng2 = await createUser({ role: 'ENGINEER', teamId: team.id, name: 'Eng Two' });
  const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id, name: 'Lead' });
  const admin = await createUser({ role: 'ADMIN', teamId: null, name: 'Fallback Admin' });
  const policy = await db().escalationPolicy.create({
    data: {
      level1Id: eng1.id,
      level2Id: eng2.id,
      level3Id: lead.id,
      fallbackAdminId: admin.id,
    },
  });
  const service = await db().appService.create({
    data: {
      name: `svc-${randomUUID().slice(0, 8)}`,
      teamId: team.id,
      escalationPolicyId: policy.id,
      P0ResponseSlaMinutes: 5,
      P0ResolutionSlaMinutes: 30,
      P1ResponseSlaMinutes: overrides.sla?.P1ResponseSlaMinutes ?? 10,
      P1ResolutionSlaMinutes: overrides.sla?.P1ResolutionSlaMinutes ?? 60,
      P2ResponseSlaMinutes: 30,
      P2ResolutionSlaMinutes: 120,
      P3ResponseSlaMinutes: 60,
      P3ResolutionSlaMinutes: 240,
    },
  });
  const incident = (
    opts: Parameters<typeof createIncidentWith>[0] extends infer O ? Partial<O> : never = {},
  ) => createIncidentWith({ teamId: team.id, serviceId: service.id, createdAt: T0, ...opts });
  return { team, eng1, eng2, lead, admin, policy, service, incident };
}

const audits = (incidentId: string) =>
  db().auditEvent.findMany({ where: { incidentId }, orderBy: { createdAt: 'asc' } });
const auditTypes = async (incidentId: string) => (await audits(incidentId)).map((a) => a.eventType);
const notifications = (incidentId: string) =>
  db().notification.findMany({ where: { incidentId }, orderBy: { createdAt: 'asc' } });
const recordedKeys = async (incidentId: string) =>
  (await notifications(incidentId)).map((n) => n.idempotencyKey).sort();
const outboxNotificationCount = () =>
  db().outboxEvent.count({ where: { eventType: 'NOTIFICATION_REQUESTED' } });

describe('thresholds and the 80 % warning', () => {
  it('records nothing before 80 % of the response window', async () => {
    const w = await slaWorld();
    const incident = await w.incident();

    expect(await evaluateIncident(incident.id, { now: at(8 * MIN - 1) })).toBe(0);
    expect(await notifications(incident.id)).toHaveLength(0);
    expect(await audits(incident.id)).toHaveLength(0);
  });

  it('records the warning once at 80 %: SLA_WARNING audit (kind RESPONSE), WARNING notification, no state change', async () => {
    const w = await slaWorld();
    const incident = await w.incident();

    expect(await evaluateIncident(incident.id, { now: at(8 * MIN) })).toBe(1);
    expect(await evaluateIncident(incident.id, { now: at(9 * MIN) })).toBe(0);

    const events = await audits(incident.id);
    expect(events.map((e) => [e.eventType, e.actor, e.metadata])).toEqual([
      ['SLA_WARNING', null, { kind: 'RESPONSE' }],
    ]);
    const rows = await notifications(incident.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'SLA_WARNING',
      notificationType: 'WARNING',
      idempotencyKey: `SLA_WARNING:${incident.id}:RESPONSE_WARNING`,
    });
    expect(await outboxNotificationCount()).toBe(1);

    const after = await db().incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(after).toMatchObject({ status: 'OPEN', currentAssigneeId: null, severity: 'P1' });
    expect(after.updatedAt).toEqual(incident.updatedAt);
  });

  it('a severity change moves the threshold without resetting the clock', async () => {
    const w = await slaWorld();
    const incident = await w.incident({ severity: 'P3' }); // 60 min response window

    expect(await evaluateIncident(incident.id, { now: at(9 * MIN) })).toBe(0);

    await db().incident.update({ where: { id: incident.id }, data: { severity: 'P0' } }); // 5 min
    // 9 minutes after creation, the P0 window is long over: warning, breach and the escalation chain.
    expect(await evaluateIncident(incident.id, { now: at(9 * MIN) })).toBeGreaterThanOrEqual(2);
    expect(await recordedKeys(incident.id)).toEqual(
      expect.arrayContaining([
        `RESPONSE_BREACH:${incident.id}:RESPONSE_BREACH`,
        `SLA_WARNING:${incident.id}:RESPONSE_WARNING`,
      ]),
    );
    expect(await evaluateIncident(incident.id, { now: at(9 * MIN) })).toBe(0);
  });
});

describe('milestone matrix (audit / notification)', () => {
  it('breach: notification (ALERT) and no audit event; incident unchanged', async () => {
    const w = await slaWorld();
    const incident = await w.incident({ status: 'MITIGATING' }); // only the resolution clock runs

    await evaluateIncident(incident.id, { now: at(60 * MIN + 1) });

    expect(
      (await notifications(incident.id)).map((n) => [n.eventType, n.notificationType]),
    ).toEqual(
      expect.arrayContaining([
        ['SLA_WARNING', 'WARNING'],
        ['RESOLUTION_BREACH', 'ALERT'],
      ]),
    );
    // Only the warning writes an audit event; the breach never does.
    expect(await auditTypes(incident.id)).toEqual(['SLA_WARNING']);
    expect((await audits(incident.id))[0].metadata).toEqual({ kind: 'RESOLUTION' });
    const after = await db().incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(after.status).toBe('MITIGATING');
  });

  it('resolution breach does not escalate and changes no state', async () => {
    const w = await slaWorld();
    const incident = await w.incident({ status: 'ACKNOWLEDGED', acknowledgedAt: T0 });

    await evaluateIncident(incident.id, { now: at(61 * MIN) });

    const types = (await notifications(incident.id)).map((n) => n.eventType).sort();
    expect(types).toEqual(['RESOLUTION_BREACH', 'SLA_WARNING']);
    expect(await auditTypes(incident.id)).toEqual(['SLA_WARNING']);
  });

  it('response breach escalates L1→L2→L3→L4 in policy order with audit + ESCALATED_Ln notification each', async () => {
    const w = await slaWorld();
    const incident = await w.incident();

    await evaluateIncident(incident.id, { now: at(11 * MIN) });

    const events = await audits(incident.id);
    expect(events.map((e) => e.eventType)).toEqual([
      'SLA_WARNING',
      'ESCALATED_L1',
      'ESCALATED_L2',
      'ESCALATED_L3',
      'ESCALATED_L4',
    ]);
    expect(events.every((e) => e.actor === null)).toBe(true);
    expect(
      events.slice(1).map((e) => (e.metadata as { notifiedUser: string }).notifiedUser),
    ).toEqual([w.eng1.id, w.eng2.id, w.lead.id, w.admin.id]);

    const rows = await notifications(incident.id);
    expect(rows.map((n) => n.eventType).sort()).toEqual([
      'ESCALATED_L1',
      'ESCALATED_L2',
      'ESCALATED_L3',
      'ESCALATED_L4',
      'RESPONSE_BREACH',
      'SLA_WARNING',
    ]);
    for (const row of rows.filter((n) => n.eventType.startsWith('ESCALATED_'))) {
      expect(row.notificationType).toBe('WARNING');
      // team members ∪ the policy's fallback admin (recipients per SLICE-09)
      expect([...row.recipients].sort()).toEqual(
        [w.eng1.id, w.eng2.id, w.lead.id, w.admin.id].sort(),
      );
    }
    expect(await outboxNotificationCount()).toBe(6);

    // Escalation never assigns and never changes the state.
    const after = await db().incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(after).toMatchObject({
      status: 'OPEN',
      currentAssigneeId: null,
      acknowledgedById: null,
      acknowledgedTimestamp: null,
      severity: 'P1',
    });
    expect(after.updatedAt).toEqual(incident.updatedAt);

    // The response chain is over: only the two resolution milestones can still be recorded.
    expect(await evaluateIncident(incident.id, { now: at(500 * MIN) })).toBe(2);
    expect(await evaluateIncident(incident.id, { now: at(501 * MIN) })).toBe(0);
  });
});

describe('invalid or deactivated responder', () => {
  it('records ESCALATION_FAILED (notification only), skips the audit event and attempts the next level at once', async () => {
    const w = await slaWorld();
    await db().user.update({ where: { id: w.eng2.id }, data: { status: 'DEACTIVATED' } });
    const incident = await w.incident();

    await evaluateIncident(incident.id, { now: at(11 * MIN) });

    expect(await auditTypes(incident.id)).toEqual([
      'SLA_WARNING',
      'ESCALATED_L1',
      'ESCALATED_L3',
      'ESCALATED_L4',
    ]);
    const failure = (await notifications(incident.id)).find(
      (n) => n.eventType === 'ESCALATION_FAILED',
    );
    expect(failure).toMatchObject({
      notificationType: 'ALERT',
      idempotencyKey: `ESCALATION_FAILED:${incident.id}:ESCALATION_FAILURE_2`,
    });
    expect(
      (await notifications(incident.id)).filter((n) => n.eventType === 'ESCALATED_L2'),
    ).toEqual([]);

    const after = await db().incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(after).toMatchObject({ status: 'OPEN', currentAssigneeId: null, severity: 'P1' });
  });

  it.each([
    ['level1 has the wrong role', 'eng1', { role: 'TEAM_LEAD' as const }],
    ['level3 left the team', 'lead', { teamId: null }],
  ])('%s', async (_name, who, change) => {
    const w = await slaWorld();
    await db().user.update({ where: { id: w[who as 'eng1' | 'lead'].id }, data: change });
    const incident = await w.incident();

    await evaluateIncident(incident.id, { now: at(11 * MIN) });

    const failures = (await notifications(incident.id)).filter(
      (n) => n.eventType === 'ESCALATION_FAILED',
    );
    expect(failures).toHaveLength(1);
    expect((await auditTypes(incident.id)).filter((t) => t.startsWith('ESCALATED_'))).toHaveLength(
      3,
    );
  });

  it('a failure at the last level ends the chain', async () => {
    const w = await slaWorld();
    await db().user.update({ where: { id: w.admin.id }, data: { status: 'DEACTIVATED' } });
    const incident = await w.incident();

    await evaluateIncident(incident.id, { now: at(11 * MIN) });

    expect(await auditTypes(incident.id)).toEqual([
      'SLA_WARNING',
      'ESCALATED_L1',
      'ESCALATED_L2',
      'ESCALATED_L3',
    ]);
    expect(await recordedKeys(incident.id)).toContain(
      `ESCALATION_FAILED:${incident.id}:ESCALATION_FAILURE_4`,
    );
    expect(await evaluateIncident(incident.id, { now: at(12 * MIN) })).toBe(0);
  });

  it('every level failing records one failure per level and nothing else changes', async () => {
    const w = await slaWorld();
    await db().user.updateMany({ data: { status: 'DEACTIVATED' } });
    const incident = await w.incident();

    await evaluateIncident(incident.id, { now: at(11 * MIN) });

    const rows = await notifications(incident.id);
    expect(rows.filter((n) => n.eventType === 'ESCALATION_FAILED')).toHaveLength(4);
    expect(await auditTypes(incident.id)).toEqual(['SLA_WARNING']);
  });
});

describe('stop conditions', () => {
  it.each(['ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const)(
    'no response warning, breach or escalation for an incident that is %s',
    async (status) => {
      const w = await slaWorld();
      const incident = await w.incident({ status, acknowledgedAt: T0 });

      await evaluateIncident(incident.id, { now: at(11 * MIN) });

      const types = (await notifications(incident.id)).map((n) => n.eventType);
      expect(types).not.toContain('RESPONSE_BREACH');
      expect(types.filter((t) => t.startsWith('ESCALATED_'))).toEqual([]);
      expect(await recordedKeys(incident.id)).not.toContain(
        `SLA_WARNING:${incident.id}:RESPONSE_WARNING`,
      );
    },
  );

  it('resolved and closed incidents get no resolution milestones either', async () => {
    const w = await slaWorld();
    const resolved = await w.incident({ status: 'RESOLVED' });
    expect(await evaluateIncident(resolved.id, { now: at(1000 * MIN) })).toBe(0);
  });

  it('escalation resumes from the next unrecorded level, and stops when an acknowledgement committed', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    // A crash left the breach and level 1 recorded.
    await runInTransaction(async (tx) => {
      for (const [eventType, occurrenceId] of [
        ['SLA_WARNING', 'RESPONSE_WARNING'],
        ['RESPONSE_BREACH', 'RESPONSE_BREACH'],
        ['ESCALATED_L1', 'ESCALATION_LEVEL_1'],
      ] as const) {
        await enqueueNotification(tx, { eventType, occurrenceId, incidentId: incident.id });
      }
    });

    await db().incident.update({
      where: { id: incident.id },
      data: { status: 'ACKNOWLEDGED', acknowledgedTimestamp: T0, acknowledgedById: w.eng1.id },
    });
    expect(await evaluateIncident(incident.id, { now: at(11 * MIN) })).toBe(0);

    // An unassign returns it to OPEN against the original deadline: levels 2-4 follow, 1 is not repeated.
    await db().incident.update({
      where: { id: incident.id },
      data: { status: 'OPEN', acknowledgedTimestamp: null, acknowledgedById: null },
    });
    expect(await evaluateIncident(incident.id, { now: at(11 * MIN) })).toBe(3);
    expect(await auditTypes(incident.id)).toEqual(['ESCALATED_L2', 'ESCALATED_L3', 'ESCALATED_L4']);
  });

  it('race: an acknowledgement that commits while the evaluation waits for the lock wins (no escalation)', async () => {
    const w = await slaWorld();
    const incident = await w.incident();

    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => (locked = resolve));
    const acknowledge = runInTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Incident" WHERE "id" = ${incident.id}::uuid FOR UPDATE`;
      locked();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.incident.update({
        where: { id: incident.id },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedTimestamp: new Date(),
          acknowledgedById: w.eng1.id,
        },
      });
    });
    await lockHeld;
    const evaluation = evaluateIncident(incident.id, { now: at(11 * MIN) });
    await Promise.all([acknowledge, evaluation]);

    const types = (await notifications(incident.id)).map((n) => n.eventType);
    expect(types).not.toContain('RESPONSE_BREACH');
    expect(types.filter((t) => t.startsWith('ESCALATED_'))).toEqual([]);
    expect(await auditTypes(incident.id)).toEqual([]);
  });
});

describe('once-only recording', () => {
  it('five concurrent evaluations of one incident produce exactly one record, audit event and notification per milestone', async () => {
    const w = await slaWorld();
    const incident = await w.incident();

    await Promise.all(
      Array.from({ length: 5 }, () => evaluateIncident(incident.id, { now: at(11 * MIN) })),
    );

    const keys = await recordedKeys(incident.id);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
    expect(await auditTypes(incident.id)).toEqual([
      'SLA_WARNING',
      'ESCALATED_L1',
      'ESCALATED_L2',
      'ESCALATED_L3',
      'ESCALATED_L4',
    ]);
    expect(await outboxNotificationCount()).toBe(6);
  });

  it('the database rejects a second insert of the same identity', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    await evaluateIncident(incident.id, { now: at(8 * MIN) });
    const [existing] = await notifications(incident.id);

    await expect(
      db().notification.create({
        data: {
          notificationType: 'WARNING',
          eventType: 'SLA_WARNING',
          idempotencyKey: existing.idempotencyKey,
          recipients: [],
          incidentId: incident.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a delayed job and the scanner for the same milestone record it once', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    const scheduler: DelayedJobScheduler = { scheduleDelayed: async () => undefined };
    const handler = createSlaMilestoneProcessor({ now: at(8 * MIN), scheduler });

    await handler({
      name: 'SLA_MILESTONE',
      data: { incidentId: incident.id, milestone: 'RESPONSE_WARNING' },
      attempt: 1,
    });
    const scan = await runSlaScan({ now: at(8 * MIN) });

    expect(scan).toEqual({ candidates: 0, recorded: 0, failed: 0 });
    expect(await recordedKeys(incident.id)).toHaveLength(1);
    expect(await auditTypes(incident.id)).toEqual(['SLA_WARNING']);
    expect(await outboxNotificationCount()).toBe(1);
  });

  it('is atomic: a failed audit append leaves no notification, no outbox event and no audit event; the retry records once', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    jest.spyOn(auditModule, 'appendAuditEvent').mockRejectedValueOnce(new Error('boom'));

    await expect(evaluateIncident(incident.id, { now: at(8 * MIN) })).rejects.toThrow('boom');
    expect(await notifications(incident.id)).toHaveLength(0);
    expect(await audits(incident.id)).toHaveLength(0);
    expect(await outboxNotificationCount()).toBe(0);

    expect(await evaluateIncident(incident.id, { now: at(8 * MIN) })).toBe(1);
    expect(await recordedKeys(incident.id)).toHaveLength(1);
    expect(await auditTypes(incident.id)).toEqual(['SLA_WARNING']);
  });
});

describe('PostgreSQL scanner (downtime recovery)', () => {
  it('records every overdue milestone once after the delayed jobs were lost, then goes quiet', async () => {
    const w = await slaWorld();
    const incident = await w.incident();

    const first = await runSlaScan({ now: at(11 * MIN) });
    expect(first).toMatchObject({ candidates: 1, failed: 0 });
    expect(first.recorded).toBe(6);
    expect(await auditTypes(incident.id)).toEqual([
      'SLA_WARNING',
      'ESCALATED_L1',
      'ESCALATED_L2',
      'ESCALATED_L3',
      'ESCALATED_L4',
    ]);

    expect(await runSlaScan({ now: at(11 * MIN) })).toEqual({
      candidates: 0,
      recorded: 0,
      failed: 0,
    });
    expect(await recordedKeys(incident.id)).toHaveLength(6);
  });

  it('resumes an interrupted chain from the next unrecorded level', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    await runInTransaction(async (tx) => {
      for (const [eventType, occurrenceId] of [
        ['SLA_WARNING', 'RESPONSE_WARNING'],
        ['RESPONSE_BREACH', 'RESPONSE_BREACH'],
        ['ESCALATED_L1', 'ESCALATION_LEVEL_1'],
        ['ESCALATED_L2', 'ESCALATION_LEVEL_2'],
      ] as const) {
        await enqueueNotification(tx, { eventType, occurrenceId, incidentId: incident.id });
      }
    });

    expect(await runSlaScan({ now: at(12 * MIN) })).toMatchObject({ candidates: 1, recorded: 2 });
    expect(await auditTypes(incident.id)).toEqual(['ESCALATED_L3', 'ESCALATED_L4']);
  });

  it('SQL candidates agree with the pure calculator for every state and moment', async () => {
    const w = await slaWorld();
    const cases: {
      status: 'OPEN' | 'ACKNOWLEDGED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';
      at: number;
    }[] = [];
    for (const status of ['OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const) {
      for (const minutes of [
        0,
        8 * MIN - 1,
        8 * MIN,
        10 * MIN,
        10 * MIN + 1,
        48 * MIN,
        60 * MIN,
        60 * MIN + 1,
      ]) {
        cases.push({ status, at: minutes });
      }
    }

    for (const c of cases) {
      await resetState();
      const w2 = await slaWorld();
      const incident = await w2.incident({
        status: c.status,
        acknowledgedAt: c.status === 'OPEN' ? null : T0,
      });
      const now = at(c.at)();
      const snapshot = (await findSlaIncident(db(), incident.id, { lock: false }))!;
      const recorded = await findRecordedMilestones(db(), incident.id);
      const expected = nextStep(snapshot, now, recorded) !== null;

      const candidates = await findScanCandidates(db(), now);
      expect({ ...c, candidate: candidates.includes(incident.id) }).toEqual({
        ...c,
        candidate: expected,
      });
    }
    expect(w.team.id).toBeDefined();
  });

  it('candidates drop out as soon as each milestone is recorded (one at a time)', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    const now = at(11 * MIN)();
    const present = async () => (await findScanCandidates(db(), now)).includes(incident.id);

    expect(await present()).toBe(true);
    await evaluateIncident(incident.id, { now: () => now });
    expect(await present()).toBe(false);
    // A recorded key survives for every milestone name.
    expect(ALL_MILESTONES.map((m) => milestoneKey(incident.id, m))).toHaveLength(12);
  });

  it('one failing incident does not stop the scan; the next scan retries it until it succeeds', async () => {
    const w = await slaWorld();
    const bad = await w.incident();
    const good = await w.incident({ createdAt: new Date(T0.getTime() + 1000) });
    const real = evaluateModule.evaluateIncident;
    let failBad = true;
    jest.spyOn(evaluateModule, 'evaluateIncident').mockImplementation(async (id, deps) => {
      if (id === bad.id && failBad) throw new Error('transient');
      return real(id, deps);
    });

    const first = await runSlaScan({ now: at(12 * MIN) });
    expect(first.failed).toBe(1);
    expect(await notifications(good.id)).not.toHaveLength(0);
    expect(await notifications(bad.id)).toHaveLength(0);

    failBad = false;
    const second = await runSlaScan({ now: at(12 * MIN) });
    expect(second).toMatchObject({ candidates: 1, failed: 0 });
    expect(await recordedKeys(bad.id)).toHaveLength(6);
  });
});

describe('scheduling of delayed jobs (SLA_EVALUATION_REQUESTED consumer)', () => {
  class RecordingScheduler implements DelayedJobScheduler {
    jobs: DelayedJob[] = [];
    async scheduleDelayed(_queue: string, job: DelayedJob): Promise<void> {
      this.jobs.push(job);
    }
  }
  const run = async (scheduler: RecordingScheduler, incidentId: string, nowMs: number) =>
    createSlaEvaluationProcessor({ scheduler, now: at(nowMs) })({
      outboxEventId: randomUUID(),
      eventType: 'SLA_EVALUATION_REQUESTED',
      aggregateType: 'INCIDENT',
      aggregateId: incidentId,
      payload: { incidentId, requestId: 'req-sla' },
      attempt: 1,
    });

  it('schedules the four milestones at their precise instants with deterministic ids', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    const scheduler = new RecordingScheduler();

    await run(scheduler, incident.id, 0);

    const byId = Object.fromEntries(scheduler.jobs.map((j) => [j.jobId, j.delayMs]));
    expect(byId).toEqual({
      [`sla-${incident.id}-RESPONSE_WARNING`]: 8 * MIN,
      [`sla-${incident.id}-RESPONSE_BREACH`]: 10 * MIN + 1,
      [`sla-${incident.id}-RESOLUTION_WARNING`]: 48 * MIN,
      [`sla-${incident.id}-RESOLUTION_BREACH`]: 60 * MIN + 1,
    });
    expect(scheduler.jobs[0].name).toBe('SLA_MILESTONE');
    expect(scheduler.jobs[0].data).toEqual({
      incidentId: incident.id,
      milestone: 'RESPONSE_WARNING',
    });
  });

  it('after a severity change the same ids are scheduled again with the new delays (replace, not add)', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    const scheduler = new RecordingScheduler();
    await run(scheduler, incident.id, 0);

    await db().incident.update({ where: { id: incident.id }, data: { severity: 'P0' } });
    const second = new RecordingScheduler();
    await run(second, incident.id, 0);

    const delay = (jobs: DelayedJob[], milestone: string) =>
      jobs.find((j) => j.data.milestone === milestone)!.delayMs;
    expect(delay(scheduler.jobs, 'RESPONSE_BREACH')).toBe(10 * MIN + 1);
    expect(delay(second.jobs, 'RESPONSE_BREACH')).toBe(5 * MIN + 1);
    expect(second.jobs.map((j) => j.jobId).sort()).toEqual(
      scheduler.jobs.map((j) => j.jobId).sort(),
    );
  });

  it('records what is already overdue first and schedules only what is still ahead', async () => {
    const w = await slaWorld();
    const incident = await w.incident();
    const scheduler = new RecordingScheduler();

    await run(scheduler, incident.id, 11 * MIN);

    expect(await auditTypes(incident.id)).toContain('ESCALATED_L4');
    expect(scheduler.jobs.map((j) => j.data.milestone).sort()).toEqual([
      'RESOLUTION_BREACH',
      'RESOLUTION_WARNING',
    ]);
  });

  it('schedules no response job for an acknowledged incident and caps an enormous delay', async () => {
    const w = await slaWorld({ sla: { P1ResolutionSlaMinutes: 2_147_483_647 } });
    const incident = await w.incident({ status: 'ACKNOWLEDGED', acknowledgedAt: T0 });
    const scheduler = new RecordingScheduler();

    await run(scheduler, incident.id, 0);

    expect(scheduler.jobs.map((j) => j.data.milestone).sort()).toEqual([
      'RESOLUTION_BREACH',
      'RESOLUTION_WARNING',
    ]);
    expect(scheduler.jobs.every((j) => j.delayMs <= 2_147_483_647)).toBe(true);
  });
});
