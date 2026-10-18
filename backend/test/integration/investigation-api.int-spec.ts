import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { createApp } from '../../src/app';
import { getPrisma } from '../../src/infra/db/prisma';
import * as outboxModule from '../../src/infra/jobs/outbox';
import { getRedis } from '../../src/infra/redis/redis';
import { createAiRouter } from '../../src/modules/ai';
import * as enqueueModule from '../../src/modules/notifications/enqueue-notification';
import { createInvestigationRateLimiter } from '../../src/modules/ai/investigation/investigation.rate-limit';
import { buildTestApp } from '../helpers/app';
import {
  bearer,
  createIncident,
  createService,
  createTeam,
  createUser,
  login,
  resetState,
} from '../helpers/identity';

const app = buildTestApp();
const db = () => getPrisma();

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

type Role = 'ENGINEER' | 'TEAM_LEAD' | 'ADMIN';
type Status = 'OPEN' | 'ACKNOWLEDGED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';

async function world(role: Role = 'ENGINEER', status: Status = 'OPEN') {
  const team = await createTeam();
  const admin = await createUser({ role: 'ADMIN', name: 'Admin One' });
  const service = await createService(team.id, admin.id);
  const incident = await createIncident(team.id, service.id, status);
  const user = await createUser({ role, teamId: team.id, name: 'Ada Responder' });
  const session = await login(app, user.email);
  return { team, admin, service, incident, user, headers: bearer(session.token) };
}
type World = Awaited<ReturnType<typeof world>>;

const URL = (incidentId: string) => `/api/v1/incidents/${incidentId}/investigations`;
const post = (w: World, key: string | null = randomUUID(), incidentId = w.incident.id) => {
  const req = request(app).post(URL(incidentId)).set(w.headers);
  return key === null ? req : req.set('Idempotency-Key', key);
};

describe('N1 request an investigation', () => {
  it('answers 202 with a REQUESTED investigation, then 200 for a replay of the same key', async () => {
    const w = await world();
    const key = 'key-first-0001';
    const first = await post(w, key);
    expect(first.status).toBe(202);
    expect(first.body.data).toMatchObject({
      incidentId: w.incident.id,
      status: 'REQUESTED',
      brief: null,
      evidence: [],
      failureReason: null,
      completedAt: null,
      requestedBy: { id: w.user.id, name: 'Ada Responder' },
      provenance: { model: null, modelVersion: null },
    });
    expect(Object.keys(first.body.data)).not.toEqual(
      expect.arrayContaining(['input', 'idempotencyKey']),
    );

    const replay = await post(w, key);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await db().investigation.count()).toBe(1);
    expect(await db().outboxEvent.count({ where: { eventType: 'INVESTIGATION_REQUESTED' } })).toBe(
      1,
    );
  });

  it('stores the retrieval parameters only and writes the outbox event with ids and request id', async () => {
    const w = await world();
    const res = await post(w).set('X-Request-Id', 'req-n1');
    const row = await db().investigation.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row).toMatchObject({
      status: 'REQUESTED',
      requestedById: w.user.id,
      incidentId: w.incident.id,
      input: { postmortemLimit: 20 },
    });
    const event = await db().outboxEvent.findFirstOrThrow({
      where: { eventType: 'INVESTIGATION_REQUESTED' },
    });
    expect(event.status).toBe('PENDING');
    expect(event.aggregateId).toBe(row.id);
    expect(event.payload).toEqual({
      investigationId: row.id,
      incidentId: w.incident.id,
      requestId: 'req-n1',
    });
  });

  it('answers 409 IDEMPOTENCY_KEY_REUSED for another incident or another user', async () => {
    const w = await world();
    const key = 'key-reuse-0001';
    await post(w, key).expect(202);

    const other = await createIncident(w.team.id, w.service.id, 'OPEN');
    const forOther = await post(w, key, other.id);
    expect([forOther.status, forOther.body.error.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);

    const colleague = await createUser({ role: 'TEAM_LEAD', teamId: w.team.id });
    const session = await login(app, colleague.email);
    const byOther = await request(app)
      .post(URL(w.incident.id))
      .set(bearer(session.token))
      .set('Idempotency-Key', key);
    expect([byOther.status, byOther.body.error.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await db().investigation.count()).toBe(1);
  });

  it('answers 400 without the key and 422 for a malformed key or incident id', async () => {
    const w = await world();
    const missing = await post(w, null);
    expect([missing.status, missing.body.error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    for (const key of ['short', 'a'.repeat(129), 'bad key bad key']) {
      const res = await post(w, key);
      expect([res.status, res.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    const badId = await post(w, 'key-valid-0001', 'not-a-uuid');
    expect([badId.status, badId.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(await db().investigation.count()).toBe(0);
  });

  it('accepts no body and no query parameter (400)', async () => {
    const w = await world();
    const withBody = await post(w).send({ question: 'why?' });
    expect([withBody.status, withBody.body.error.code]).toEqual([400, 'BAD_REQUEST']);
    const withQuery = await post(w).query({ teamId: randomUUID() });
    expect([withQuery.status, withQuery.body.error.code]).toEqual([400, 'BAD_REQUEST']);
    expect(await db().investigation.count()).toBe(0);
  });

  it('creates one row and one outbox event for concurrent identical requests (one 202, the rest 200)', async () => {
    const w = await world();
    const key = 'key-parallel-1';
    const results = await Promise.all([post(w, key), post(w, key), post(w, key)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await db().investigation.count()).toBe(1);
    expect(await db().outboxEvent.count({ where: { eventType: 'INVESTIGATION_REQUESTED' } })).toBe(
      1,
    );
  });

  it('rolls back the investigation when the outbox write fails (atomic)', async () => {
    const w = await world();
    jest.spyOn(outboxModule, 'enqueueOutbox').mockRejectedValueOnce(new Error('boom'));
    const res = await post(w);
    expect(res.status).toBe(500);
    expect(await db().investigation.count()).toBe(0);
  });

  it.each(['ENGINEER', 'TEAM_LEAD', 'ADMIN'] as const)(
    'allows a %s of the incident team',
    async (role) => {
      const w = await world(role);
      expect((await post(w)).status).toBe(202);
    },
  );

  it.each(['OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const)(
    'allows an incident in status %s and leaves the incident untouched',
    async (status) => {
      const w = await world('ENGINEER', status);
      const before = await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } });
      expect((await post(w)).status).toBe(202);
      expect(await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } })).toEqual(
        before,
      );
    },
  );

  it('answers 401 without a token, 404 for an unknown incident and 403 across teams', async () => {
    const w = await world();
    const anonymous = await request(app)
      .post(URL(w.incident.id))
      .set('Idempotency-Key', 'key-anon-0001');
    expect(anonymous.status).toBe(401);

    const unknown = await post(w, 'key-unknown-01', randomUUID());
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'INCIDENT_NOT_FOUND']);

    const other = await world();
    const crossTeam = await post(w, 'key-cross-0001', other.incident.id);
    expect([crossTeam.status, crossTeam.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
  });

  it('answers 403 INVALID_ACTION for a caller without a team, an Admin included, before any lookup', async () => {
    const w = await world();
    for (const role of ['ENGINEER', 'ADMIN'] as const) {
      const user = await createUser({ role, teamId: null });
      const session = await login(app, user.email);
      const res = await request(app)
        .post(URL(randomUUID()))
        .set(bearer(session.token))
        .set('Idempotency-Key', 'key-noteam-001');
      expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    }
    expect(w).toBeDefined();
  });

  it('runs the team gate before the header checks', async () => {
    const w = await world();
    const other = await world();
    const res = await post(w, null, other.incident.id);
    expect([res.status, res.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
  });
});

describe('N1 rate limit', () => {
  const blockKey = (userId: string) => `inv:rl:block:${userId}`;

  it('allows 3 requests a minute and answers 429 RATE_LIMITED with Retry-After for the 4th', async () => {
    const w = await world();
    for (let i = 0; i < 3; i += 1) expect((await post(w, `key-limit-000${i}`)).status).toBe(202);
    const fourth = await post(w, 'key-limit-0004');
    expect([fourth.status, fourth.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(fourth.headers['retry-after'])).toBe(600);
    expect(await db().investigation.count()).toBe(3);
  });

  it('counts every request, replays included', async () => {
    const w = await world();
    const key = 'key-replay-001';
    await post(w, key);
    await post(w, key);
    await post(w, key);
    expect((await post(w, key)).status).toBe(429);
  });

  it('answers 429 while blocked without escalating, and lifts the block automatically', async () => {
    const w = await world();
    for (let i = 0; i < 4; i += 1) await post(w, `key-block-000${i}`);
    const stillBlocked = await post(w, 'key-block-0009');
    expect(stillBlocked.status).toBe(429);
    expect(Number(stillBlocked.headers['retry-after'])).toBeLessThanOrEqual(600);
    expect(await getRedis().get(`inv:rl:level:${w.user.id}`)).toBe('1');

    await getRedis().del(blockKey(w.user.id)); // the block ends
    expect((await post(w, 'key-block-0010')).status).toBe(202);
  });

  it('escalates 10 min → 20 min → 60 min → 4 h → 8 h and stays at 8 h', async () => {
    const w = await world();
    const seconds: number[] = [];
    for (let level = 1; level <= 6; level += 1) {
      await getRedis().del(blockKey(w.user.id));
      let last = await post(w, randomUUID());
      for (let i = 0; i < 3; i += 1) last = await post(w, randomUUID());
      expect(last.status).toBe(429);
      seconds.push(Number(last.headers['retry-after']));
    }
    expect(seconds).toEqual([600, 1200, 3600, 14400, 28800, 28800]);
  });

  it('notifies all active Admins once per block at the final stage only', async () => {
    const w = await world();
    const secondAdmin = await createUser({ role: 'ADMIN', name: 'Admin Two' });
    await createUser({ role: 'ADMIN', status: 'DEACTIVATED' });
    for (let level = 1; level <= 4; level += 1) {
      await getRedis().del(blockKey(w.user.id));
      for (let i = 0; i < 4; i += 1) await post(w, randomUUID());
    }
    expect(
      await db().notification.count({ where: { eventType: 'INVESTIGATION_REQUEST_BLOCKED' } }),
    ).toBe(0);

    await getRedis().del(blockKey(w.user.id));
    for (let i = 0; i < 4; i += 1) await post(w, randomUUID());
    // More requests inside the same block must not notify again.
    for (let i = 0; i < 3; i += 1) expect((await post(w, randomUUID())).status).toBe(429);

    const notices = await db().notification.findMany({
      where: { eventType: 'INVESTIGATION_REQUEST_BLOCKED' },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ notificationType: 'ALERT', incidentId: null });
    expect([...notices[0].recipients].sort()).toEqual([w.admin.id, secondAdmin.id].sort());

    const event = await db().outboxEvent.findFirstOrThrow({
      where: { eventType: 'NOTIFICATION_REQUESTED', aggregateId: notices[0].id },
    });
    expect(event.payload).toMatchObject({
      kind: 'INVESTIGATION_REQUEST_BLOCKED',
      detail_userId: w.user.id,
      detail_userName: 'Ada Responder',
      detail_attemptCount: 4,
    });
    expect(String((event.payload as Record<string, unknown>).detail_latestAction)).toContain(
      w.incident.id,
    );
    expect(await db().auditEvent.count({ where: { eventType: 'NOTIFIED' } })).toBe(0);

    // The next block (a new window) is notified again.
    await getRedis().del(blockKey(w.user.id));
    for (let i = 0; i < 4; i += 1) await post(w, randomUUID());
    expect(
      await db().notification.count({ where: { eventType: 'INVESTIGATION_REQUEST_BLOCKED' } }),
    ).toBe(2);
  });

  it('retries an unwritten notice on the next blocked request', async () => {
    const w = await world();
    for (let level = 1; level <= 4; level += 1) {
      await getRedis().del(blockKey(w.user.id));
      for (let i = 0; i < 4; i += 1) await post(w, randomUUID());
    }
    await getRedis().del(blockKey(w.user.id));
    const failing = jest
      .spyOn(enqueueModule, 'enqueueNotification')
      .mockRejectedValueOnce(new Error('boom'));
    for (let i = 0; i < 4; i += 1) await post(w, randomUUID());
    failing.mockRestore();
    expect(
      await db().notification.count({ where: { eventType: 'INVESTIGATION_REQUEST_BLOCKED' } }),
    ).toBe(0);

    await getRedis().del(`inv:rl:notice-lock:${w.user.id}`);
    expect((await post(w, randomUUID())).status).toBe(429);
    expect(
      await db().notification.count({ where: { eventType: 'INVESTIGATION_REQUEST_BLOCKED' } }),
    ).toBe(1);
  });

  it('answers 503 DEPENDENCY_UNAVAILABLE with Retry-After when Redis is unavailable (fail closed)', async () => {
    const w = await world();
    const broken = {
      eval: async () => Promise.reject(new Error('redis down')),
    } as unknown as Redis;
    const downApp = createApp({
      readinessChecks: [],
      apiRouter: createAiRouter({ limiter: createInvestigationRateLimiter(broken) }),
    });
    const res = await request(downApp)
      .post(URL(w.incident.id))
      .set(w.headers)
      .set('Idempotency-Key', 'key-redis-down1');
    expect([res.status, res.body.error.code]).toEqual([503, 'DEPENDENCY_UNAVAILABLE']);
    expect(res.headers['retry-after']).toBeDefined();
    expect(await db().investigation.count()).toBe(0);
  });

  it('starts fresh after the Redis state is lost', async () => {
    const w = await world();
    for (let i = 0; i < 4; i += 1) await post(w, randomUUID());
    await getRedis().flushdb();
    expect((await post(w, randomUUID())).status).toBe(202);
  });
});

describe('N2 / N3 read', () => {
  async function seed(w: World, count: number) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      rows.push(
        await db().investigation.create({
          data: {
            idempotencyKey: `seed-key-${i}-${randomUUID()}`,
            requestedById: w.user.id,
            incidentId: w.incident.id,
            input: { postmortemLimit: 20 },
            createdAt: new Date(Date.UTC(2026, 9, 1, 10, i)),
          },
        }),
      );
    }
    return rows;
  }

  it('lists with offset pagination, default ascending by createdAt, and no brief or evidence', async () => {
    const w = await world();
    const rows = await seed(w, 3);
    await db().evidence.create({
      data: { evidenceType: 'FACT', investigationId: rows[0].id, incidentId: w.incident.id },
    });
    await db().investigation.update({
      where: { id: rows[0].id },
      data: { status: 'COMPLETED', result: { summary: 's' }, completedAt: new Date() },
    });

    const all = await request(app).get(URL(w.incident.id)).set(w.headers);
    expect(all.status).toBe(200);
    expect(all.body.data.map((r: { id: string }) => r.id)).toEqual(rows.map((r) => r.id));
    expect(all.body.data[0]).toMatchObject({ status: 'COMPLETED', brief: null, evidence: [] });
    expect(all.body.pagination).toEqual({ limit: 10, offset: 0, hasMore: false });

    const page = await request(app)
      .get(URL(w.incident.id))
      .query({ limit: 2, offset: 1, sort: 'desc' })
      .set(w.headers);
    expect(page.body.data.map((r: { id: string }) => r.id)).toEqual([rows[1].id, rows[0].id]);
    expect(page.body.pagination).toEqual({ limit: 2, offset: 1, hasMore: false });
    const first = await request(app).get(URL(w.incident.id)).query({ limit: 2 }).set(w.headers);
    expect(first.body.pagination.hasMore).toBe(true);
  });

  it('shows every investigation of the incident to every role of the team', async () => {
    const w = await world('ENGINEER');
    await seed(w, 2);
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: w.team.id });
    const session = await login(app, lead.email);
    const res = await request(app).get(URL(w.incident.id)).set(bearer(session.token));
    expect(res.body.data).toHaveLength(2);
  });

  it('rejects bad queries (422), unknown ones (400), other teams (403), no team (403) and unknown incidents (404)', async () => {
    const w = await world();
    const over = await request(app).get(URL(w.incident.id)).query({ limit: 51 }).set(w.headers);
    expect([over.status, over.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    const order = await request(app)
      .get(URL(w.incident.id))
      .query({ orderBy: 'status' })
      .set(w.headers);
    expect(order.status).toBe(422);
    const unknown = await request(app).get(URL(w.incident.id)).query({ foo: 'x' }).set(w.headers);
    expect(unknown.status).toBe(400);

    const other = await world();
    const cross = await request(app).get(URL(other.incident.id)).set(w.headers);
    expect([cross.status, cross.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
    const lost = await request(app).get(URL(randomUUID())).set(w.headers);
    expect([lost.status, lost.body.error.code]).toEqual([404, 'INCIDENT_NOT_FOUND']);
    const user = await createUser({ role: 'ADMIN', teamId: null });
    const session = await login(app, user.email);
    const none = await request(app).get(URL(w.incident.id)).set(bearer(session.token));
    expect([none.status, none.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    expect((await request(app).get(URL(w.incident.id))).status).toBe(401);
  });

  it('N3 returns brief and evidence only when COMPLETED and nothing internal', async () => {
    const w = await world();
    const [row] = await seed(w, 1);
    const pending = await request(app)
      .get(`${URL(w.incident.id)}/${row.id}`)
      .set(w.headers);
    expect(pending.status).toBe(200);
    expect(pending.body.data).toMatchObject({ status: 'REQUESTED', brief: null, evidence: [] });

    const brief = {
      summary: 'Summary',
      findings: [],
      possibleAreas: [],
      suggestedSteps: [],
      limitations: null,
    };
    const evidence = await db().evidence.create({
      data: {
        evidenceType: 'FACT',
        sourceType: 'INCIDENT',
        sourceReference: w.incident.id,
        relevanceInfo: 'why it matters',
        investigationId: row.id,
        incidentId: w.incident.id,
      },
    });
    await db().investigation.update({
      where: { id: row.id },
      data: {
        status: 'COMPLETED',
        result: brief,
        completedAt: new Date('2026-10-17T10:00:00.000Z'),
        model: 'm',
        modelVersion: 'm-1',
      },
    });
    const done = await request(app)
      .get(`${URL(w.incident.id)}/${row.id}`)
      .set(w.headers);
    expect(done.body.data).toMatchObject({
      status: 'COMPLETED',
      brief,
      completedAt: '2026-10-17T10:00:00.000Z',
      provenance: { model: 'm', modelVersion: 'm-1' },
      evidence: [
        {
          id: evidence.id,
          evidenceType: 'FACT',
          sourceType: 'INCIDENT',
          sourceReference: w.incident.id,
          relevance: 'why it matters',
        },
      ],
    });
    const text = JSON.stringify(done.body);
    expect(text).not.toContain('postmortemLimit');
    expect(text).not.toContain(row.idempotencyKey);
  });

  it('N3 shows a failed investigation with its reason, and 404s another incident’s or an unknown one', async () => {
    const w = await world();
    const [row] = await seed(w, 1);
    await db().investigation.update({
      where: { id: row.id },
      data: { status: 'FAILED', failureReason: 'AI_UNAVAILABLE' },
    });
    const failed = await request(app)
      .get(`${URL(w.incident.id)}/${row.id}`)
      .set(w.headers);
    expect(failed.body.data).toMatchObject({
      status: 'FAILED',
      failureReason: 'AI_UNAVAILABLE',
      brief: null,
    });

    const sibling = await createIncident(w.team.id, w.service.id, 'OPEN');
    const wrong = await request(app)
      .get(`${URL(sibling.id)}/${row.id}`)
      .set(w.headers);
    expect([wrong.status, wrong.body.error.code]).toEqual([404, 'INVESTIGATION_NOT_FOUND']);
    const missing = await request(app)
      .get(`${URL(w.incident.id)}/${randomUUID()}`)
      .set(w.headers);
    expect(missing.status).toBe(404);
    const malformed = await request(app)
      .get(`${URL(w.incident.id)}/nope`)
      .set(w.headers);
    expect(malformed.status).toBe(422);
  });

  it('offers no way to edit or delete an investigation, and no evaluation endpoint', async () => {
    const w = await world();
    const [row] = await seed(w, 1);
    expect(
      (
        await request(app)
          .delete(`${URL(w.incident.id)}/${row.id}`)
          .set(w.headers)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`${URL(w.incident.id)}/${row.id}`)
          .set(w.headers)
          .send({})
      ).status,
    ).toBe(404);
    expect((await request(app).get('/api/v1/evaluations').set(w.headers)).status).toBe(404);
    expect((await request(app).post('/api/v1/evaluations').set(w.headers).send({})).status).toBe(
      404,
    );
  });
});
