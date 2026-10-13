import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import * as audit from '../../src/infra/audit/append-audit-event';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import { buildTestApp } from '../helpers/app';
import { adminSession, bearer, resetState } from '../helpers/identity';
import { createIncidentWith, incidentWorld } from '../helpers/incidents';
import { testDatabaseUrl } from '../helpers/test-env';

const app = buildTestApp();

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

const patch = (token: Record<string, string>, id: string, body: unknown) =>
  request(app)
    .patch(`/api/v1/incidents/${id}`)
    .set(token)
    .send(body as object);
const timeline = (token: Record<string, string>, id: string, query: object = {}) =>
  request(app).get(`/api/v1/incidents/${id}/timeline`).query(query).set(token);

async function fixture(status: 'OPEN' | 'CLOSED' | 'RESOLVED' = 'OPEN') {
  const w = await incidentWorld(app);
  const incident = await createIncidentWith({
    teamId: w.teamA.id,
    serviceId: w.serviceA.id,
    status,
  });
  return { w, incident };
}

describe('I10 PATCH /incidents/:incidentId — comment', () => {
  it('creates the comment as the caller: 201, CommentResponse, trimmed body, no title → null', async () => {
    const { w, incident } = await fixture();
    const res = await patch(w.auth.engA, incident.id, { comment: { body: '  Restarted pod  ' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(String),
      title: null,
      body: 'Restarted pod',
      author: { id: w.engA.id, name: 'Eli Engineer' },
      createdAt: expect.stringMatching(/Z$/),
    });
    expect(Object.keys(res.body)).toEqual(['data']);

    const stored = await getPrisma().comment.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      incidentId: incident.id,
      authorId: w.engA.id,
      description: 'Restarted pod',
    });
  });

  it('is open to every role of the incident team, with a title', async () => {
    const { w, incident } = await fixture();
    for (const [token, user] of [
      [w.auth.engA, w.engA],
      [w.auth.leadA, w.leadA],
      [w.auth.adminA, w.adminA],
    ] as const) {
      const res = await patch(token, incident.id, { comment: { title: 'Update', body: 'ok' } });
      expect(res.status).toBe(201);
      expect(res.body.data.title).toBe('Update');
      expect(res.body.data.author.id).toBe(user.id);
    }
  });

  it('writes COMMENT_ADDED in the same transaction and shows it in the timeline', async () => {
    const { w, incident } = await fixture();
    const created = (
      await patch(w.auth.leadA, incident.id, { comment: { title: 'T', body: 'hello' } })
    ).body.data;

    const rows = await getPrisma().auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'COMMENT_ADDED',
      incidentId: incident.id,
      actor: w.leadA.id,
    });

    const items = (await timeline(w.auth.engA, incident.id)).body.data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      eventType: 'COMMENT_ADDED',
      actor: { id: w.leadA.id, name: 'Lena Lead' },
      details: { comment: created },
    });
  });

  it.each(['OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED'] as const)(
    'is allowed in status %s',
    async (status) => {
      const w = await incidentWorld(app);
      const incident = await createIncidentWith({
        teamId: w.teamA.id,
        serviceId: w.serviceA.id,
        status,
      });
      expect((await patch(w.auth.engA, incident.id, { comment: { body: 'x' } })).status).toBe(201);
    },
  );

  it('is refused on a CLOSED incident with 409 and leaves nothing behind', async () => {
    const { w, incident } = await fixture('CLOSED');
    const res = await patch(w.auth.engA, incident.id, { comment: { body: 'late' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details).toEqual([{ currentStatus: 'CLOSED' }]);
    expect(await getPrisma().comment.count()).toBe(0);
    expect(await getPrisma().auditEvent.count()).toBe(0);
  });

  it('has no idempotency: a retry creates a second comment and a second event', async () => {
    const { w, incident } = await fixture();
    const first = await patch(w.auth.engA, incident.id, { comment: { body: 'same' } });
    const second = await patch(w.auth.engA, incident.id, { comment: { body: 'same' } });
    expect(first.body.data.id).not.toBe(second.body.data.id);
    expect(await getPrisma().comment.count()).toBe(2);
    expect(await getPrisma().auditEvent.count()).toBe(2);
  });

  it('accepts the maximum lengths', async () => {
    const { w, incident } = await fixture();
    const res = await patch(w.auth.engA, incident.id, {
      comment: { title: 't'.repeat(200), body: 'b'.repeat(10_000) },
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ['whitespace-only body', { comment: { body: '   ' } }, 422],
    ['body over 10,000 characters', { comment: { body: 'b'.repeat(10_001) } }, 422],
    ['title over 200 characters', { comment: { title: 't'.repeat(201), body: 'x' } }, 422],
    ['missing body', { comment: {} }, 422],
    ['comment that is not an object', { comment: 'hi' }, 422],
    ['empty body', {}, 422],
    ['another action instead of a comment', { status: 'ACKNOWLEDGED' }, 422],
    ['a comment combined with another action', { comment: { body: 'x' }, severity: 'P1' }, 422],
    ['an unknown field', { comment: { body: 'x' }, extra: 1 }, 400],
    ['a client-sent author', { comment: { body: 'x', authorId: randomUUID() } }, 400],
  ])('rejects %s with %i', async (_name, body, status) => {
    const { w, incident } = await fixture();
    const res = await patch(w.auth.engA, incident.id, body);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(status === 400 ? 'BAD_REQUEST' : 'VALIDATION_FAILED');
    expect(await getPrisma().comment.count()).toBe(0);
  });

  it('rejects malformed JSON and a non-JSON content type with 400', async () => {
    const { w, incident } = await fixture();
    const malformed = await request(app)
      .patch(`/api/v1/incidents/${incident.id}`)
      .set(w.auth.engA)
      .set('Content-Type', 'application/json')
      .send('{"comment":');
    expect(malformed.status).toBe(400);
    const wrongType = await request(app)
      .patch(`/api/v1/incidents/${incident.id}`)
      .set(w.auth.engA)
      .set('Content-Type', 'text/plain')
      .send('comment');
    expect(wrongType.status).toBe(400);
  });

  it('validates before state: a bad body on a CLOSED incident is 422, not 409', async () => {
    const { w, incident } = await fixture('CLOSED');
    expect((await patch(w.auth.engA, incident.id, { comment: { body: '' } })).status).toBe(422);
  });

  it('enforces gates: 401, 422 id, 403 INVALID_ACTION, 403 TEAM_ACCESS_DENIED, 404', async () => {
    const { w, incident } = await fixture();
    const foreign = await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });
    const body = { comment: { body: 'x' } };

    expect((await request(app).patch(`/api/v1/incidents/${incident.id}`).send(body)).status).toBe(
      401,
    );
    expect((await patch(w.auth.engA, 'nope', body)).status).toBe(422);
    const noTeam = await patch(w.auth.noTeam, incident.id, body);
    expect([noTeam.status, noTeam.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    const other = await patch(w.auth.engA, foreign.id, body);
    expect([other.status, other.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
    const missing = await patch(w.auth.engA, randomUUID(), body);
    expect([missing.status, missing.body.error.code]).toEqual([404, 'INCIDENT_NOT_FOUND']);
    expect(await getPrisma().comment.count()).toBe(0);
    expect(await getPrisma().auditEvent.count()).toBe(0);
  });

  it('rolls back the comment when the audit write fails (atomicity)', async () => {
    const { w, incident } = await fixture();
    jest.spyOn(audit, 'appendAuditEvent').mockRejectedValueOnce(new Error('audit down'));
    const res = await patch(w.auth.engA, incident.id, { comment: { body: 'x' } });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(await getPrisma().comment.count()).toBe(0);
    expect(await getPrisma().auditEvent.count()).toBe(0);
  });

  it('waits for a concurrent close and then refuses (status re-checked under the lock)', async () => {
    const { w, incident } = await fixture();
    const closer = new Client({ connectionString: testDatabaseUrl() });
    await closer.connect();
    try {
      await closer.query('BEGIN');
      await closer.query('SELECT 1 FROM "Incident" WHERE "id" = $1 FOR UPDATE', [incident.id]);
      await closer.query(`UPDATE "Incident" SET "status" = 'CLOSED' WHERE "id" = $1`, [
        incident.id,
      ]);

      let finished = false;
      const pending = new Promise<request.Response>((resolve) => {
        request(app)
          .patch(`/api/v1/incidents/${incident.id}`)
          .set(w.auth.engA)
          .send({ comment: { body: 'racing the close' } })
          .end((_error, res) => {
            finished = true;
            resolve(res);
          });
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(finished).toBe(false);

      await closer.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(await getPrisma().comment.count()).toBe(0);
    } finally {
      await closer.end();
    }
  });

  it('lets concurrent comments through together', async () => {
    const { w, incident } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        patch(w.auth.engA, incident.id, { comment: { body: `c${i}` } }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await getPrisma().comment.count()).toBe(5);
    expect(await getPrisma().auditEvent.count()).toBe(5);
  });
});

describe('I11 GET /incidents/:incidentId/timeline', () => {
  async function seedEvents(incidentId: string, count: number, actorId: string | null = null) {
    await runInTransaction(async (tx) => {
      for (let i = 0; i < count; i += 1) {
        await audit.appendAuditEvent(tx, {
          incidentId,
          eventType: 'SLA_WARNING',
          actorId,
          metadata: { kind: i % 2 === 0 ? 'RESPONSE' : 'RESOLUTION', n: i },
        });
      }
    });
  }

  it('is ordered by createdAt ascending by default and descending on request', async () => {
    const { w, incident } = await fixture();
    await seedEvents(incident.id, 5);
    const asc = (await timeline(w.auth.engA, incident.id)).body.data;
    const desc = (await timeline(w.auth.engA, incident.id, { sort: 'desc' })).body.data;
    const stamps = asc.map((item: { createdAt: string }) => item.createdAt);
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(5);
    expect(desc.map((i: { id: string }) => i.id)).toEqual(
      asc.map((i: { id: string }) => i.id).reverse(),
    );
  });

  it('paginates with limit/offset and reports hasMore without a total', async () => {
    const { w, incident } = await fixture();
    await seedEvents(incident.id, 5);
    const all = (await timeline(w.auth.engA, incident.id, { limit: 50 })).body.data;

    const page1 = await timeline(w.auth.engA, incident.id, { limit: 2 });
    const page2 = await timeline(w.auth.engA, incident.id, { limit: 2, offset: 2 });
    const page3 = await timeline(w.auth.engA, incident.id, { limit: 2, offset: 4 });
    expect(page1.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });
    expect(page2.body.pagination).toEqual({ limit: 2, offset: 2, hasMore: true });
    expect(page3.body.pagination).toEqual({ limit: 2, offset: 4, hasMore: false });
    const ids = [...page1.body.data, ...page2.body.data, ...page3.body.data].map(
      (i: { id: string }) => i.id,
    );
    expect(ids).toEqual(all.map((i: { id: string }) => i.id));
    expect(Object.keys(page1.body.pagination)).not.toContain('total');
    expect((await timeline(w.auth.engA, incident.id)).body.pagination).toEqual({
      limit: 10,
      offset: 0,
      hasMore: false,
    });
  });

  it.each([
    ['limit above the maximum', { limit: 51 }],
    ['negative offset', { offset: -1 }],
    ['orderBy other than createdAt', { orderBy: 'id' }],
    ['unknown sort', { sort: 'up' }],
  ])('rejects %s with 422', async (_name, query) => {
    const { w, incident } = await fixture();
    const res = await timeline(w.auth.engA, incident.id, query);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('maps the details of every one of the 22 event types and keeps their order', async () => {
    const { w, incident } = await fixture();
    const [alice, bob] = [w.engA, w.leadA];
    const ts = '2026-01-01T00:00:00.000Z';
    const events: [string, object][] = [
      ['ALERT_RECEIVED', { alertId: 'a1' }],
      ['ALERT_DUPLICATE', { alertSourceId: 's1' }],
      ['AI_TRIAGE_COMPLETED', { createdAt: ts }],
      ['INCIDENT_CREATED', { incidentId: incident.id }],
      ['ASSIGNED', { from: null, to: alice.id, auto: true }],
      ['REASSIGNED', { from: alice.id, to: bob.id }],
      ['OPEN', { statusFrom: 'ACKNOWLEDGED' }],
      ['ACKNOWLEDGED', { acknowledgedBy: alice.id, autoAssigned: true }],
      [
        'SEVERITY_CONFIRMED',
        { from: 'P2', to: 'P1', statusFrom: 'ACKNOWLEDGED', statusTo: 'MITIGATING' },
      ],
      [
        'COMMENT_ADDED',
        { comment: { id: 'c1', title: null, body: 'hi', authorId: bob.id, createdAt: ts } },
      ],
      ['SLA_WARNING', { kind: 'RESOLUTION' }],
      ['ESCALATED_L1', { notifiedUser: alice.id }],
      ['ESCALATED_L2', { notifiedUser: bob.id }],
      ['ESCALATED_L3', { notifiedUser: alice.id }],
      ['ESCALATED_L4', { notifiedUser: bob.id }],
      ['SOURCE_ALERT_RESOLVED', { alertId: 'a1' }],
      ['RESOLVED', { resolutionSummary: 'fixed', serviceConfirmedWorking: true }],
      ['NOTIFIED', { recipients: [alice.id, bob.id] }],
      ['POSTMORTEM_GENERATED', { postmortemId: 'p1' }],
      ['POSTMORTEM_REVIEWED', { postmortemId: 'p1', reviewedBy: bob.id }],
      ['AI_INVESTIGATION_COMPLETED', { investigationId: 'n1' }],
      ['CLOSED', { closedAt: ts }],
    ];
    await runInTransaction(async (tx) => {
      for (const [eventType, metadata] of events) {
        await audit.appendAuditEvent(tx, {
          incidentId: incident.id,
          eventType: eventType as never,
          actorId: eventType === 'ASSIGNED' ? null : alice.id,
          metadata: { ...metadata, secretKey: 'RAW-METADATA-SECRET' },
        });
      }
    });

    const res = await timeline(w.auth.engA, incident.id, { limit: 50 });
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: { eventType: string }) => i.eventType)).toEqual(
      events.map(([type]) => type),
    );
    const byType = Object.fromEntries(
      res.body.data.map((i: { eventType: string; details: object }) => [i.eventType, i.details]),
    );
    const a = { id: alice.id, name: 'Eli Engineer' };
    const b = { id: bob.id, name: 'Lena Lead' };
    expect(byType.ASSIGNED).toEqual({ from: null, to: a, auto: true });
    expect(byType.REASSIGNED).toEqual({ from: a, to: b });
    expect(byType.ACKNOWLEDGED).toEqual({ acknowledgedBy: alice.id, autoAssigned: true });
    expect(byType.COMMENT_ADDED).toEqual({
      comment: { id: 'c1', title: null, body: 'hi', author: b, createdAt: ts },
    });
    expect(byType.ESCALATED_L4).toEqual({ notifiedUser: b });
    expect(byType.NOTIFIED).toEqual({ recipients: [a, b] });
    expect(byType.POSTMORTEM_REVIEWED).toEqual({ postmortemId: 'p1', reviewedBy: b });
    expect(byType.RESOLVED).toEqual({ resolutionSummary: 'fixed', serviceConfirmedWorking: true });
    expect(byType.CLOSED).toEqual({ closedAt: ts });
    expect(JSON.stringify(res.body)).not.toContain('RAW-METADATA-SECRET');
    expect(JSON.stringify(res.body)).not.toContain('"metadata"');
  });

  it('shows the system actor as null and a human actor as a UserSummary', async () => {
    const { w, incident } = await fixture();
    await seedEvents(incident.id, 1, null);
    await seedEvents(incident.id, 1, w.engA.id);
    const [system, human] = (await timeline(w.auth.engA, incident.id)).body.data;
    expect(system.actor).toBeNull();
    expect(human.actor).toEqual({ id: w.engA.id, name: 'Eli Engineer' });
    expect(Object.keys(human).sort()).toEqual(['actor', 'createdAt', 'details', 'eventType', 'id']);
  });

  it('never shows administrative events, with or without an incident', async () => {
    const { w, incident } = await fixture();
    await runInTransaction(async (tx) => {
      await audit.appendAuditEvent(tx, {
        incidentId: null,
        eventType: 'USER_UPDATED',
        actorId: w.adminA.id,
        metadata: { userId: w.engA.id, changedFields: ['name'] },
      });
      await audit.appendAuditEvent(tx, {
        incidentId: incident.id,
        eventType: 'TEAM_UPDATED',
        actorId: w.adminA.id,
        metadata: { teamId: w.teamA.id, changedFields: ['name'] },
      });
    });
    await seedEvents(incident.id, 1);
    const items = (await timeline(w.auth.engA, incident.id)).body.data;
    expect(items.map((i: { eventType: string }) => i.eventType)).toEqual(['SLA_WARNING']);
  });

  it('only shows the events of the requested incident', async () => {
    const { w, incident } = await fixture();
    const other = await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });
    await seedEvents(incident.id, 2);
    await seedEvents(other.id, 3);
    expect((await timeline(w.auth.engA, incident.id)).body.data).toHaveLength(2);
  });

  it('is readable by every role and enforces the gates', async () => {
    const { w, incident } = await fixture();
    await seedEvents(incident.id, 1);
    for (const token of [w.auth.engA, w.auth.leadA, w.auth.adminA]) {
      expect((await timeline(token, incident.id)).status).toBe(200);
    }
    const foreign = await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });
    const url = (id: string) => `/api/v1/incidents/${id}/timeline`;

    expect((await request(app).get(url(incident.id))).status).toBe(401);
    expect((await timeline(w.auth.engA, 'nope')).status).toBe(422);
    const noTeam = await timeline(w.auth.noTeam, incident.id);
    expect([noTeam.status, noTeam.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    const other = await timeline(w.auth.engA, foreign.id);
    expect([other.status, other.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
    const missing = await timeline(w.auth.engA, randomUUID());
    expect([missing.status, missing.body.error.code]).toEqual([404, 'INCIDENT_NOT_FOUND']);
  });

  it('has no endpoint that writes audit events', async () => {
    const { w, incident } = await fixture();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)
        [method](`/api/v1/incidents/${incident.id}/timeline`)
        .set(w.auth.engA)
        .send({});
      expect(res.status).toBe(404);
    }
    expect(await getPrisma().auditEvent.count()).toBe(0);
  });
});

describe('administrative audit events are not produced by reads, creates or logins', () => {
  it('writes nothing for a login, a team create and reads', async () => {
    const app2 = app;
    const { token } = await adminSession(app2);
    const created = await request(app2)
      .post('/api/v1/identity/teams')
      .set(bearer(token))
      .send({ name: 'Platform' });
    expect(created.status).toBe(201);
    await request(app2).get('/api/v1/identity/teams').set(bearer(token));
    await request(app2).get('/api/v1/incidents').set(bearer(token));
    expect(await getPrisma().auditEvent.count()).toBe(0);
  });
});
