import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import * as sessions from '../../src/modules/identity/auth/session.repository';
import { buildTestApp } from '../helpers/app';
import {
  PASSWORD,
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
const users = '/api/v1/identity/users';
const teamUsers = (teamId: string) => `/api/v1/identity/teams/${teamId}/users`;
const ZERO = '00000000-0000-4000-8000-000000000000';
const USER_KEYS = [
  'createdAt',
  'email',
  'id',
  'leadId',
  'name',
  'role',
  'status',
  'teamId',
  'updatedAt',
];

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'New Person',
  email: `new-${Math.random().toString(36).slice(2, 8)}@example.com`,
  password: PASSWORD,
  ...overrides,
});
const create = (token: string, payload: object) =>
  request(app).post(users).set(bearer(token)).send(payload);
const patch = (token: string, userId: string, payload: object) =>
  request(app).patch(`${users}/${userId}`).set(bearer(token)).send(payload);
const activeSessions = (userId: string) =>
  getPrisma().userSession.count({ where: { userId, revoked: false } });

describe('U1 POST /identity/users', () => {
  it('creates an ACTIVE engineer with a lower-cased email and an Argon2 hash (201)', async () => {
    const { token } = await adminSession(app);
    const res = await create(token, body({ email: 'Person@Example.COM' }));
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data).sort()).toEqual(USER_KEYS);
    expect(res.body.data).toMatchObject({
      email: 'person@example.com',
      role: 'ENGINEER',
      status: 'ACTIVE',
      teamId: null,
      leadId: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/i);

    const stored = await getPrisma().user.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect((await login(app, 'person@example.com')).res.status).toBe(200);
  });

  it('creates a team lead, and an engineer in a team under that lead', async () => {
    const team = await createTeam();
    const { token } = await adminSession(app);
    const lead = await create(token, body({ role: 'TEAM_LEAD', teamId: team.id }));
    expect(lead.status).toBe(201);
    expect(lead.body.data).toMatchObject({ role: 'TEAM_LEAD', teamId: team.id });

    const engineer = await create(token, body({ teamId: team.id, leadId: lead.body.data.id }));
    expect(engineer.status).toBe(201);
    expect(engineer.body.data).toMatchObject({ teamId: team.id, leadId: lead.body.data.id });
  });

  it('requires authentication and the ADMIN role', async () => {
    const team = await createTeam();
    expect((await request(app).post(users).send(body())).status).toBe(401);
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, team.id);
      const res = await create(token, body());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it.each([
    ['ADMIN role', { role: 'ADMIN' }],
    ['short password', { password: 'short' }],
    ['long password', { password: 'x'.repeat(25) }],
    ['invalid email', { email: 'nope' }],
    ['long name', { name: 'x'.repeat(51) }],
    ['empty name', { name: '' }],
    ['malformed teamId', { teamId: 'nope' }],
    ['malformed leadId', { leadId: 'nope' }],
  ])('rejects %s with 422', async (_n, override) => {
    const { token } = await adminSession(app);
    const res = await create(token, body(override));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects unknown fields (such as status) with 400', async () => {
    const { token } = await adminSession(app);
    expect((await create(token, body({ status: 'ACTIVE' }))).status).toBe(400);
  });

  it('rejects invalid team and lead references with 403 INVALID_ACTION', async () => {
    const team = await createTeam();
    const otherTeam = await createTeam();
    const dead = await createTeam('dead', 'DEACTIVATED');
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
    const inactiveLead = await createUser({
      role: 'TEAM_LEAD',
      teamId: team.id,
      status: 'DEACTIVATED',
    });
    const engineer = await createUser({ teamId: team.id });
    const { token } = await adminSession(app);

    const cases: Record<string, unknown>[] = [
      { teamId: ZERO },
      { teamId: dead.id },
      { leadId: lead.id },
      { teamId: otherTeam.id, leadId: lead.id },
      { teamId: team.id, leadId: inactiveLead.id },
      { teamId: team.id, leadId: engineer.id },
      { teamId: team.id, leadId: ZERO },
      { role: 'TEAM_LEAD', teamId: team.id, leadId: lead.id },
    ];
    for (const override of cases) {
      const res = await create(token, body(override));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ACTION');
    }
    expect(await getPrisma().user.count({ where: { name: 'New Person' } })).toBe(0);
  });

  it('rejects a duplicate email (any case) with 409, also under concurrency', async () => {
    const { token } = await adminSession(app);
    await createUser({ email: 'taken@example.com' });
    const dup = await create(token, body({ email: 'TAKEN@example.com' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_ALREADY_EXISTS');

    const race = await Promise.all(
      [1, 2, 3, 4].map(() => create(token, body({ email: 'race@example.com' }))),
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await getPrisma().user.count({ where: { email: 'race@example.com' } })).toBe(1);
  });
});

describe('U2 GET /identity/teams/:teamId/users', () => {
  it('lets an Admin list any team and a Team Lead their own, without passwordHash', async () => {
    const team = await createTeam();
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id, name: 'b-lead' });
    await createUser({ teamId: team.id, leadId: lead.id, name: 'a-eng' });
    const { token: adminToken } = await adminSession(app);
    const { token: leadToken } = await login(app, lead.email);

    for (const token of [adminToken, leadToken]) {
      const res = await request(app).get(teamUsers(team.id)).set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.data.map((u: { name: string }) => u.name)).toEqual(['a-eng', 'b-lead']);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(USER_KEYS);
      expect(res.body.pagination).toEqual({ limit: 10, offset: 0, hasMore: false });
    }
  });

  it('filters, orders and paginates', async () => {
    const team = await createTeam();
    const { token } = await adminSession(app);
    await createUser({ teamId: team.id, name: 'a', role: 'TEAM_LEAD' });
    await createUser({ teamId: team.id, name: 'b' });
    await createUser({ teamId: team.id, name: 'c', status: 'DEACTIVATED' });
    const get = (q: string) =>
      request(app)
        .get(`${teamUsers(team.id)}?${q}`)
        .set(bearer(token));
    const names = (r: { body: { data: { name: string }[] } }) => r.body.data.map((u) => u.name);

    expect(names(await get('role=TEAM_LEAD'))).toEqual(['a']);
    expect(names(await get('status=DEACTIVATED'))).toEqual(['c']);
    expect(names(await get('sort=desc'))).toEqual(['c', 'b', 'a']);
    const page = await get('limit=2');
    expect(names(page)).toEqual(['a', 'b']);
    expect(page.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });
    expect(names(await get('limit=2&offset=2'))).toEqual(['c']);
    expect((await get('role=ADMIN')).status).toBe(422);
    expect((await get('limit=51')).status).toBe(422);
  });

  it('enforces role and team gates', async () => {
    const team = await createTeam();
    const other = await createTeam();
    const get = (token: string, id: string) => request(app).get(teamUsers(id)).set(bearer(token));

    expect((await request(app).get(teamUsers(team.id))).status).toBe(401);

    const engineer = await sessionFor(app, 'ENGINEER', team.id);
    const forbidden = await get(engineer.token, team.id);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN_ROLE');

    const lead = await sessionFor(app, 'TEAM_LEAD', team.id);
    const denied = await get(lead.token, other.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('TEAM_ACCESS_DENIED');

    const teamless = await sessionFor(app, 'TEAM_LEAD', null);
    const nullTeam = await get(teamless.token, team.id);
    expect(nullTeam.status).toBe(403);
    expect(nullTeam.body.error.code).toBe('INVALID_ACTION');
  });

  it('returns 404 TEAM_NOT_FOUND for an Admin and 422 for a malformed id', async () => {
    const { token } = await adminSession(app);
    const missing = await request(app).get(teamUsers(ZERO)).set(bearer(token));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('TEAM_NOT_FOUND');
    expect((await request(app).get(teamUsers('nope')).set(bearer(token))).status).toBe(422);
  });
});

describe('U3 GET /identity/users/:userId', () => {
  it('lets an Admin read any user and a Team Lead users of their own team', async () => {
    const team = await createTeam();
    const other = await createTeam();
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
    const mate = await createUser({ teamId: team.id });
    const stranger = await createUser({ teamId: other.id });
    const { token: adminToken } = await adminSession(app);
    const { token: leadToken } = await login(app, lead.email);

    const own = await request(app).get(`${users}/${mate.id}`).set(bearer(leadToken));
    expect(own.status).toBe(200);
    expect(Object.keys(own.body.data).sort()).toEqual(USER_KEYS);
    expect(JSON.stringify(own.body)).not.toMatch(/passwordHash/);
    expect((await request(app).get(`${users}/${stranger.id}`).set(bearer(adminToken))).status).toBe(
      200,
    );

    const denied = await request(app).get(`${users}/${stranger.id}`).set(bearer(leadToken));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('TEAM_ACCESS_DENIED');
  });

  it('enforces authentication, role, null-team, 404 and 422', async () => {
    const team = await createTeam();
    const user = await createUser({ teamId: team.id });
    expect((await request(app).get(`${users}/${user.id}`)).status).toBe(401);

    const engineer = await sessionFor(app, 'ENGINEER', team.id);
    const byEngineer = await request(app).get(`${users}/${user.id}`).set(bearer(engineer.token));
    expect(byEngineer.status).toBe(403);
    expect(byEngineer.body.error.code).toBe('FORBIDDEN_ROLE');

    const teamless = await sessionFor(app, 'TEAM_LEAD', null);
    const nullTeam = await request(app).get(`${users}/${user.id}`).set(bearer(teamless.token));
    expect(nullTeam.body.error.code).toBe('INVALID_ACTION');

    const { token } = await adminSession(app);
    const missing = await request(app).get(`${users}/${ZERO}`).set(bearer(token));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      code: 'USER_NOT_FOUND',
      details: [{ resource: 'user' }],
    });
    expect((await request(app).get(`${users}/nope`).set(bearer(token))).status).toBe(422);
  });
});

describe('U4 PATCH /identity/users/:userId', () => {
  it('updates the name without revoking sessions and never returns passwordHash', async () => {
    const user = await createUser();
    const { token } = await adminSession(app);
    await login(app, user.email);
    const res = await patch(token, user.id, { name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed');
    expect(Object.keys(res.body.data).sort()).toEqual(USER_KEYS);
    expect(await activeSessions(user.id)).toBe(1);
  });

  it('validates the request and the caller', async () => {
    const team = await createTeam();
    const user = await createUser({ teamId: team.id });
    const { token } = await adminSession(app);

    expect((await patch(token, user.id, {})).status).toBe(422);
    expect((await patch(token, user.id, { password: 'short' })).status).toBe(422);
    expect((await patch(token, user.id, { role: 'ADMIN' })).status).toBe(422);
    expect((await patch(token, user.id, { teamId: 'nope' })).status).toBe(422);
    expect((await patch(token, 'nope', { name: 'x' })).status).toBe(422);
    const immutable = await patch(token, user.id, { email: 'other@example.com' });
    expect(immutable.status).toBe(400);
    expect(immutable.body.error.code).toBe('BAD_REQUEST');

    expect((await request(app).patch(`${users}/${user.id}`).send({ name: 'x' })).status).toBe(401);
    const lead = await sessionFor(app, 'TEAM_LEAD', team.id);
    const forbidden = await patch(lead.token, user.id, { name: 'x' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN_ROLE');

    const missing = await patch(token, ZERO, { name: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('USER_NOT_FOUND');
  });

  describe.each([
    ['password', () => ({ password: 'Another1pass' })],
    ['role', () => ({ role: 'TEAM_LEAD' })],
    ['status', () => ({ status: 'DEACTIVATED' })],
  ])('revokes all sessions on a %s change', (_field, change) => {
    it('revokes every session of the user and nobody else', async () => {
      const team = await createTeam();
      const user = await createUser({ teamId: team.id });
      const bystander = await createUser({ teamId: team.id });
      const { token } = await adminSession(app);
      const first = await login(app, user.email);
      await login(app, user.email);
      await login(app, bystander.email);

      expect((await patch(token, user.id, change())).status).toBe(200);
      expect(await activeSessions(user.id)).toBe(0);
      expect(await activeSessions(bystander.id)).toBe(1);
      expect(
        (
          await request(app)
            .post('/api/v1/auth/refresh')
            .set('Cookie', `ims_refresh_cookie=${first.refresh}`)
        ).status,
      ).toBe(401);
    });
  });

  it('revokes sessions on a teamId change and clears the lead', async () => {
    const from = await createTeam();
    const to = await createTeam();
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: from.id });
    const user = await createUser({ teamId: from.id, leadId: lead.id });
    const { token } = await adminSession(app);
    await login(app, user.email);

    const res = await patch(token, user.id, { teamId: to.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ teamId: to.id, leadId: null });
    expect(await activeSessions(user.id)).toBe(0);
  });

  it('changes the password for real: the new one logs in, the old one does not', async () => {
    const user = await createUser();
    const { token } = await adminSession(app);
    await patch(token, user.id, { password: 'Another1pass' });
    const stored = await getPrisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect((await login(app, user.email, 'Another1pass')).res.status).toBe(200);
    await expect(login(app, user.email, PASSWORD)).rejects.toThrow('401');
  });

  it('deactivates a user so that login returns ACCOUNT_DEACTIVATED, and reactivates', async () => {
    const user = await createUser();
    const { token } = await adminSession(app);
    await patch(token, user.id, { status: 'DEACTIVATED' });
    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(blocked.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    await patch(token, user.id, { status: 'ACTIVE' });
    expect((await login(app, user.email)).res.status).toBe(200);
  });

  it('assigns a lead without revoking sessions, and validates the lead', async () => {
    const team = await createTeam();
    const other = await createTeam();
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
    const foreignLead = await createUser({ role: 'TEAM_LEAD', teamId: other.id });
    const engineer = await createUser({ teamId: team.id });
    const teamless = await createUser();
    const { token } = await adminSession(app);
    await login(app, engineer.email);

    expect((await patch(token, engineer.id, { leadId: lead.id })).body.data.leadId).toBe(lead.id);
    expect(await activeSessions(engineer.id)).toBe(1);

    for (const [target, leadId] of [
      [engineer.id, foreignLead.id],
      [engineer.id, engineer.id],
      [engineer.id, ZERO],
      [teamless.id, lead.id],
      [lead.id, lead.id],
    ]) {
      const res = await patch(token, target, { leadId });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ACTION');
    }
  });

  it('never allows a leadId or a role change on an Admin, but allows other changes', async () => {
    const team = await createTeam();
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
    const otherAdmin = await createUser({ role: 'ADMIN' });
    const { token } = await adminSession(app);

    expect((await patch(token, otherAdmin.id, { leadId: lead.id })).body.error.code).toBe(
      'INVALID_ACTION',
    );
    const role = await patch(token, otherAdmin.id, { role: 'ENGINEER' });
    expect(role.status).toBe(403);
    expect(role.body.error.code).toBe('INVALID_ACTION');

    const ok = await patch(token, otherAdmin.id, { name: 'Root', teamId: team.id });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Root', teamId: team.id, role: 'ADMIN' });
  });

  it('ENGINEER → TEAM_LEAD clears the lead; the reverse is blocked while engineers report', async () => {
    const team = await createTeam();
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
    const engineer = await createUser({ teamId: team.id, leadId: lead.id });
    const { token } = await adminSession(app);

    const promoted = await patch(token, engineer.id, { role: 'TEAM_LEAD' });
    expect(promoted.body.data).toMatchObject({ role: 'TEAM_LEAD', leadId: null });

    const lonely = await createUser({ teamId: team.id, leadId: lead.id });
    const blocked = await patch(token, lead.id, { role: 'ENGINEER' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONFLICT_STILL_HAS_ENGINEERS');
    await getPrisma().user.update({ where: { id: lonely.id }, data: { leadId: null } });
    expect((await patch(token, lead.id, { role: 'ENGINEER' })).status).toBe(200);
  });

  it('blocks deactivating or moving a Team Lead who still has engineers', async () => {
    const team = await createTeam();
    const other = await createTeam();
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
    await createUser({ teamId: team.id, leadId: lead.id });
    const { token } = await adminSession(app);

    for (const change of [{ status: 'DEACTIVATED' }, { teamId: other.id }]) {
      const res = await patch(token, lead.id, change);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_STILL_HAS_ENGINEERS');
    }
  });

  describe('user acknowledgedBy an unresolved incident', () => {
    it.each(['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] as const)(
      'rejects role, team and status changes while a %s incident exists (409)',
      async (incidentStatus) => {
        const team = await createTeam();
        const other = await createTeam();
        const { admin, token } = await adminSession(app);
        const user = await createUser({ teamId: team.id });
        const service = await createService(team.id, admin.id);
        await createIncident(team.id, service.id, incidentStatus, user.id);

        for (const change of [
          { role: 'TEAM_LEAD' },
          { teamId: other.id },
          { status: 'DEACTIVATED' },
        ]) {
          const res = await patch(token, user.id, change);
          expect(res.status).toBe(409);
          expect(res.body.error.code).toBe('USER_ASSIGNED_CURRENTLY');
        }
        expect(await patch(token, user.id, { name: 'still fine' })).toHaveProperty('status', 200);
      },
    );

    it('does not block once the incident is resolved, and setting a first team is always allowed', async () => {
      const team = await createTeam();
      const other = await createTeam();
      const { admin, token } = await adminSession(app);
      const user = await createUser({ teamId: team.id });
      const service = await createService(team.id, admin.id);
      await createIncident(team.id, service.id, 'RESOLVED', user.id);
      expect((await patch(token, user.id, { teamId: other.id })).status).toBe(200);

      const teamless = await createUser();
      const incident = await createIncident(team.id, service.id, 'OPEN', teamless.id);
      expect(incident.status).toBe('OPEN');
      expect((await patch(token, teamless.id, { teamId: team.id })).status).toBe(200);
    });

    it('USER_ASSIGNED_CURRENTLY wins when both 409s apply', async () => {
      const team = await createTeam();
      const { admin, token } = await adminSession(app);
      const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
      await createUser({ teamId: team.id, leadId: lead.id });
      const service = await createService(team.id, admin.id);
      await createIncident(team.id, service.id, 'ACKNOWLEDGED', lead.id);

      const res = await patch(token, lead.id, { status: 'DEACTIVATED' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USER_ASSIGNED_CURRENTLY');
    });
  });

  it('rejects an unknown or deactivated team with 403 INVALID_ACTION', async () => {
    const dead = await createTeam('dead', 'DEACTIVATED');
    const user = await createUser();
    const { token } = await adminSession(app);
    for (const teamId of [ZERO, dead.id]) {
      const res = await patch(token, user.id, { teamId });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ACTION');
    }
  });

  it('rolls back the update when session revocation fails', async () => {
    const user = await createUser();
    const { token } = await adminSession(app);
    await login(app, user.email);
    jest.spyOn(sessions, 'revokeSessionsForUsers').mockRejectedValueOnce(new Error('boom'));

    const res = await patch(token, user.id, { name: 'Changed', status: 'DEACTIVATED' });
    expect(res.status).toBe(500);
    const stored = await getPrisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored).toMatchObject({ name: user.name, status: 'ACTIVE' });
    expect(await activeSessions(user.id)).toBe(1);
  });

  it('keeps the lead invariant when a lead is demoted while an engineer is created under them', async () => {
    for (let round = 0; round < 3; round++) {
      await resetState();
      const team = await createTeam();
      const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
      const { token } = await adminSession(app);

      const [demote, hire] = await Promise.all([
        patch(token, lead.id, { role: 'ENGINEER' }),
        create(token, body({ teamId: team.id, leadId: lead.id })),
      ]);
      expect([demote.status, hire.status].sort()).toEqual(
        demote.status === 200 ? [200, 403] : [201, 409],
      );

      const violations = await getPrisma().$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "User" e JOIN "User" l ON l."id" = e."leadId"
        WHERE l."role" <> 'TEAM_LEAD'`;
      expect(Number(violations[0].n)).toBe(0);
    }
  });
});
