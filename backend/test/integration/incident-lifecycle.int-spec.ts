import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { Prisma } from '../../src/generated/prisma/client';
import * as audit from '../../src/infra/audit/append-audit-event';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import * as notifications from '../../src/modules/notifications/enqueue-notification';
import { buildTestApp } from '../helpers/app';
import { bearer, createUser, login, resetState } from '../helpers/identity';
import { createAlertSource, createIncidentWith, incidentWorld } from '../helpers/incidents';
import { testDatabaseUrl } from '../helpers/test-env';

const app = buildTestApp();

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

type Headers = Record<string, string>;
const patch = (token: Headers, id: string, body: unknown) =>
  request(app)
    .patch(`/api/v1/incidents/${id}`)
    .set(token)
    .send(body as object);

/**
 * World of team A whose service has the escalation chain engA (level 1), leadA (levels 2, 3) and
 * adminA (fallback). `engA2` and `adminA2` belong to the team but are outside the chain.
 */
async function lifecycleWorld() {
  const w = await incidentWorld(app);
  const db = getPrisma();
  const engA2 = await createUser({ role: 'ENGINEER', teamId: w.teamA.id, name: 'Erin Engineer' });
  const adminA2 = await createUser({ role: 'ADMIN', teamId: w.teamA.id, name: 'Abe Admin' });
  const inactive = await createUser({
    role: 'ENGINEER',
    teamId: w.teamA.id,
    status: 'DEACTIVATED',
  });
  const policy = await db.escalationPolicy.create({
    data: {
      level1Id: w.engA.id,
      level2Id: w.leadA.id,
      level3Id: w.leadA.id,
      fallbackAdminId: w.adminA.id,
    },
  });
  const service = await db.appService.create({
    data: {
      name: `chain-${randomUUID().slice(0, 8)}`,
      teamId: w.teamA.id,
      escalationPolicyId: policy.id,
      P0ResponseSlaMinutes: 5,
      P0ResolutionSlaMinutes: 30,
      P1ResponseSlaMinutes: 10,
      P1ResolutionSlaMinutes: 60,
      P2ResponseSlaMinutes: 30,
      P2ResolutionSlaMinutes: 120,
      P3ResponseSlaMinutes: 60,
      P3ResolutionSlaMinutes: 240,
    },
  });
  const tokenOf = async (user: { email: string }) => bearer((await login(app, user.email)).token);
  return {
    ...w,
    engA2,
    adminA2,
    inactive,
    service,
    auth: {
      ...w.auth,
      engA2: await tokenOf(engA2),
      adminA2: await tokenOf(adminA2),
    },
  };
}

type World = Awaited<ReturnType<typeof lifecycleWorld>>;
type Status = 'OPEN' | 'ACKNOWLEDGED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';

function incidentIn(
  w: World,
  status: Status,
  extra: { assignee?: string | null; severity?: 'P0' | 'P1' | 'P2' | 'P3'; ackBy?: string } = {},
) {
  return createIncidentWith({
    teamId: w.teamA.id,
    serviceId: w.service.id,
    status,
    severity: extra.severity ?? 'P2',
    currentAssigneeId: extra.assignee ?? null,
    acknowledgedById: extra.ackBy ?? null,
    acknowledgedAt: extra.ackBy ? new Date('2026-01-01T00:00:00.000Z') : null,
  });
}

const eventsOf = (incidentId: string) =>
  getPrisma().auditEvent.findMany({ where: { incidentId }, orderBy: { createdAt: 'asc' } });
const eventTypes = async (incidentId: string) =>
  (await eventsOf(incidentId)).map((event) => event.eventType);
const outbox = (eventType?: string) =>
  getPrisma().outboxEvent.findMany({ where: eventType ? { eventType } : {} });
const reload = (id: string) => getPrisma().incident.findUniqueOrThrow({ where: { id } });

async function nothingWritten(incidentId: string) {
  expect(await eventsOf(incidentId)).toEqual([]);
  expect(await outbox()).toEqual([]);
  expect(await getPrisma().notification.count()).toBe(0);
}

const conflict = (currentStatus: string, requiredStatus: string | string[]) => ({
  error: {
    code: 'INVALID_STATE_TRANSITION',
    message: expect.any(String),
    details: [{ currentStatus, requiredStatus }],
    requestId: expect.any(String),
  },
});

describe('PATCH /incidents/:incidentId — gates and request model', () => {
  it('401 without a token', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const res = await request(app)
      .patch(`/api/v1/incidents/${incident.id}`)
      .send({ status: 'ACKNOWLEDGED' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['an unknown field', { status: 'ACKNOWLEDGED', extra: 1 }, 400, 'BAD_REQUEST'],
    ['an empty body', {}, 422, 'VALIDATION_FAILED'],
    ['status OPEN alone', { status: 'OPEN' }, 422, 'VALIDATION_FAILED'],
    ['two actions', { status: 'ACKNOWLEDGED', severity: 'P1' }, 422, 'VALIDATION_FAILED'],
    [
      'an action next to a comment',
      { severity: 'P1', comment: { body: 'x' } },
      422,
      'VALIDATION_FAILED',
    ],
    ['an invalid severity', { severity: 'P9' }, 422, 'VALIDATION_FAILED'],
    ['a malformed assignee', { currentAssignee: 'nope' }, 422, 'VALIDATION_FAILED'],
  ])('%s → %i %s', async (_name, body, status, code) => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const res = await patch(w.auth.leadA, incident.id, body);
    expect([res.status, res.body.error.code]).toEqual([status, code]);
    await nothingWritten(incident.id);
  });

  it('422 for a malformed incident id', async () => {
    const w = await lifecycleWorld();
    const res = await patch(w.auth.leadA, 'not-a-uuid', { status: 'ACKNOWLEDGED' });
    expect([res.status, res.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
  });

  it('403 INVALID_ACTION for a caller without a team (an Admin too), before any lookup', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    for (const id of [incident.id, randomUUID()]) {
      const res = await patch(w.auth.noTeam, id, { status: 'ACKNOWLEDGED' });
      expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    }
  });

  it('404 INCIDENT_NOT_FOUND and 403 TEAM_ACCESS_DENIED for another team', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const missing = await patch(w.auth.leadA, randomUUID(), { status: 'ACKNOWLEDGED' });
    expect([missing.status, missing.body.error.code]).toEqual([404, 'INCIDENT_NOT_FOUND']);
    expect(missing.body.error.details).toEqual([{ resource: 'incident' }]);

    const other = await patch(w.auth.engB, incident.id, { status: 'ACKNOWLEDGED' });
    expect([other.status, other.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
    await nothingWritten(incident.id);
  });
});

describe('I3 acknowledge', () => {
  it('auto-assigns an unassigned incident: ASSIGNED then ACKNOWLEDGED, one notification each', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const res = await patch(w.auth.engA2, incident.id, { status: 'ACKNOWLEDGED' });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(res.body.data).toMatchObject({
      id: incident.id,
      status: 'ACKNOWLEDGED',
      currentAssignee: { id: w.engA2.id, name: 'Erin Engineer' },
      acknowledgedBy: { id: w.engA2.id, name: 'Erin Engineer' },
      acknowledgedAt: expect.stringMatching(/Z$/),
      severityConfirmedBy: null,
      resolvedBy: null,
      closedBy: null,
      resolutionSummary: null,
      service: { id: w.service.id },
      teamId: w.teamA.id,
    });
    expect(res.body.data.sla.response.state).toBe('MET');

    const events = await eventsOf(incident.id);
    expect(events.map((e) => e.eventType)).toEqual(['ASSIGNED', 'ACKNOWLEDGED']);
    expect(events.map((e) => e.actor)).toEqual([w.engA2.id, w.engA2.id]);
    expect(events[0].metadata).toEqual({ from: null, to: w.engA2.id, auto: true });
    expect(events[1].metadata).toEqual({ acknowledgedBy: w.engA2.id, autoAssigned: true });
    expect(events[0].createdAt.getTime()).toBeLessThan(events[1].createdAt.getTime());

    const rows = await getPrisma().notification.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((n) => n.notificationType)).toEqual(['ALERT', 'ALERT']);
    expect(rows.map((n) => n.idempotencyKey)).toEqual([
      `ASSIGNED:${events[0].id}`,
      `ACKNOWLEDGED:${events[1].id}`,
    ]);
    expect(rows.every((n) => n.incidentId === incident.id)).toBe(true);

    const queued = await outbox();
    expect(queued.map((o) => o.eventType)).toEqual([
      'NOTIFICATION_REQUESTED',
      'NOTIFICATION_REQUESTED',
    ]);
    expect(
      queued.map((o) => (o.payload as { notificationId: string }).notificationId).sort(),
    ).toEqual(rows.map((n) => n.id).sort());
    expect(await outbox('SLA_EVALUATION_REQUESTED')).toEqual([]);
  });

  it('keeps an existing assignee: only ACKNOWLEDGED, autoAssigned false; any role may acknowledge', async () => {
    const w = await lifecycleWorld();
    for (const token of [w.auth.engA, w.auth.leadA, w.auth.adminA2]) {
      const incident = await incidentIn(w, 'OPEN', { assignee: w.engA2.id });
      const res = await patch(token, incident.id, { status: 'ACKNOWLEDGED' });
      expect(res.status).toBe(200);
      expect(res.body.data.currentAssignee.id).toBe(w.engA2.id);
      const events = await eventsOf(incident.id);
      expect(events.map((e) => e.eventType)).toEqual(['ACKNOWLEDGED']);
      expect(events[0].metadata).toMatchObject({ autoAssigned: false });
      const stored = await reload(incident.id);
      expect(stored.acknowledgedById).not.toBe(stored.currentAssigneeId);
    }
  });

  it.each(['ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const)(
    'from %s → 409 INVALID_STATE_TRANSITION, nothing written',
    async (status) => {
      const w = await lifecycleWorld();
      const incident = await incidentIn(w, status);
      const res = await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual(conflict(status, 'OPEN'));
      await nothingWritten(incident.id);
    },
  );

  it('a retry gets 409 and creates no second event, outbox row or notification', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    expect((await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' })).status).toBe(200);
    expect((await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' })).status).toBe(409);
    expect(await eventTypes(incident.id)).toEqual(['ASSIGNED', 'ACKNOWLEDGED']);
    expect(await getPrisma().notification.count()).toBe(2);
    expect(await outbox()).toHaveLength(2);
  });

  it('N parallel acknowledgements: exactly one 200, the rest 409, one set of rows', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const tokens = [w.auth.engA, w.auth.engA2, w.auth.leadA, w.auth.adminA, w.auth.adminA2];
    const results = await Promise.all(
      tokens.map((token) => patch(token, incident.id, { status: 'ACKNOWLEDGED' })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    for (const loser of results.filter((r) => r.status === 409)) {
      expect(loser.body.error.code).toBe('INVALID_STATE_TRANSITION');
    }
    const winner = results.find((r) => r.status === 200)!;
    const stored = await reload(incident.id);
    expect(stored.acknowledgedById).toBe(winner.body.data.acknowledgedBy.id);
    expect(stored.currentAssigneeId).toBe(winner.body.data.acknowledgedBy.id);
    expect(await eventTypes(incident.id)).toEqual(['ASSIGNED', 'ACKNOWLEDGED']);
    expect(await outbox()).toHaveLength(2);
    expect(await getPrisma().notification.count()).toBe(2);
  });
});

describe('I4 confirm severity', () => {
  const body = (severity: string) => ({ status: 'MITIGATING', severity });

  it('a chain member confirms: MITIGATING, severityConfirmedBy/At, event, notification, SLA evaluation', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'ACKNOWLEDGED', { assignee: w.engA.id, ackBy: w.engA.id });
    const res = await patch(w.auth.engA, incident.id, body('P0'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'MITIGATING',
      severity: 'P0',
      severityConfirmedBy: { id: w.engA.id },
      severityConfirmedAt: expect.stringMatching(/Z$/),
    });
    expect(res.body.data.sla.applicableSeverity).toBe('P0');
    const events = await eventsOf(incident.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'SEVERITY_CONFIRMED',
      actor: w.engA.id,
      metadata: { from: 'P2', to: 'P0', statusFrom: 'ACKNOWLEDGED', statusTo: 'MITIGATING' },
    });
    const sla = await outbox('SLA_EVALUATION_REQUESTED');
    expect(sla).toHaveLength(1);
    expect(sla[0].payload).toMatchObject({
      incidentId: incident.id,
      requestId: expect.any(String),
    });
    expect(await getPrisma().notification.count()).toBe(1);
  });

  it('writes the event when the confirmed value equals the current severity', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'ACKNOWLEDGED', { severity: 'P2', ackBy: w.leadA.id });
    expect((await patch(w.auth.leadA, incident.id, body('P2'))).status).toBe(200);
    expect((await eventsOf(incident.id))[0].metadata).toMatchObject({ from: 'P2', to: 'P2' });
  });

  it('403 FORBIDDEN for a team member outside the chain, an Admin included', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'ACKNOWLEDGED');
    for (const token of [w.auth.engA2, w.auth.adminA2]) {
      const res = await patch(token, incident.id, body('P1'));
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
    }
    await nothingWritten(incident.id);
  });

  it.each(['OPEN', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const)(
    'from %s → 409',
    async (status) => {
      const w = await lifecycleWorld();
      const incident = await incidentIn(w, status);
      const res = await patch(w.auth.leadA, incident.id, body('P1'));
      expect(res.status).toBe(409);
      expect(res.body).toEqual(conflict(status, 'ACKNOWLEDGED'));
    },
  );

  it('a retry gets 409 and writes nothing more', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'ACKNOWLEDGED');
    expect((await patch(w.auth.leadA, incident.id, body('P1'))).status).toBe(200);
    expect((await patch(w.auth.leadA, incident.id, body('P1'))).status).toBe(409);
    expect(await eventsOf(incident.id)).toHaveLength(1);
    expect(await outbox()).toHaveLength(2);
  });
});

describe('I5 change severity', () => {
  it.each(['ACKNOWLEDGED', 'MITIGATING'] as const)(
    'changes the severity in %s, status unchanged, SEVERITY_CONFIRMED with statusFrom = statusTo',
    async (status) => {
      const w = await lifecycleWorld();
      const incident = await incidentIn(w, status);
      const res = await patch(w.auth.engA, incident.id, { severity: 'P0' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status, severity: 'P0', severityConfirmedBy: null });
      expect((await eventsOf(incident.id))[0].metadata).toEqual({
        from: 'P2',
        to: 'P0',
        statusFrom: status,
        statusTo: status,
      });
      expect(await outbox('SLA_EVALUATION_REQUESTED')).toHaveLength(1);
      expect(await getPrisma().notification.count()).toBe(1);
    },
  );

  it('in OPEN a Team Lead in the chain may, an Engineer in the chain gets 403 FORBIDDEN_ROLE', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const denied = await patch(w.auth.engA, incident.id, { severity: 'P0' });
    expect([denied.status, denied.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
    await nothingWritten(incident.id);
    expect((await patch(w.auth.leadA, incident.id, { severity: 'P0' })).status).toBe(200);
    expect((await patch(w.auth.adminA, incident.id, { severity: 'P3' })).status).toBe(200);
  });

  it('the same value is 200 and writes nothing', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING', { severity: 'P1' });
    const res = await patch(w.auth.leadA, incident.id, { severity: 'P1' });
    expect(res.status).toBe(200);
    expect(res.body.data.severity).toBe('P1');
    await nothingWritten(incident.id);
  });

  it('403 FORBIDDEN outside the chain (Admin too), checked before the role-by-state rule', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    for (const token of [w.auth.adminA2, w.auth.engA2]) {
      const res = await patch(token, incident.id, { severity: 'P0' });
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
    }
  });

  it.each(['RESOLVED', 'CLOSED'] as const)('%s → 409 with the allowed set', async (status) => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, status);
    const res = await patch(w.auth.leadA, incident.id, { severity: 'P0' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(conflict(status, ['OPEN', 'ACKNOWLEDGED', 'MITIGATING']));
  });
});

describe('I6 assign', () => {
  it('assigns an unassigned incident: ASSIGNED { auto: false }; acknowledgement untouched', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'ACKNOWLEDGED', { ackBy: w.engA.id });
    const res = await patch(w.auth.leadA, incident.id, { currentAssignee: w.engA2.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'ACKNOWLEDGED',
      currentAssignee: { id: w.engA2.id },
      acknowledgedBy: { id: w.engA.id },
    });
    const events = await eventsOf(incident.id);
    expect(events.map((e) => [e.eventType, e.actor, e.metadata])).toEqual([
      ['ASSIGNED', w.leadA.id, { from: null, to: w.engA2.id, auto: false }],
    ]);
    expect(await getPrisma().notification.count()).toBe(1);
    expect(await outbox('SLA_EVALUATION_REQUESTED')).toEqual([]);
  });

  it('reassigns: REASSIGNED { from, to }; a Team Lead may be the assignee', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING', { assignee: w.engA.id });
    const res = await patch(w.auth.adminA2, incident.id, { currentAssignee: w.leadA.id });
    expect(res.status).toBe(200);
    expect((await eventsOf(incident.id))[0]).toMatchObject({
      eventType: 'REASSIGNED',
      metadata: { from: w.engA.id, to: w.leadA.id },
    });
  });

  it('the current assignee again is 200 and writes nothing', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN', { assignee: w.engA.id });
    const res = await patch(w.auth.leadA, incident.id, { currentAssignee: w.engA.id });
    expect(res.status).toBe(200);
    await nothingWritten(incident.id);
  });

  it('an Engineer gets 403 FORBIDDEN_ROLE', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const res = await patch(w.auth.engA, incident.id, { currentAssignee: w.engA2.id });
    expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
    await nothingWritten(incident.id);
  });

  it.each([
    ['a user of another team', (w: World) => w.engB.id],
    ['a deactivated user', (w: World) => w.inactive.id],
    ['an Admin of the team', (w: World) => w.adminA2.id],
    ['a user that does not exist', () => randomUUID()],
  ])('%s → 403 ASSIGNEE_NOT_ELIGIBLE with no details', async (_name, pick) => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const res = await patch(w.auth.leadA, incident.id, { currentAssignee: pick(w) });
    expect([res.status, res.body.error.code]).toEqual([403, 'ASSIGNEE_NOT_ELIGIBLE']);
    expect(res.body.error.details).toEqual([]);
    await nothingWritten(incident.id);
  });

  it.each(['RESOLVED', 'CLOSED'] as const)('%s → 409', async (status) => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, status);
    const res = await patch(w.auth.leadA, incident.id, { currentAssignee: w.engA2.id });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(conflict(status, ['OPEN', 'ACKNOWLEDGED', 'MITIGATING']));
  });
});

describe('I7 unassign', () => {
  const body = { currentAssignee: null, status: 'OPEN' };

  it('assigned and mitigating: REASSIGNED then OPEN, acknowledgement cleared, SLA evaluation, 2 notifications', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING', { assignee: w.engA.id, ackBy: w.engA.id });
    const res = await patch(w.auth.leadA, incident.id, body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'OPEN',
      currentAssignee: null,
      acknowledgedBy: null,
      acknowledgedAt: null,
    });
    const events = await eventsOf(incident.id);
    expect(events.map((e) => [e.eventType, e.metadata])).toEqual([
      ['REASSIGNED', { from: w.engA.id, to: null }],
      ['OPEN', { statusFrom: 'MITIGATING' }],
    ]);
    expect(await getPrisma().notification.count()).toBe(2);
    expect(await outbox('SLA_EVALUATION_REQUESTED')).toHaveLength(1);
  });

  it('assigned but already OPEN: only REASSIGNED, no SLA evaluation', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN', { assignee: w.engA.id });
    expect((await patch(w.auth.adminA, incident.id, body)).status).toBe(200);
    expect(await eventTypes(incident.id)).toEqual(['REASSIGNED']);
    expect(await outbox('SLA_EVALUATION_REQUESTED')).toEqual([]);
  });

  it('already unassigned and OPEN: 200 and nothing written', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    expect((await patch(w.auth.leadA, incident.id, body)).status).toBe(200);
    await nothingWritten(incident.id);
  });

  it('an Engineer gets 403 FORBIDDEN_ROLE', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING', { assignee: w.engA.id });
    const res = await patch(w.auth.engA, incident.id, body);
    expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
  });

  it.each(['RESOLVED', 'CLOSED'] as const)('%s → 409', async (status) => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, status);
    const res = await patch(w.auth.leadA, incident.id, body);
    expect(res.status).toBe(409);
    expect(res.body).toEqual(conflict(status, ['OPEN', 'ACKNOWLEDGED', 'MITIGATING']));
  });
});

describe('I8 resolve', () => {
  const body = {
    status: 'RESOLVED',
    resolutionSummary: 'Rolled back',
    serviceConfirmedWorking: true,
  };

  async function withAlerts(w: World, incidentId: string) {
    const source = await createAlertSource();
    const db = getPrisma();
    const alerts = await Promise.all(
      ['a', 'b'].map((key) =>
        db.alert.create({
          data: {
            name: key,
            environment: 'production',
            startedTimestamp: new Date('2026-01-01T00:00:00.000Z'),
            originalPayload: {},
            alertSourceId: source.id,
            affectedServiceId: w.service.id,
            incidentId,
            activeIdentityKey: `fingerprint:${key}`,
          },
        }),
      ),
    );
    return alerts;
  }

  it('resolves atomically: incident, RESOLVED event, postmortem, cleared keys, outbox, notification', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING', { assignee: w.engA.id });
    await withAlerts(w, incident.id);

    const res = await patch(w.auth.leadA, incident.id, body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'RESOLVED',
      resolvedBy: { id: w.leadA.id },
      resolvedAt: expect.stringMatching(/Z$/),
      resolutionSummary: 'Rolled back',
    });
    expect(res.body.data.sla.resolution.state).toBe('MET');

    const events = await eventsOf(incident.id);
    expect(events.map((e) => [e.eventType, e.actor, e.metadata])).toEqual([
      ['RESOLVED', w.leadA.id, { resolutionSummary: 'Rolled back', serviceConfirmedWorking: true }],
    ]);

    const postmortems = await getPrisma().postmortem.findMany();
    expect(postmortems).toHaveLength(1);
    expect(postmortems[0]).toMatchObject({
      incidentId: incident.id,
      generationStatus: 'GENERATING',
      reviewStatus: 'PENDING',
      summary: null,
      MTTR: null,
      riskLevel: null,
    });

    const alerts = await getPrisma().alert.findMany({ where: { incidentId: incident.id } });
    expect(alerts.map((a) => a.activeIdentityKey)).toEqual([null, null]);

    const generation = await outbox('POSTMORTEM_GENERATION_REQUESTED');
    expect(generation).toHaveLength(1);
    expect(generation[0].payload).toMatchObject({
      postmortemId: postmortems[0].id,
      incidentId: incident.id,
    });
    expect(await getPrisma().notification.count()).toBe(1);
    expect(await outbox('SLA_EVALUATION_REQUESTED')).toEqual([]);
  });

  it('an Engineer resolves only as the current assignee', async () => {
    const w = await lifecycleWorld();
    const mine = await incidentIn(w, 'MITIGATING', { assignee: w.engA.id });
    const theirs = await incidentIn(w, 'MITIGATING', { assignee: w.engA2.id });
    const nobody = await incidentIn(w, 'MITIGATING');
    expect((await patch(w.auth.engA, mine.id, body)).status).toBe(200);
    for (const incident of [theirs, nobody]) {
      const res = await patch(w.auth.engA, incident.id, body);
      expect([res.status, res.body.error.code]).toEqual([403, 'NOT_CURRENT_ASSIGNEE']);
      expect((await reload(incident.id)).status).toBe('MITIGATING');
    }
    expect(await getPrisma().postmortem.count()).toBe(1);
  });

  it('a Team Lead and an Admin resolve any incident of the team', async () => {
    const w = await lifecycleWorld();
    for (const token of [w.auth.leadA, w.auth.adminA2]) {
      const incident = await incidentIn(w, 'MITIGATING', { assignee: w.engA2.id });
      expect((await patch(token, incident.id, body)).status).toBe(200);
    }
  });

  it('422 when the summary is missing or invalid, 400 when serviceConfirmedWorking is not true', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING');
    const cases: [object, number, string][] = [
      [{ status: 'RESOLVED', serviceConfirmedWorking: true }, 422, 'VALIDATION_FAILED'],
      [{ ...body, resolutionSummary: '   ' }, 422, 'VALIDATION_FAILED'],
      [{ ...body, resolutionSummary: 'x'.repeat(10_001) }, 422, 'VALIDATION_FAILED'],
      [{ ...body, serviceConfirmedWorking: false }, 400, 'BAD_REQUEST'],
      [{ status: 'RESOLVED', resolutionSummary: 'x' }, 400, 'BAD_REQUEST'],
    ];
    for (const [payload, status, code] of cases) {
      const res = await patch(w.auth.leadA, incident.id, payload);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
    }
    expect(await getPrisma().postmortem.count()).toBe(0);
    await nothingWritten(incident.id);
  });

  it('the body checks run after the team gate: another team still gets 403', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING');
    const res = await patch(w.auth.engB, incident.id, { ...body, serviceConfirmedWorking: false });
    expect([res.status, res.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
  });

  it.each(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED'] as const)(
    'from %s → 409',
    async (status) => {
      const w = await lifecycleWorld();
      const incident = await incidentIn(w, status);
      const res = await patch(w.auth.leadA, incident.id, body);
      expect(res.status).toBe(409);
      expect(res.body).toEqual(conflict(status, 'MITIGATING'));
      expect(await getPrisma().postmortem.count()).toBe(0);
    },
  );

  it('a retry gets 409: still one postmortem, one generation job, one RESOLVED event', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING');
    expect((await patch(w.auth.leadA, incident.id, body)).status).toBe(200);
    expect((await patch(w.auth.leadA, incident.id, body)).status).toBe(409);
    expect(await getPrisma().postmortem.count()).toBe(1);
    expect(await outbox('POSTMORTEM_GENERATION_REQUESTED')).toHaveLength(1);
    expect(await eventTypes(incident.id)).toEqual(['RESOLVED']);
  });

  it('parallel resolves: one 200, the rest 409, one postmortem and one job', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING');
    const results = await Promise.all(
      [w.auth.leadA, w.auth.adminA, w.auth.adminA2, w.auth.leadA].map((token) =>
        patch(token, incident.id, body),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await getPrisma().postmortem.count()).toBe(1);
    expect(await outbox('POSTMORTEM_GENERATION_REQUESTED')).toHaveLength(1);
    expect(await eventTypes(incident.id)).toEqual(['RESOLVED']);
  });

  it('resolve racing unassign: one wins by lock order, the other gets 409, state matches the events', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING', { assignee: w.engA.id, ackBy: w.engA.id });
    const [resolve, unassign] = await Promise.all([
      patch(w.auth.leadA, incident.id, body),
      patch(w.auth.adminA, incident.id, { currentAssignee: null, status: 'OPEN' }),
    ]);
    const stored = await reload(incident.id);
    if (resolve.status === 200) {
      expect(unassign.status).toBe(409);
      expect(stored.status).toBe('RESOLVED');
      expect(await eventTypes(incident.id)).toEqual(['RESOLVED']);
      expect(await getPrisma().postmortem.count()).toBe(1);
    } else {
      expect([resolve.status, unassign.status]).toEqual([409, 200]);
      expect(stored.status).toBe('OPEN');
      expect(await eventTypes(incident.id)).toEqual(['REASSIGNED', 'OPEN']);
      expect(await getPrisma().postmortem.count()).toBe(0);
    }
  });
});

describe('atomicity: a failure rolls back state, audit, notifications and outbox together', () => {
  it('I8: a failing audit append leaves the incident, postmortem, alert keys and outbox untouched', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING', { assignee: w.engA.id });
    const source = await createAlertSource();
    await getPrisma().alert.create({
      data: {
        name: 'a',
        environment: 'production',
        startedTimestamp: new Date('2026-01-01T00:00:00.000Z'),
        originalPayload: {},
        alertSourceId: source.id,
        affectedServiceId: w.service.id,
        incidentId: incident.id,
        activeIdentityKey: 'fingerprint:a',
      },
    });
    jest.spyOn(audit, 'appendAuditEvent').mockRejectedValueOnce(new Error('audit down'));

    const res = await patch(w.auth.leadA, incident.id, {
      status: 'RESOLVED',
      resolutionSummary: 'x',
      serviceConfirmedWorking: true,
    });
    expect([res.status, res.body.error.code]).toEqual([500, 'INTERNAL_ERROR']);

    const stored = await reload(incident.id);
    expect(stored).toMatchObject({
      status: 'MITIGATING',
      resolvedById: null,
      resolutionSummary: null,
    });
    expect(await getPrisma().postmortem.count()).toBe(0);
    expect((await getPrisma().alert.findFirstOrThrow()).activeIdentityKey).toBe('fingerprint:a');
    await nothingWritten(incident.id);
  });

  it('I8: a failure at the very end (notification) rolls everything back', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'MITIGATING');
    jest
      .spyOn(notifications, 'enqueueNotification')
      .mockRejectedValueOnce(new Error('notification producer down'));

    const res = await patch(w.auth.leadA, incident.id, {
      status: 'RESOLVED',
      resolutionSummary: 'x',
      serviceConfirmedWorking: true,
    });
    expect(res.status).toBe(500);
    expect((await reload(incident.id)).status).toBe('MITIGATING');
    expect(await getPrisma().postmortem.count()).toBe(0);
    await nothingWritten(incident.id);
  });

  it('I3: a failure after the first of two audit events leaves nothing behind', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    const real = audit.appendAuditEvent;
    jest
      .spyOn(audit, 'appendAuditEvent')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('second event fails'));

    const res = await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' });
    expect(res.status).toBe(500);
    const stored = await reload(incident.id);
    expect(stored).toMatchObject({
      status: 'OPEN',
      currentAssigneeId: null,
      acknowledgedById: null,
    });
    await nothingWritten(incident.id);
  });
});

describe('lock timeout', () => {
  async function holdLock(sql: string, params: string[], work: () => Promise<void>) {
    const holder = new Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(sql, params);
      await work();
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  }

  it('a held incident lock → 409 CONCURRENCY_CONFLICT, nothing written; a retry then succeeds', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    await holdLock(
      'SELECT id FROM "Incident" WHERE id = $1::uuid FOR UPDATE',
      [incident.id],
      async () => {
        const res = await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' });
        expect([res.status, res.body.error.code]).toEqual([409, 'CONCURRENCY_CONFLICT']);
        await nothingWritten(incident.id);
      },
    );
    expect((await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' })).status).toBe(200);
  });

  it('I3 takes a share lock on the acknowledging user: a held user lock conflicts', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    await holdLock(
      'SELECT id FROM "User" WHERE id = $1::uuid FOR UPDATE',
      [w.leadA.id],
      async () => {
        const res = await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' });
        expect([res.status, res.body.error.code]).toEqual([409, 'CONCURRENCY_CONFLICT']);
      },
    );
    await nothingWritten(incident.id);
  });

  it('I6 takes a share lock on the assignee: a held user lock conflicts', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    await holdLock(
      'SELECT id FROM "User" WHERE id = $1::uuid FOR UPDATE',
      [w.engA2.id],
      async () => {
        const res = await patch(w.auth.leadA, incident.id, { currentAssignee: w.engA2.id });
        expect([res.status, res.body.error.code]).toEqual([409, 'CONCURRENCY_CONFLICT']);
      },
    );
    await nothingWritten(incident.id);
  });
});

describe('database outage', () => {
  it('503 DEPENDENCY_UNAVAILABLE with Retry-After when the database cannot be reached', async () => {
    const w = await lifecycleWorld();
    const incident = await incidentIn(w, 'OPEN');
    jest
      .spyOn(getPrisma().incident, 'findUnique')
      .mockRejectedValueOnce(new Prisma.PrismaClientInitializationError('down', 'test', 'P1001'));

    const res = await patch(w.auth.leadA, incident.id, { status: 'ACKNOWLEDGED' });
    expect([res.status, res.body.error.code]).toEqual([503, 'DEPENDENCY_UNAVAILABLE']);
    expect(res.headers['retry-after']).toBe('5');
    await nothingWritten(incident.id);
  });
});
