import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import * as sessions from '../../src/modules/identity/auth/session.repository';
import { buildTestApp } from '../helpers/app';
import {
  adminSession,
  bearer,
  createIncident,
  createService,
  createTeam,
  createUser,
  login,
  resetState,
  sessionFor,
} from '../helpers/identity';

const app = buildTestApp();
const api = '/api/v1/identity/teams';

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

const TEAM_KEYS = ['createdAt', 'id', 'name', 'status', 'updatedAt'];

describe('T1 POST /identity/teams', () => {
  it('creates an ACTIVE team (201)', async () => {
    const { token } = await adminSession(app);
    const res = await request(app).post(api).set(bearer(token)).send({ name: 'Platform' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data).sort()).toEqual(TEAM_KEYS);
    expect(res.body.data).toMatchObject({ name: 'Platform', status: 'ACTIVE' });
  });

  it('requires authentication and the ADMIN role', async () => {
    const team = await createTeam();
    expect((await request(app).post(api).send({ name: 'x' })).status).toBe(401);
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, team.id);
      const res = await request(app).post(api).set(bearer(token)).send({ name: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it.each([
    ['empty name', { name: '' }],
    ['name over 50 chars', { name: 'x'.repeat(51) }],
    ['missing name', {}],
    ['non-string name', { name: 5 }],
  ])('rejects %s with 422', async (_n, body) => {
    const { token } = await adminSession(app);
    const res = await request(app).post(api).set(bearer(token)).send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects unknown fields with 400', async () => {
    const { token } = await adminSession(app);
    const res = await request(app)
      .post(api)
      .set(bearer(token))
      .send({ name: 'x', status: 'ACTIVE' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a duplicate name with 409 DUPLICATE_TEAM, also under concurrency', async () => {
    const { token } = await adminSession(app);
    await request(app).post(api).set(bearer(token)).send({ name: 'Dup' });
    const again = await request(app).post(api).set(bearer(token)).send({ name: 'Dup' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_TEAM');

    const race = await Promise.all(
      [1, 2, 3, 4].map(() => request(app).post(api).set(bearer(token)).send({ name: 'Race' })),
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await getPrisma().team.count({ where: { name: 'Race' } })).toBe(1);
  });
});

describe('T2 GET /identity/teams', () => {
  it('returns an empty list as []', async () => {
    const { token } = await adminSession(app);
    const res = await request(app).get(api).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], pagination: { limit: 10, offset: 0, hasMore: false } });
  });

  it('paginates, orders and reports hasMore', async () => {
    const { token } = await adminSession(app);
    for (const name of ['d', 'b', 'a', 'c', 'e']) await createTeam(name);

    const first = await request(app).get(`${api}?limit=2`).set(bearer(token));
    expect(first.body.data.map((t: { name: string }) => t.name)).toEqual(['a', 'b']);
    expect(first.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });

    const last = await request(app).get(`${api}?limit=2&offset=4`).set(bearer(token));
    expect(last.body.data.map((t: { name: string }) => t.name)).toEqual(['e']);
    expect(last.body.pagination.hasMore).toBe(false);

    const desc = await request(app).get(`${api}?sort=desc&limit=2`).set(bearer(token));
    expect(desc.body.data.map((t: { name: string }) => t.name)).toEqual(['e', 'd']);

    const byDate = await request(app).get(`${api}?orderBy=createdAt&sort=desc`).set(bearer(token));
    expect(byDate.body.data[0].name).toBe('e');
  });

  it.each(['limit=51', 'limit=0', 'offset=-1', 'orderBy=status', 'sort=up', 'limit=abc'])(
    'rejects %s with 422',
    async (query) => {
      const { token } = await adminSession(app);
      const res = await request(app).get(`${api}?${query}`).set(bearer(token));
      expect(res.status).toBe(422);
    },
  );

  it('is ADMIN only', async () => {
    const team = await createTeam();
    expect((await request(app).get(api)).status).toBe(401);
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, team.id);
      const res = await request(app).get(api).set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    }
  });
});

describe('T3 GET /identity/teams/:teamId', () => {
  it('lets an Admin read any team and members read their own', async () => {
    const own = await createTeam('own');
    const other = await createTeam('other');
    const { token: adminToken } = await adminSession(app);
    const adminRes = await request(app).get(`${api}/${other.id}`).set(bearer(adminToken));
    expect(adminRes.status).toBe(200);
    expect(Object.keys(adminRes.body.data).sort()).toEqual(TEAM_KEYS);

    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, own.id);
      const res = await request(app).get(`${api}/${own.id}`).set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(own.id);
    }
  });

  it('denies another team with 403 TEAM_ACCESS_DENIED (even if it does not exist)', async () => {
    const own = await createTeam('own');
    const other = await createTeam('other');
    const { token } = await sessionFor(app, 'TEAM_LEAD', own.id);
    const res = await request(app).get(`${api}/${other.id}`).set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TEAM_ACCESS_DENIED');
    const ghost = await request(app)
      .get(`${api}/00000000-0000-4000-8000-000000000000`)
      .set(bearer(token));
    expect(ghost.body.error.code).toBe('TEAM_ACCESS_DENIED');
  });

  it('rejects a non-Admin without a team with 403 INVALID_ACTION', async () => {
    const team = await createTeam();
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, null);
      const res = await request(app).get(`${api}/${team.id}`).set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ACTION');
    }
  });

  it('returns 404 TEAM_NOT_FOUND for an Admin and 422 for a malformed id', async () => {
    const { token } = await adminSession(app);
    const missing = await request(app)
      .get(`${api}/00000000-0000-4000-8000-000000000000`)
      .set(bearer(token));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      code: 'TEAM_NOT_FOUND',
      details: [{ resource: 'team' }],
    });
    expect((await request(app).get(`${api}/not-a-uuid`).set(bearer(token))).status).toBe(422);
  });
});

describe('T4 PATCH /identity/teams/:teamId', () => {
  it('renames a team and updates updatedAt', async () => {
    const team = await createTeam('old');
    const { token } = await adminSession(app);
    const res = await request(app)
      .patch(`${api}/${team.id}`)
      .set(bearer(token))
      .send({ name: 'new' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('new');
    expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThanOrEqual(
      team.updatedAt.getTime(),
    );
  });

  it('validates the body and the role', async () => {
    const team = await createTeam();
    const { token } = await adminSession(app);
    const patch = (body: unknown) =>
      request(app)
        .patch(`${api}/${team.id}`)
        .set(bearer(token))
        .send(body as object);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ name: '' })).status).toBe(422);
    expect((await patch({ status: 'GONE' })).status).toBe(422);
    expect((await patch({ name: 'x', extra: 1 })).status).toBe(400);
    expect(
      (await request(app).patch(`${api}/nope`).set(bearer(token)).send({ name: 'x' })).status,
    ).toBe(422);
    expect((await request(app).patch(`${api}/${team.id}`).send({ name: 'x' })).status).toBe(401);

    const { token: lead } = await sessionFor(app, 'TEAM_LEAD', team.id);
    const forbidden = await request(app)
      .patch(`${api}/${team.id}`)
      .set(bearer(lead))
      .send({ name: 'x' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('returns 404 and 409 DUPLICATE_TEAM', async () => {
    const a = await createTeam('a');
    await createTeam('b');
    const { token } = await adminSession(app);
    const dup = await request(app).patch(`${api}/${a.id}`).set(bearer(token)).send({ name: 'b' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_TEAM');
    const missing = await request(app)
      .patch(`${api}/00000000-0000-4000-8000-000000000000`)
      .set(bearer(token))
      .send({ name: 'z' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('TEAM_NOT_FOUND');
  });

  describe('deactivation', () => {
    it('detaches every user, clears leads and revokes all their sessions atomically', async () => {
      const team = await createTeam();
      const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
      const engineer = await createUser({ teamId: team.id, leadId: lead.id });
      const teamAdmin = await createUser({ role: 'ADMIN', teamId: team.id });
      const outsider = await createUser({ teamId: (await createTeam()).id });
      const engineerSession = await login(app, engineer.email);
      const adminLogin = await login(app, teamAdmin.email);
      const outsiderSession = await login(app, outsider.email);

      const res = await request(app)
        .patch(`${api}/${team.id}`)
        .set(bearer(adminLogin.token))
        .send({ status: 'DEACTIVATED' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('DEACTIVATED');

      const members = await getPrisma().user.findMany({
        where: { id: { in: [lead.id, engineer.id, teamAdmin.id] } },
      });
      for (const member of members) {
        expect(member.teamId).toBeNull();
        expect(member.leadId).toBeNull();
      }
      expect(
        await getPrisma().userSession.count({
          where: { userId: { in: [lead.id, engineer.id, teamAdmin.id] }, revoked: false },
        }),
      ).toBe(0);
      expect(
        (
          await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `ims_refresh_cookie=${engineerSession.refresh}`)
        ).status,
      ).toBe(401);

      const untouched = await getPrisma().user.findUniqueOrThrow({ where: { id: outsider.id } });
      expect(untouched.teamId).toBe(outsider.teamId);
      expect(
        (
          await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `ims_refresh_cookie=${outsiderSession.refresh}`)
        ).status,
      ).toBe(200);
    });

    it('does not restore users on reactivation', async () => {
      const team = await createTeam();
      const user = await createUser({ teamId: team.id });
      const { token } = await adminSession(app);
      await request(app)
        .patch(`${api}/${team.id}`)
        .set(bearer(token))
        .send({ status: 'DEACTIVATED' });
      const res = await request(app)
        .patch(`${api}/${team.id}`)
        .set(bearer(token))
        .send({ status: 'ACTIVE' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(
        (await getPrisma().user.findUniqueOrThrow({ where: { id: user.id } })).teamId,
      ).toBeNull();
    });

    it.each(['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] as const)(
      'is blocked by a %s incident with 409 TEAM_WITH_OPEN_INCIDENT',
      async (status) => {
        const team = await createTeam();
        const { admin, token } = await adminSession(app);
        const service = await createService(team.id, admin.id);
        await createIncident(team.id, service.id, status);
        const res = await request(app)
          .patch(`${api}/${team.id}`)
          .set(bearer(token))
          .send({ status: 'DEACTIVATED' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('TEAM_WITH_OPEN_INCIDENT');
        expect((await getPrisma().team.findUniqueOrThrow({ where: { id: team.id } })).status).toBe(
          'ACTIVE',
        );
      },
    );

    it('is blocked by attached services with 403 INVALID_ACTION, and resolved incidents do not block', async () => {
      const team = await createTeam();
      const { admin, token } = await adminSession(app);
      const service = await createService(team.id, admin.id);
      await createIncident(team.id, service.id, 'RESOLVED');
      await createIncident(team.id, service.id, 'CLOSED');
      const res = await request(app)
        .patch(`${api}/${team.id}`)
        .set(bearer(token))
        .send({ status: 'DEACTIVATED' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ACTION');
    });

    it('reports TEAM_WITH_OPEN_INCIDENT when both blockers apply', async () => {
      const team = await createTeam();
      const { admin, token } = await adminSession(app);
      const service = await createService(team.id, admin.id);
      await createIncident(team.id, service.id, 'OPEN');
      const res = await request(app)
        .patch(`${api}/${team.id}`)
        .set(bearer(token))
        .send({ status: 'DEACTIVATED' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TEAM_WITH_OPEN_INCIDENT');
    });

    it('rolls back everything when a step fails mid-transaction', async () => {
      const team = await createTeam();
      const user = await createUser({ teamId: team.id });
      const { token } = await adminSession(app);
      const { refresh } = await login(app, user.email);
      jest.spyOn(sessions, 'revokeSessionsForUsers').mockRejectedValueOnce(new Error('boom'));

      const res = await request(app)
        .patch(`${api}/${team.id}`)
        .set(bearer(token))
        .send({ name: 'renamed', status: 'DEACTIVATED' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');

      const after = await getPrisma().team.findUniqueOrThrow({ where: { id: team.id } });
      expect(after).toMatchObject({ status: 'ACTIVE', name: team.name });
      expect((await getPrisma().user.findUniqueOrThrow({ where: { id: user.id } })).teamId).toBe(
        team.id,
      );
      expect(
        (
          await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `ims_refresh_cookie=${refresh}`)
        ).status,
      ).toBe(200);
    });
  });
});
