import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import { buildTestApp } from '../helpers/app';
import { resetState } from '../helpers/identity';
import {
  createAlert,
  createAlertSource,
  createIncidentWith,
  createTriage,
  incidentWorld,
} from '../helpers/incidents';

const app = buildTestApp();
const NIL = '00000000-0000-4000-8000-000000000000';

beforeEach(resetState);
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe('I1 GET /incidents', () => {
  const LIST_KEYS = [
    'createdAt',
    'currentAssignee',
    'id',
    'service',
    'severity',
    'slaState',
    'status',
    'title',
  ];

  it('returns only the caller team incidents, for every role, in the specified shape', async () => {
    const w = await incidentWorld(app);
    const mine = await createIncidentWith({
      teamId: w.teamA.id,
      serviceId: w.serviceA.id,
      currentAssigneeId: w.engA.id,
    });
    await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });

    for (const token of [w.auth.engA, w.auth.leadA, w.auth.adminA]) {
      const res = await request(app).get('/api/v1/incidents').set(token);
      expect(res.status).toBe(200);
      expect(res.body.data.map((item: { id: string }) => item.id)).toEqual([mine.id]);
      expect(res.body.pagination).toEqual({ nextCursor: null, hasMore: false });
    }

    const [item] = (await request(app).get('/api/v1/incidents').set(w.auth.engA)).body.data;
    expect(Object.keys(item).sort()).toEqual(LIST_KEYS);
    expect(item.service).toEqual({ id: w.serviceA.id, name: w.serviceA.name });
    expect(item.currentAssignee).toEqual({ id: w.engA.id, name: 'Eli Engineer' });
    expect(item.slaState).toEqual({ response: 'ON_TRACK', resolution: 'ON_TRACK' });
    expect(item.createdAt).toMatch(/Z$/);
  });

  it('rejects a caller without a team and an unauthenticated caller', async () => {
    const w = await incidentWorld(app);
    const noTeam = await request(app).get('/api/v1/incidents').set(w.auth.noTeam);
    expect(noTeam.status).toBe(403);
    expect(noTeam.body.error.code).toBe('INVALID_ACTION');
    const anonymous = await request(app).get('/api/v1/incidents');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('ignores any team parameter by rejecting it: no teamId parameter exists', async () => {
    const w = await incidentWorld(app);
    const res = await request(app)
      .get('/api/v1/incidents')
      .query({ teamId: w.teamB.id })
      .set(w.auth.engA);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('filters by status, severity (comma lists), service and assignee', async () => {
    const w = await incidentWorld(app);
    const base = { teamId: w.teamA.id, serviceId: w.serviceA.id };
    const p0Open = await createIncidentWith({ ...base, severity: 'P0', status: 'OPEN' });
    const p1Ack = await createIncidentWith({
      ...base,
      severity: 'P1',
      status: 'ACKNOWLEDGED',
      currentAssigneeId: w.engA.id,
    });
    const p2Mit = await createIncidentWith({
      teamId: w.teamA.id,
      serviceId: w.serviceA2.id,
      severity: 'P2',
      status: 'MITIGATING',
    });
    const get = async (query: Record<string, string>) =>
      (await request(app).get('/api/v1/incidents').query(query).set(w.auth.engA)).body.data.map(
        (item: { id: string }) => item.id,
      );

    expect((await get({ status: 'OPEN,MITIGATING' })).sort()).toEqual([p0Open.id, p2Mit.id].sort());
    expect((await get({ severity: 'P0,P1' })).sort()).toEqual([p0Open.id, p1Ack.id].sort());
    expect(await get({ serviceId: w.serviceA2.id })).toEqual([p2Mit.id]);
    expect(await get({ assigneeId: w.engA.id })).toEqual([p1Ack.id]);
    expect(await get({ status: 'OPEN', severity: 'P1' })).toEqual([]);
  });

  it('returns an empty list for a service outside the caller team (not 403)', async () => {
    const w = await incidentWorld(app);
    await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });
    const res = await request(app)
      .get('/api/v1/incidents')
      .query({ serviceId: w.serviceB.id })
      .set(w.auth.engA);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('defaults to severity ascending with id as tie-breaker', async () => {
    const w = await incidentWorld(app);
    const base = { teamId: w.teamA.id, serviceId: w.serviceA.id };
    await createIncidentWith({ ...base, severity: 'P3' });
    await createIncidentWith({ ...base, severity: 'P1' });
    await createIncidentWith({ ...base, severity: 'P0' });
    await createIncidentWith({ ...base, severity: 'P1' });
    const rows = (await request(app).get('/api/v1/incidents').set(w.auth.engA)).body.data;
    expect(rows.map((r: { severity: string }) => r.severity)).toEqual(['P0', 'P1', 'P1', 'P3']);
    const p1 = rows.filter((r: { severity: string }) => r.severity === 'P1');
    expect(p1[0].id < p1[1].id).toBe(true);
  });

  const ORDERINGS = ['createdAt', 'severity', 'status', 'title', 'affectedServiceId', 'teamId'];
  describe.each(
    ORDERINGS.flatMap((orderBy) => [
      [orderBy, 'asc'],
      [orderBy, 'desc'],
    ]),
  )('cursor paging, orderBy=%s sort=%s', (orderBy, sort) => {
    it('visits every row once, in the order of the database', async () => {
      const w = await incidentWorld(app);
      const severities = ['P0', 'P1', 'P2', 'P3'] as const;
      const statuses = ['OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const;
      for (let i = 0; i < 9; i += 1) {
        await createIncidentWith({
          teamId: w.teamA.id,
          serviceId: i % 2 === 0 ? w.serviceA.id : w.serviceA2.id,
          severity: severities[i % 4],
          status: statuses[i % 5],
          title: `title-${i % 3}`,
          createdAt: minutesAgo(100 - Math.floor(i / 2)),
        });
      }
      const expected = (
        await getPrisma().incident.findMany({
          where: { teamId: w.teamA.id },
          orderBy: [{ [orderBy]: sort }, { id: sort }] as never,
          select: { id: true },
        })
      ).map((row) => row.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const res: request.Response = await request(app)
          .get('/api/v1/incidents')
          .query({ limit: 2, orderBy, sort, ...(cursor ? { cursor } : {}) })
          .set(w.auth.engA);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.map((item: { id: string }) => item.id));
        if (!res.body.pagination.hasMore) {
          expect(res.body.pagination.nextCursor).toBeNull();
          break;
        }
        cursor = res.body.pagination.nextCursor as string;
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      }
      expect(seen).toEqual(expected);
    });
  });

  it('rejects undecodable, wrong-shape and re-ordered cursors with 422 INVALID_CURSOR', async () => {
    const w = await incidentWorld(app);
    for (let i = 0; i < 3; i += 1) {
      await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });
    }
    const first = await request(app).get('/api/v1/incidents').query({ limit: 1 }).set(w.auth.engA);
    const issued = first.body.pagination.nextCursor as string;
    const wrongShape = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');

    for (const cursor of ['%%%not-base64', wrongShape, '']) {
      const res = await request(app).get('/api/v1/incidents').query({ cursor }).set(w.auth.engA);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    }
    const reordered = await request(app)
      .get('/api/v1/incidents')
      .query({ cursor: issued, orderBy: 'createdAt' })
      .set(w.auth.engA);
    expect(reordered.status).toBe(422);
    expect(reordered.body.error.code).toBe('INVALID_CURSOR');
  });

  it('applies team scope again on a cursor taken from another team', async () => {
    const w = await incidentWorld(app);
    for (let i = 0; i < 3; i += 1) {
      await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });
      await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });
    }
    const first = await request(app).get('/api/v1/incidents').query({ limit: 1 }).set(w.auth.engA);
    const next = await request(app)
      .get('/api/v1/incidents')
      .query({ cursor: first.body.pagination.nextCursor })
      .set(w.auth.engB);
    expect(next.status).toBe(200);
    const teams = await getPrisma().incident.findMany({
      where: { id: { in: next.body.data.map((i: { id: string }) => i.id) } },
      select: { teamId: true },
    });
    expect(teams.every((row) => row.teamId === w.teamB.id)).toBe(true);
  });

  it('has no effect for orderBy=teamId (always the caller team)', async () => {
    const w = await incidentWorld(app);
    const a = await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });
    await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });
    const res = await request(app)
      .get('/api/v1/incidents')
      .query({ orderBy: 'teamId' })
      .set(w.auth.engA);
    expect(res.body.data.map((i: { id: string }) => i.id)).toEqual([a.id]);
  });

  it.each([
    ['limit above the maximum', { limit: '51' }],
    ['limit zero', { limit: '0' }],
    ['limit not a number', { limit: 'x' }],
    ['unknown status', { status: 'OPEN,BOGUS' }],
    ['empty status list item', { status: 'OPEN,' }],
    ['unknown severity', { severity: 'P9' }],
    ['malformed serviceId', { serviceId: 'nope' }],
    ['malformed assigneeId', { assigneeId: 'nope' }],
    ['unknown orderBy', { orderBy: 'description' }],
    ['unknown sort', { sort: 'up' }],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_name, query) => {
    const w = await incidentWorld(app);
    const res = await request(app).get('/api/v1/incidents').query(query).set(w.auth.engA);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('accepts the maximum limit of 50', async () => {
    const w = await incidentWorld(app);
    const res = await request(app).get('/api/v1/incidents').query({ limit: 50 }).set(w.auth.engA);
    expect(res.status).toBe(200);
  });

  it('computes slaState at read time', async () => {
    const w = await incidentWorld(app);
    const base = { teamId: w.teamA.id, serviceId: w.serviceA.id, severity: 'P1' as const };
    // P1: response 10 min, resolution 60 min
    const breached = await createIncidentWith({ ...base, createdAt: minutesAgo(20) });
    const warning = await createIncidentWith({ ...base, createdAt: minutesAgo(9) });
    const met = await createIncidentWith({
      ...base,
      status: 'ACKNOWLEDGED',
      createdAt: minutesAgo(20),
      acknowledgedAt: minutesAgo(15),
      acknowledgedById: w.engA.id,
    });
    const rows = (await request(app).get('/api/v1/incidents').set(w.auth.engA)).body.data;
    const state = (id: string) => rows.find((r: { id: string }) => r.id === id).slaState;
    expect(state(breached.id)).toEqual({ response: 'BREACHED', resolution: 'ON_TRACK' });
    expect(state(warning.id)).toEqual({ response: 'WARNING', resolution: 'ON_TRACK' });
    expect(state(met.id)).toEqual({ response: 'MET', resolution: 'ON_TRACK' });
  });
});

describe('I2 GET /incidents/:incidentId', () => {
  const DETAIL_KEYS = [
    'acknowledgedAt',
    'acknowledgedBy',
    'aiTriage',
    'alerts',
    'closedAt',
    'closedBy',
    'createdAt',
    'currentAssignee',
    'description',
    'id',
    'resolutionSummary',
    'resolvedAt',
    'resolvedBy',
    'severity',
    'severityConfirmedAt',
    'severityConfirmedBy',
    'service',
    'sla',
    'status',
    'teamId',
    'title',
  ];
  const TRIAGE_KEYS = [
    'category',
    'confidence',
    'evidence',
    'generatedAt',
    'model',
    'modelVersion',
    'reasoningSummary',
    'status',
    'suggestedSeverity',
  ];

  async function detailFixture() {
    const w = await incidentWorld(app);
    const incident = await createIncidentWith({
      teamId: w.teamA.id,
      serviceId: w.serviceA.id,
      status: 'ACKNOWLEDGED',
      currentAssigneeId: w.engA.id,
      acknowledgedById: w.leadA.id,
      acknowledgedAt: minutesAgo(3),
    });
    const source = await createAlertSource('Prometheus');
    return { w, incident, source };
  }

  const fetch = (token: Record<string, string>, id: string) =>
    request(app).get(`/api/v1/incidents/${id}`).set(token);

  it('returns the full shape for every role, with actors, SLA and alerts', async () => {
    const { w, incident, source } = await detailFixture();
    const alert = await createAlert({
      incidentId: incident.id,
      serviceId: w.serviceA.id,
      alertSourceId: source.id,
      name: 'CPU high',
    });
    for (const token of [w.auth.engA, w.auth.leadA, w.auth.adminA]) {
      const res = await fetch(token, incident.id);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual([...DETAIL_KEYS].sort());
    }
    const { data } = (await fetch(w.auth.engA, incident.id)).body;
    expect(data).toMatchObject({
      id: incident.id,
      status: 'ACKNOWLEDGED',
      teamId: w.teamA.id,
      currentAssignee: { id: w.engA.id, name: 'Eli Engineer' },
      acknowledgedBy: { id: w.leadA.id, name: 'Lena Lead' },
      severityConfirmedBy: null,
      resolvedBy: null,
      closedBy: null,
      resolutionSummary: null,
      severityConfirmedAt: null,
      resolvedAt: null,
      closedAt: null,
    });
    expect(data.sla.applicableSeverity).toBe('P1');
    expect(data.sla.response).toMatchObject({ thresholdMinutes: 10, state: 'MET' });
    expect(data.sla.resolution).toMatchObject({
      thresholdMinutes: 60,
      state: 'ON_TRACK',
      metAt: null,
    });
    expect(data.alerts).toEqual([
      {
        id: alert.id,
        name: 'CPU high',
        environment: 'production',
        sourceSeverity: null,
        initialSeverity: null,
        sourceStatus: 'FIRING',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
        sourceUrl: null,
        alertSource: { id: source.id, name: 'Prometheus' },
      },
    ]);
  });

  it('shows aiTriage PENDING with all values null when there is no alert or no record', async () => {
    const { w, incident, source } = await detailFixture();
    const noAlerts = (await fetch(w.auth.engA, incident.id)).body.data.aiTriage;
    expect(noAlerts).toEqual({
      status: 'PENDING',
      category: null,
      suggestedSeverity: null,
      confidence: null,
      evidence: [],
      reasoningSummary: null,
      model: null,
      modelVersion: null,
      generatedAt: null,
    });

    await createAlert({
      incidentId: incident.id,
      serviceId: w.serviceA.id,
      alertSourceId: source.id,
    });
    const noRecord = (await fetch(w.auth.engA, incident.id)).body.data.aiTriage;
    expect(noRecord).toEqual(noAlerts);
  });

  it('derives aiTriage from the stored record: PENDING, SUCCESS → COMPLETED, FAILED → UNAVAILABLE', async () => {
    const { w, incident, source } = await detailFixture();
    const alert = await createAlert({
      incidentId: incident.id,
      serviceId: w.serviceA.id,
      alertSourceId: source.id,
    });
    const triage = async () => (await fetch(w.auth.engA, incident.id)).body.data.aiTriage;
    const filled = {
      category: 'DATABASE',
      suggestedSeverity: 'P0' as const,
      confidence: 0.9,
      reasoning: 'pool exhausted',
      evidence: [{ type: 'LOG', reference: 'l1', excerpt: 'refused', rawModelOutput: 'x' }],
    };

    const record = await createTriage(alert.id, { failureStatus: 'PENDING', ...filled });
    const pending = await triage();
    expect(pending.status).toBe('PENDING');
    expect(pending.category).toBeNull();

    await getPrisma().aITriage.update({
      where: { id: record.id },
      data: { failureStatus: 'FAILED' },
    });
    const failed = await triage();
    expect(failed).toMatchObject({ status: 'UNAVAILABLE', category: null, evidence: [] });

    await getPrisma().aITriage.update({
      where: { id: record.id },
      data: { failureStatus: 'SUCCESS' },
    });
    const done = await triage();
    expect(Object.keys(done).sort()).toEqual(TRIAGE_KEYS);
    expect(done).toMatchObject({
      status: 'COMPLETED',
      category: 'DATABASE',
      suggestedSeverity: 'P0',
      confidence: 0.9,
      reasoningSummary: 'pool exhausted',
      evidence: [{ type: 'LOG', reference: 'l1', excerpt: 'refused' }],
      model: 'test-model',
      modelVersion: '1',
    });
    expect(done.generatedAt).toMatch(/Z$/);
  });

  it('uses the latest accepted alert for aiTriage', async () => {
    const { w, incident, source } = await detailFixture();
    const common = { incidentId: incident.id, serviceId: w.serviceA.id, alertSourceId: source.id };
    const older = await createAlert({ ...common, createdAt: minutesAgo(30) });
    const newer = await createAlert({ ...common, createdAt: minutesAgo(5) });
    await createTriage(older.id, { failureStatus: 'SUCCESS', category: 'OLD' });
    await createTriage(newer.id, { failureStatus: 'FAILED' });

    const res = await fetch(w.auth.engA, incident.id);
    expect(res.body.data.aiTriage.status).toBe('UNAVAILABLE');
    expect(res.body.data.alerts.map((a: { id: string }) => a.id)).toEqual([older.id, newer.id]);

    await getPrisma().aITriage.update({
      where: { alertId: newer.id },
      data: { failureStatus: 'SUCCESS', category: 'NEW' },
    });
    expect((await fetch(w.auth.engA, incident.id)).body.data.aiTriage.category).toBe('NEW');
  });

  it('never leaks payloads, the internal triage summary, raw model output or hashes', async () => {
    const { w, incident, source } = await detailFixture();
    const alert = await createAlert({
      incidentId: incident.id,
      serviceId: w.serviceA.id,
      alertSourceId: source.id,
      originalPayload: { token: 'PAYLOAD-SECRET' },
    });
    await createTriage(alert.id, {
      failureStatus: 'SUCCESS',
      summary: 'INTERNAL-SUMMARY',
      rawOutput: { prompt: 'RAW-MODEL-OUTPUT' },
      reasoning: 'visible reasoning',
    });
    const text = JSON.stringify((await fetch(w.auth.engA, incident.id)).body);
    for (const secret of [
      'PAYLOAD-SECRET',
      'INTERNAL-SUMMARY',
      'RAW-MODEL-OUTPUT',
      'originalPayload',
      'passwordHash',
      'rawOutput',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('visible reasoning');
  });

  it('enforces gates: 401, 422, 403 INVALID_ACTION, 403 TEAM_ACCESS_DENIED, 404', async () => {
    const { w, incident } = await detailFixture();
    const other = await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });

    expect((await request(app).get(`/api/v1/incidents/${incident.id}`)).status).toBe(401);
    const malformed = await fetch(w.auth.engA, 'not-a-uuid');
    expect(malformed.status).toBe(422);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');

    const noTeam = await fetch(w.auth.noTeam, incident.id);
    expect(noTeam.status).toBe(403);
    expect(noTeam.body.error.code).toBe('INVALID_ACTION');

    const foreign = await fetch(w.auth.engA, other.id);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('TEAM_ACCESS_DENIED');

    const missing = await fetch(w.auth.engA, randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      code: 'INCIDENT_NOT_FOUND',
      details: [{ resource: 'incident' }],
    });
    expect((await fetch(w.auth.engA, NIL)).status).toBe(404);
  });
});
