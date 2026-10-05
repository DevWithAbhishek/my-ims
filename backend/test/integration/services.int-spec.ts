import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import { getEscalationPolicyByService, getServiceConfig } from '../../src/modules/appService';
import { buildTestApp } from '../helpers/app';
import {
  adminSession,
  bearer,
  createIncident,
  createService,
  createTeam,
  createUser,
  resetState,
  sessionFor,
} from '../helpers/identity';
import { testDatabaseUrl } from '../helpers/test-env';

const app = buildTestApp();
const api = '/api/v1/services';
const NIL = '00000000-0000-4000-8000-000000000000';

beforeEach(resetState);
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

const SLA = {
  P0ResponseSlaMinutes: 5,
  P0ResolutionSlaMinutes: 30,
  P1ResponseSlaMinutes: 10,
  P1ResolutionSlaMinutes: 60,
  P2ResponseSlaMinutes: 30,
  P2ResolutionSlaMinutes: 120,
  P3ResponseSlaMinutes: 60,
  P3ResolutionSlaMinutes: 240,
};

const SERVICE_KEYS = [
  'createdAt',
  'defaultSeverity',
  'escalationPolicyId',
  'id',
  'name',
  'status',
  'teamId',
  'updatedAt',
  ...Object.keys(SLA),
].sort();
const POLICY_KEYS = ['createdAt', 'fallbackAdmin', 'id', 'level1', 'level2', 'level3', 'updatedAt'];

/** A team with the users an escalation policy needs. */
async function kit() {
  const team = await createTeam();
  const engineer1 = await createUser({ role: 'ENGINEER', teamId: team.id });
  const engineer2 = await createUser({ role: 'ENGINEER', teamId: team.id });
  const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
  return { team, engineer1, engineer2, lead };
}
type Kit = Awaited<ReturnType<typeof kit>>;

function createBody(k: Kit, adminId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: `svc-${randomUUID().slice(0, 8)}`,
    ...SLA,
    teamId: k.team.id,
    escalationPolicy: {
      level1: k.engineer1.id,
      level2: k.engineer2.id,
      level3: k.lead.id,
      fallbackAdmin: adminId,
    },
    ...overrides,
  };
}

type CreatedService = { id: string; name: string; teamId: string; escalationPolicyId: string };

/** An admin session plus a service created through S1. */
async function setup() {
  const k = await kit();
  const admin = await adminSession(app);
  const res = await request(app)
    .post(api)
    .set(bearer(admin.token))
    .send(createBody(k, admin.admin.id));
  expect(res.status).toBe(201);
  return { k, admin, service: res.body.data as CreatedService };
}

const patchService = (token: string, id: string, body: unknown) =>
  request(app)
    .patch(`${api}/${id}`)
    .set(bearer(token))
    .send(body as object);
const policyUrl = (serviceId: string, policyId: string) =>
  `${api}/${serviceId}/escalation-policies/${policyId}`;

describe('S1 POST /services', () => {
  it('creates an ACTIVE service with its policy in one request (201)', async () => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const res = await request(app)
      .post(api)
      .set(bearer(token))
      .send(createBody(k, admin.id, { name: 'checkout' }));

    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data).sort()).toEqual(SERVICE_KEYS);
    expect(res.body.data).toMatchObject({
      name: 'checkout',
      status: 'ACTIVE',
      defaultSeverity: 'P1',
      teamId: k.team.id,
      ...SLA,
    });
    const policy = await getPrisma().escalationPolicy.findUniqueOrThrow({
      where: { id: res.body.data.escalationPolicyId },
    });
    expect(policy).toMatchObject({
      level1Id: k.engineer1.id,
      level2Id: k.engineer2.id,
      level3Id: k.lead.id,
      fallbackAdminId: admin.id,
    });
  });

  it('stores an explicit defaultSeverity', async () => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const res = await request(app)
      .post(api)
      .set(bearer(token))
      .send(createBody(k, admin.id, { defaultSeverity: 'P0' }));
    expect(res.body.data.defaultSeverity).toBe('P0');
  });

  it('accepts an admin of another team (or of none) as fallbackAdmin', async () => {
    const k = await kit();
    const { token } = await adminSession(app);
    const otherAdmin = await createUser({ role: 'ADMIN', teamId: (await createTeam()).id });
    const res = await request(app).post(api).set(bearer(token)).send(createBody(k, otherAdmin.id));
    expect(res.status).toBe(201);
  });

  it('requires authentication and the ADMIN role', async () => {
    const k = await kit();
    const { admin } = await adminSession(app);
    expect((await request(app).post(api).send(createBody(k, admin.id))).status).toBe(401);
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, k.team.id);
      const res = await request(app).post(api).set(bearer(token)).send(createBody(k, admin.id));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it.each([
    ['empty name', { name: '' }],
    ['name over 50 chars', { name: 'x'.repeat(51) }],
    ['missing name', { name: undefined }],
    ['missing SLA field', { P2ResolutionSlaMinutes: undefined }],
    ['zero SLA value', { P0ResponseSlaMinutes: 0 }],
    ['negative SLA value', { P1ResponseSlaMinutes: -5 }],
    ['non-integer SLA value', { P3ResponseSlaMinutes: 1.5 }],
    ['resolution below response', { P0ResolutionSlaMinutes: 4 }],
    ['invalid defaultSeverity', { defaultSeverity: 'P9' }],
    ['non-uuid teamId', { teamId: 'nope' }],
    ['missing escalationPolicy', { escalationPolicy: undefined }],
    [
      'non-uuid policy user',
      { escalationPolicy: { level1: 'x', level2: NIL, level3: NIL, fallbackAdmin: NIL } },
    ],
    ['incomplete policy', { escalationPolicy: { level1: NIL } }],
  ])('rejects %s with 422', async (_name, override) => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const res = await request(app)
      .post(api)
      .set(bearer(token))
      .send(createBody(k, admin.id, override));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await getPrisma().appService.count()).toBe(0);
  });

  it.each([
    ['unknown field', { status: 'ACTIVE' }],
    ['timing field on the service', { escalationDelayMinutes: 5 }],
    ['timing field inside the policy', { escalationPolicy: { delayMinutes: 5 } }],
  ])('rejects %s with 400', async (_name, extra) => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const base = createBody(k, admin.id);
    const body =
      'escalationPolicy' in extra
        ? { ...base, escalationPolicy: { ...base.escalationPolicy, ...extra.escalationPolicy } }
        : { ...base, ...extra };
    const res = await request(app).post(api).set(bearer(token)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects malformed JSON and a non-JSON content type with 400', async () => {
    const { token } = await adminSession(app);
    const malformed = await request(app)
      .post(api)
      .set(bearer(token))
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(malformed.status).toBe(400);
    const wrongType = await request(app)
      .post(api)
      .set(bearer(token))
      .set('Content-Type', 'text/plain')
      .send('name=x');
    expect(wrongType.status).toBe(400);
  });

  it('rejects a missing or deactivated team with 403 INVALID_ACTION', async () => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const missing = await request(app)
      .post(api)
      .set(bearer(token))
      .send(createBody(k, admin.id, { teamId: NIL }));
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('INVALID_ACTION');

    await getPrisma().team.update({ where: { id: k.team.id }, data: { status: 'DEACTIVATED' } });
    const deactivated = await request(app)
      .post(api)
      .set(bearer(token))
      .send(createBody(k, admin.id));
    expect(deactivated.status).toBe(403);
    expect(deactivated.body.error.code).toBe('INVALID_ACTION');
  });

  it('validates the policy user of each level (role, team, status) with 403 INVALID_ACTION', async () => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const otherTeam = await createTeam();
    const foreignEngineer = await createUser({ role: 'ENGINEER', teamId: otherTeam.id });
    const foreignLead = await createUser({ role: 'TEAM_LEAD', teamId: otherTeam.id });
    const inactive = await createUser({
      role: 'ENGINEER',
      teamId: k.team.id,
      status: 'DEACTIVATED',
    });
    const policy = (patch: object) => ({
      level1: k.engineer1.id,
      level2: k.engineer2.id,
      level3: k.lead.id,
      fallbackAdmin: admin.id,
      ...patch,
    });
    const cases: [string, object][] = [
      ['level1 is a team lead', policy({ level1: k.lead.id })],
      ['level1 is of another team', policy({ level1: foreignEngineer.id })],
      ['level1 is deactivated', policy({ level1: inactive.id })],
      ['level2 is an admin', policy({ level2: admin.id })],
      ['level2 is of another team', policy({ level2: foreignEngineer.id })],
      ['level2 does not exist', policy({ level2: NIL })],
      ['level3 is an engineer', policy({ level3: k.engineer1.id })],
      ['level3 is of another team', policy({ level3: foreignLead.id })],
      ['fallbackAdmin is a team lead', policy({ fallbackAdmin: k.lead.id })],
    ];
    for (const [label, escalationPolicy] of cases) {
      const res = await request(app)
        .post(api)
        .set(bearer(token))
        .send(createBody(k, admin.id, { escalationPolicy }));
      expect([label, res.status, res.body.error?.code]).toEqual([label, 403, 'INVALID_ACTION']);
    }
    const deactivatedAdmin = await createUser({ role: 'ADMIN', status: 'DEACTIVATED' });
    const res = await request(app)
      .post(api)
      .set(bearer(token))
      .send(
        createBody(k, admin.id, {
          escalationPolicy: policy({ fallbackAdmin: deactivatedAdmin.id }),
        }),
      );
    expect(res.status).toBe(403);
  });

  it('is atomic: an invalid policy user or a duplicate name leaves no service or policy rows', async () => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const bad = await request(app)
      .post(api)
      .set(bearer(token))
      .send(
        createBody(k, admin.id, {
          escalationPolicy: {
            level1: k.lead.id,
            level2: k.engineer2.id,
            level3: k.lead.id,
            fallbackAdmin: admin.id,
          },
        }),
      );
    expect(bad.status).toBe(403);
    expect([
      await getPrisma().appService.count(),
      await getPrisma().escalationPolicy.count(),
    ]).toEqual([0, 0]);

    await request(app)
      .post(api)
      .set(bearer(token))
      .send(createBody(k, admin.id, { name: 'dup' }));
    const dup = await request(app)
      .post(api)
      .set(bearer(token))
      .send(createBody(k, admin.id, { name: 'dup' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SERVICE_ALREADY_EXISTS');
    expect([
      await getPrisma().appService.count(),
      await getPrisma().escalationPolicy.count(),
    ]).toEqual([1, 1]);
  });

  it('waits for a concurrent team deactivation that holds the team row lock', async () => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT "id" FROM "Team" WHERE "id" = $1 FOR UPDATE', [k.team.id]);
      await client.query(`UPDATE "Team" SET "status" = 'DEACTIVATED' WHERE "id" = $1`, [k.team.id]);

      let settled = false;
      const pending = request(app)
        .post(api)
        .set(bearer(token))
        .send(createBody(k, admin.id))
        .then((res) => {
          settled = true;
          return res;
        });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await client.query('COMMIT');
      const res = await pending;
      expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ACTION']);
      expect(await getPrisma().appService.count()).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('has a single winner for concurrent creates with the same name', async () => {
    const k = await kit();
    const { token, admin } = await adminSession(app);
    const responses = await Promise.all(
      [1, 2, 3, 4].map(() =>
        request(app)
          .post(api)
          .set(bearer(token))
          .send(createBody(k, admin.id, { name: 'race' })),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of responses.filter((r) => r.status !== 201)) {
      expect([r.status, r.body.error.code]).toEqual([409, 'SERVICE_ALREADY_EXISTS']);
    }
    expect(await getPrisma().escalationPolicy.count()).toBe(1);
  });
});

describe('S2 GET /services', () => {
  it('lets an admin list every team and filter by teamId', async () => {
    const admin = await adminSession(app);
    const a = await createTeam();
    const b = await createTeam();
    await createService(a.id, admin.admin.id);
    await createService(a.id, admin.admin.id);
    await createService(b.id, admin.admin.id);

    const all = await request(app).get(api).set(bearer(admin.token));
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(3);
    expect(Object.keys(all.body.data[0]).sort()).toEqual(SERVICE_KEYS);
    expect(all.body.pagination).toEqual({ limit: 10, offset: 0, hasMore: false });

    const filtered = await request(app).get(`${api}?teamId=${b.id}`).set(bearer(admin.token));
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].teamId).toBe(b.id);
  });

  it('shows team leads and engineers only their own team', async () => {
    const { admin } = await adminSession(app);
    const a = await createTeam();
    const b = await createTeam();
    await createService(a.id, admin.id);
    await createService(b.id, admin.id);
    for (const role of ['TEAM_LEAD', 'ENGINEER'] as const) {
      const { token } = await sessionFor(app, role, a.id);
      const res = await request(app).get(api).set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.data.map((s: { teamId: string }) => s.teamId)).toEqual([a.id]);
      const own = await request(app).get(`${api}?teamId=${a.id}`).set(bearer(token));
      expect(own.body.data).toHaveLength(1);
      const other = await request(app).get(`${api}?teamId=${b.id}`).set(bearer(token));
      expect(other.status).toBe(403);
      expect(other.body.error.code).toBe('TEAM_ACCESS_DENIED');
    }
  });

  it('rejects a non-admin without a team with 403 INVALID_ACTION', async () => {
    const { token } = await sessionFor(app, 'ENGINEER', null);
    const res = await request(app).get(api).set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_ACTION');
    const admin = await adminSession(app, null);
    expect((await request(app).get(api).set(bearer(admin.token))).status).toBe(200);
  });

  it('paginates, sorts with an id tie-breaker and validates the query', async () => {
    const admin = await adminSession(app);
    const team = await createTeam();
    for (let i = 0; i < 3; i++) await createService(team.id, admin.admin.id);

    const first = await request(app).get(`${api}?limit=2`).set(bearer(admin.token));
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });
    const second = await request(app).get(`${api}?limit=2&offset=2`).set(bearer(admin.token));
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pagination.hasMore).toBe(false);

    const asc = await request(app).get(`${api}?orderBy=name&sort=asc`).set(bearer(admin.token));
    const desc = await request(app).get(`${api}?orderBy=name&sort=desc`).set(bearer(admin.token));
    const names = asc.body.data.map((s: { name: string }) => s.name);
    expect(names).toEqual([...names].sort());
    expect(desc.body.data.map((s: { name: string }) => s.name)).toEqual([...names].reverse());

    for (const query of [
      'limit=51',
      'limit=0',
      'offset=-1',
      'orderBy=status',
      'sort=up',
      'teamId=x',
    ]) {
      const res = await request(app).get(`${api}?${query}`).set(bearer(admin.token));
      expect([query, res.status]).toEqual([query, 422]);
    }
    expect((await request(app).get(`${api}?bogus=1`).set(bearer(admin.token))).status).toBe(400);
    expect((await request(app).get(api)).status).toBe(401);
  });
});

describe('S3 GET /services/:serviceId', () => {
  it('returns the service to an admin and to the owning team', async () => {
    const { k, admin, service } = await setup();
    const asAdmin = await request(app).get(`${api}/${service.id}`).set(bearer(admin.token));
    expect(asAdmin.status).toBe(200);
    expect(Object.keys(asAdmin.body.data).sort()).toEqual(SERVICE_KEYS);
    for (const role of ['TEAM_LEAD', 'ENGINEER'] as const) {
      const { token } = await sessionFor(app, role, k.team.id);
      expect((await request(app).get(`${api}/${service.id}`).set(bearer(token))).status).toBe(200);
    }
  });

  it('enforces team isolation, the null-team rule, 404 and path validation', async () => {
    const { admin, service } = await setup();
    const other = await createTeam();
    const foreign = await sessionFor(app, 'TEAM_LEAD', other.id);
    const denied = await request(app).get(`${api}/${service.id}`).set(bearer(foreign.token));
    expect([denied.status, denied.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);

    const noTeam = await sessionFor(app, 'ENGINEER', null);
    const invalid = await request(app).get(`${api}/${service.id}`).set(bearer(noTeam.token));
    expect([invalid.status, invalid.body.error.code]).toEqual([403, 'INVALID_ACTION']);

    const missing = await request(app).get(`${api}/${NIL}`).set(bearer(admin.token));
    expect([missing.status, missing.body.error.code]).toEqual([404, 'SERVICE_NOT_FOUND']);
    expect(missing.body.error.details).toEqual([{ resource: 'service' }]);

    expect((await request(app).get(`${api}/not-a-uuid`).set(bearer(admin.token))).status).toBe(422);
    expect((await request(app).get(`${api}/${service.id}`)).status).toBe(401);
  });
});

describe('S4 PATCH /services/:serviceId', () => {
  it('updates name, defaultSeverity and status (including reactivation)', async () => {
    const { admin, service } = await setup();
    const res = await patchService(admin.token, service.id, {
      name: 'renamed',
      defaultSeverity: 'P2',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'renamed', defaultSeverity: 'P2' });
    expect(Object.keys(res.body.data).sort()).toEqual(SERVICE_KEYS);

    const off = await patchService(admin.token, service.id, { status: 'DEACTIVATED' });
    expect(off.body.data.status).toBe('DEACTIVATED');
    const on = await patchService(admin.token, service.id, { status: 'ACTIVE' });
    expect(on.body.data.status).toBe('ACTIVE');
  });

  it('applies partial SLA updates and validates ordering on the merged values', async () => {
    const { admin, service } = await setup();
    const ok = await patchService(admin.token, service.id, { P1ResponseSlaMinutes: 20 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ P1ResponseSlaMinutes: 20, P1ResolutionSlaMinutes: 60 });

    const raiseResponse = await patchService(admin.token, service.id, { P1ResponseSlaMinutes: 61 });
    expect([raiseResponse.status, raiseResponse.body.error.code]).toEqual([
      422,
      'VALIDATION_FAILED',
    ]);
    expect(raiseResponse.body.error.details).toEqual([
      { field: 'P1ResolutionSlaMinutes', issue: expect.any(String) },
    ]);
    const lowerResolution = await patchService(admin.token, service.id, {
      P0ResolutionSlaMinutes: 4,
    });
    expect(lowerResolution.status).toBe(422);
    const bothInvalid = await patchService(admin.token, service.id, {
      P2ResponseSlaMinutes: 50,
      P2ResolutionSlaMinutes: 40,
    });
    expect(bothInvalid.status).toBe(422);
    const bothValid = await patchService(admin.token, service.id, {
      P2ResponseSlaMinutes: 500,
      P2ResolutionSlaMinutes: 600,
    });
    expect(bothValid.status).toBe(200);
    const stored = await getPrisma().appService.findUniqueOrThrow({ where: { id: service.id } });
    expect(stored.P1ResolutionSlaMinutes).toBe(60);
  });

  it('validates the body and the gates', async () => {
    const { k, admin, service } = await setup();
    for (const body of [
      {},
      { name: '' },
      { teamId: 'x' },
      { escalationPolicyId: 'x' },
      { status: 'GONE' },
    ]) {
      const res = await patchService(admin.token, service.id, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    for (const body of [{ bogus: 1 }, { name: 'x', escalationDelayMinutes: 5 }]) {
      expect((await patchService(admin.token, service.id, body)).status).toBe(400);
    }
    expect((await patchService(admin.token, 'nope', { name: 'x' })).status).toBe(422);
    expect((await request(app).patch(`${api}/${service.id}`).send({ name: 'x' })).status).toBe(401);
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, k.team.id);
      const res = await patchService(token, service.id, { name: 'x' });
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
    }
    const missing = await patchService(admin.token, NIL, { name: 'x' });
    expect([missing.status, missing.body.error.code]).toEqual([404, 'SERVICE_NOT_FOUND']);
  });

  it('rejects a duplicate name with 409 SERVICE_ALREADY_EXISTS', async () => {
    const { k, admin, service } = await setup();
    const other = await request(app)
      .post(api)
      .set(bearer(admin.token))
      .send(createBody(k, admin.admin.id, { name: 'taken' }));
    expect(other.status).toBe(201);
    const res = await patchService(admin.token, service.id, { name: 'taken' });
    expect([res.status, res.body.error.code]).toEqual([409, 'SERVICE_ALREADY_EXISTS']);
    expect((await patchService(admin.token, service.id, { name: service.name })).status).toBe(200);
  });

  it.each(['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] as const)(
    'blocks deactivation, SLA change and policy reassignment while an incident is %s',
    async (status) => {
      const { k, admin, service } = await setup();
      await createIncident(k.team.id, service.id, status);
      const orphan = await getPrisma().escalationPolicy.create({
        data: {
          level1Id: k.engineer1.id,
          level2Id: k.engineer2.id,
          level3Id: k.lead.id,
          fallbackAdminId: admin.admin.id,
        },
      });
      for (const body of [
        { status: 'DEACTIVATED' },
        { P0ResponseSlaMinutes: 6 },
        { escalationPolicyId: orphan.id },
      ]) {
        const res = await patchService(admin.token, service.id, body);
        expect([JSON.stringify(body), res.status, res.body.error.code]).toEqual([
          JSON.stringify(body),
          409,
          'SERVICE_HAS_OPEN_INCIDENTS',
        ]);
      }
      const rename = await patchService(admin.token, service.id, {
        name: 'still-fine',
        defaultSeverity: 'P3',
      });
      expect(rename.status).toBe(200);
      const same = await patchService(admin.token, service.id, {
        P0ResponseSlaMinutes: 5,
        status: 'ACTIVE',
      });
      expect(same.status).toBe(200);
    },
  );

  it('does not treat RESOLVED or CLOSED incidents as unresolved', async () => {
    const { k, admin, service } = await setup();
    await createIncident(k.team.id, service.id, 'RESOLVED');
    await createIncident(k.team.id, service.id, 'CLOSED');
    const res = await patchService(admin.token, service.id, {
      status: 'DEACTIVATED',
      P0ResponseSlaMinutes: 6,
    });
    expect(res.status).toBe(200);
  });

  it('changes the team when no incident exists and the team is active', async () => {
    const { admin, service } = await setup();
    const target = await createTeam();
    const res = await patchService(admin.token, service.id, { teamId: target.id });
    expect(res.status).toBe(200);
    expect(res.body.data.teamId).toBe(target.id);
  });

  it('rejects an unknown or deactivated target team with 403 INVALID_ACTION', async () => {
    const { admin, service } = await setup();
    const inactive = await createTeam(undefined, 'DEACTIVATED');
    for (const teamId of [NIL, inactive.id]) {
      const res = await patchService(admin.token, service.id, { teamId });
      expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    }
  });

  it.each(['RESOLVED', 'CLOSED', 'OPEN'] as const)(
    'rejects a team change while a %s incident exists with 403 INVALID_ACTION (wins over 409)',
    async (status) => {
      const { k, admin, service } = await setup();
      await createIncident(k.team.id, service.id, status);
      const target = await createTeam();
      const res = await patchService(admin.token, service.id, { teamId: target.id });
      expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    },
  );

  it('keeps the composite foreign key that pins an incident to its service team', async () => {
    const { k, service } = await setup();
    await createIncident(k.team.id, service.id, 'CLOSED');
    const target = await createTeam();
    await expect(
      getPrisma().appService.update({ where: { id: service.id }, data: { teamId: target.id } }),
    ).rejects.toThrow();
  });

  it('reassigns an orphaned policy and keeps the previous one, unattached', async () => {
    const { k, admin, service } = await setup();
    const orphan = await getPrisma().escalationPolicy.create({
      data: {
        level1Id: k.engineer1.id,
        level2Id: k.engineer2.id,
        level3Id: k.lead.id,
        fallbackAdminId: admin.admin.id,
      },
    });
    const previous = service.escalationPolicyId as string;

    const res = await patchService(admin.token, service.id, { escalationPolicyId: orphan.id });
    expect(res.status).toBe(200);
    expect(res.body.data.escalationPolicyId).toBe(orphan.id);

    const kept = await getPrisma().escalationPolicy.findUniqueOrThrow({
      where: { id: previous },
      include: { appService: true },
    });
    expect(kept.appService).toBeNull();

    const old = await request(app).get(policyUrl(service.id, previous)).set(bearer(admin.token));
    expect(old.status).toBe(404);
    const current = await request(app)
      .get(policyUrl(service.id, orphan.id))
      .set(bearer(admin.token));
    expect(current.status).toBe(200);
  });

  it('rejects an unknown policy with 404 and a policy of another service with 403', async () => {
    const { k, admin, service } = await setup();
    const unknown = await patchService(admin.token, service.id, { escalationPolicyId: NIL });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'ESCALATION_POLICY_NOT_FOUND']);

    const second = await request(app)
      .post(api)
      .set(bearer(admin.token))
      .send(createBody(k, admin.admin.id));
    const attached = await patchService(admin.token, service.id, {
      escalationPolicyId: second.body.data.escalationPolicyId,
    });
    expect([attached.status, attached.body.error.code]).toEqual([403, 'INVALID_ACTION']);
  });

  it('lets only one of two services claim the same orphaned policy', async () => {
    const { k, admin, service } = await setup();
    const second = await request(app)
      .post(api)
      .set(bearer(admin.token))
      .send(createBody(k, admin.admin.id));
    const orphan = await getPrisma().escalationPolicy.create({
      data: {
        level1Id: k.engineer1.id,
        level2Id: k.engineer2.id,
        level3Id: k.lead.id,
        fallbackAdminId: admin.admin.id,
      },
    });
    const results = await Promise.all(
      [service.id, second.body.data.id].map((id) =>
        patchService(admin.token, id, { escalationPolicyId: orphan.id }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it('serializes with incident creation: a deactivation waits for an in-flight incident insert', async () => {
    const { k, admin, service } = await setup();
    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "Incident" ("id","title","description","severity","affectedServiceId","teamId")
         VALUES (gen_random_uuid(),'t','d','P1',$1,$2)`,
        [service.id, k.team.id],
      );

      let settled = false;
      const pending = patchService(admin.token, service.id, { status: 'DEACTIVATED' }).then(
        (res) => {
          settled = true;
          return res;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await client.query('COMMIT');
      const res = await pending;
      expect([res.status, res.body.error.code]).toEqual([409, 'SERVICE_HAS_OPEN_INCIDENTS']);
    } finally {
      await client.end();
    }
  });

  it('yields a consistent outcome for deactivation racing direct incident inserts', async () => {
    const { k, admin } = await setup();
    for (let round = 0; round < 6; round++) {
      const created = await request(app)
        .post(api)
        .set(bearer(admin.token))
        .send(createBody(k, admin.admin.id));
      const id = created.body.data.id as string;
      const [res] = await Promise.all([
        patchService(admin.token, id, { status: 'DEACTIVATED' }),
        createIncident(k.team.id, id, 'OPEN'),
      ]);
      const stored = await getPrisma().appService.findUniqueOrThrow({ where: { id } });
      if (res.status === 200) {
        expect(stored.status).toBe('DEACTIVATED');
      } else {
        expect([res.status, res.body.error.code]).toEqual([409, 'SERVICE_HAS_OPEN_INCIDENTS']);
        expect(stored.status).toBe('ACTIVE');
      }
    }
  });
});

describe('S5 POST /services/:serviceId/escalation-policies', () => {
  const policyBody = (k: Kit, adminId: string) => ({
    level1: k.engineer1.id,
    level2: k.engineer2.id,
    level3: k.lead.id,
    fallbackAdmin: adminId,
  });

  it('always answers 409 POLICIES_MAX_LIMIT_REACHED for a valid request and creates nothing', async () => {
    const { k, admin, service } = await setup();
    const res = await request(app)
      .post(`${api}/${service.id}/escalation-policies`)
      .set(bearer(admin.token))
      .send(policyBody(k, admin.admin.id));
    expect([res.status, res.body.error.code]).toEqual([409, 'POLICIES_MAX_LIMIT_REACHED']);
    expect(await getPrisma().escalationPolicy.count()).toBe(1);
  });

  it('validates the body, the path and the gates', async () => {
    const { k, admin, service } = await setup();
    const url = `${api}/${service.id}/escalation-policies`;
    const valid = policyBody(k, admin.admin.id);
    expect(
      (await request(app).post(url).set(bearer(admin.token)).send({ level1: valid.level1 })).status,
    ).toBe(422);
    expect(
      (
        await request(app)
          .post(url)
          .set(bearer(admin.token))
          .send({ ...valid, level1: 'x' })
      ).status,
    ).toBe(422);
    const timing = await request(app)
      .post(url)
      .set(bearer(admin.token))
      .send({ ...valid, delayMinutes: 5 });
    expect(timing.status).toBe(400);
    expect(
      (
        await request(app)
          .post(`${api}/bad/escalation-policies`)
          .set(bearer(admin.token))
          .send(valid)
      ).status,
    ).toBe(422);
    const missing = await request(app)
      .post(`${api}/${NIL}/escalation-policies`)
      .set(bearer(admin.token))
      .send(valid);
    expect([missing.status, missing.body.error.code]).toEqual([404, 'SERVICE_NOT_FOUND']);
    expect((await request(app).post(url).send(valid)).status).toBe(401);
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, k.team.id);
      const res = await request(app).post(url).set(bearer(token)).send(valid);
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
    }
  });
});

describe('S6 GET /services/:serviceId/escalation-policies/:escalationPolicyId', () => {
  it('returns the policy to an admin and to a lead of the owning team', async () => {
    const { k, admin, service } = await setup();
    const url = policyUrl(service.id, service.escalationPolicyId);
    const asAdmin = await request(app).get(url).set(bearer(admin.token));
    expect(asAdmin.status).toBe(200);
    expect(Object.keys(asAdmin.body.data).sort()).toEqual(POLICY_KEYS);
    expect(asAdmin.body.data).toMatchObject({
      id: service.escalationPolicyId,
      level1: k.engineer1.id,
      level2: k.engineer2.id,
      level3: k.lead.id,
      fallbackAdmin: admin.admin.id,
    });
    const { token } = await sessionFor(app, 'TEAM_LEAD', k.team.id);
    expect((await request(app).get(url).set(bearer(token))).status).toBe(200);
  });

  it('enforces the role, team and null-team gates', async () => {
    const { k, service } = await setup();
    const url = policyUrl(service.id, service.escalationPolicyId);
    const engineer = await sessionFor(app, 'ENGINEER', k.team.id);
    const eng = await request(app).get(url).set(bearer(engineer.token));
    expect([eng.status, eng.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
    const engineerNoTeam = await sessionFor(app, 'ENGINEER', null);
    expect((await request(app).get(url).set(bearer(engineerNoTeam.token))).body.error.code).toBe(
      'FORBIDDEN_ROLE',
    );

    const foreign = await sessionFor(app, 'TEAM_LEAD', (await createTeam()).id);
    const denied = await request(app).get(url).set(bearer(foreign.token));
    expect([denied.status, denied.body.error.code]).toEqual([403, 'TEAM_ACCESS_DENIED']);
    const noTeam = await sessionFor(app, 'TEAM_LEAD', null);
    const invalid = await request(app).get(url).set(bearer(noTeam.token));
    expect([invalid.status, invalid.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    expect((await request(app).get(url)).status).toBe(401);
  });

  it('answers 404 for an unknown service, an unknown policy and a policy of another service', async () => {
    const { k, admin, service } = await setup();
    const other = await request(app)
      .post(api)
      .set(bearer(admin.token))
      .send(createBody(k, admin.admin.id));
    const missingService = await request(app)
      .get(policyUrl(NIL, service.escalationPolicyId))
      .set(bearer(admin.token));
    expect([missingService.status, missingService.body.error.code]).toEqual([
      404,
      'SERVICE_NOT_FOUND',
    ]);
    const unknownPolicy = await request(app)
      .get(policyUrl(service.id, NIL))
      .set(bearer(admin.token));
    expect([unknownPolicy.status, unknownPolicy.body.error.code]).toEqual([
      404,
      'ESCALATION_POLICY_NOT_FOUND',
    ]);
    const foreignPolicy = await request(app)
      .get(policyUrl(service.id, other.body.data.escalationPolicyId))
      .set(bearer(admin.token));
    expect([foreignPolicy.status, foreignPolicy.body.error.code]).toEqual([
      404,
      'ESCALATION_POLICY_NOT_FOUND',
    ]);
    expect(
      (await request(app).get(`${api}/x/escalation-policies/y`).set(bearer(admin.token))).status,
    ).toBe(422);
  });
});

describe('S7 PATCH /services/:serviceId/escalation-policies/:escalationPolicyId', () => {
  it('updates any subset of the four levels and is idempotent', async () => {
    const { k, admin, service } = await setup();
    const url = policyUrl(service.id, service.escalationPolicyId);
    const replacement = await createUser({ role: 'ENGINEER', teamId: k.team.id });
    const newAdmin = await createUser({ role: 'ADMIN' });

    const first = await request(app)
      .patch(url)
      .set(bearer(admin.token))
      .send({ level1: replacement.id, fallbackAdmin: newAdmin.id });
    expect(first.status).toBe(200);
    expect(Object.keys(first.body.data).sort()).toEqual(POLICY_KEYS);
    expect(first.body.data).toMatchObject({
      level1: replacement.id,
      level2: k.engineer2.id,
      level3: k.lead.id,
      fallbackAdmin: newAdmin.id,
    });
    const again = await request(app)
      .patch(url)
      .set(bearer(admin.token))
      .send({ level1: replacement.id, fallbackAdmin: newAdmin.id });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
  });

  it('validates the users of each level with 403 INVALID_ACTION', async () => {
    const { k, admin, service } = await setup();
    const url = policyUrl(service.id, service.escalationPolicyId);
    const foreign = await createTeam();
    const cases: [string, object][] = [
      ['level1 team lead', { level1: k.lead.id }],
      [
        'level1 other team',
        { level1: (await createUser({ role: 'ENGINEER', teamId: foreign.id })).id },
      ],
      [
        'level2 deactivated',
        {
          level2: (await createUser({ role: 'ENGINEER', teamId: k.team.id, status: 'DEACTIVATED' }))
            .id,
        },
      ],
      ['level2 unknown', { level2: NIL }],
      ['level3 engineer', { level3: k.engineer1.id }],
      [
        'level3 other team',
        { level3: (await createUser({ role: 'TEAM_LEAD', teamId: foreign.id })).id },
      ],
      ['fallback not admin', { fallbackAdmin: k.lead.id }],
    ];
    for (const [label, body] of cases) {
      const res = await request(app).patch(url).set(bearer(admin.token)).send(body);
      expect([label, res.status, res.body.error?.code]).toEqual([label, 403, 'INVALID_ACTION']);
    }
    const stored = await getPrisma().escalationPolicy.findUniqueOrThrow({
      where: { id: service.escalationPolicyId },
    });
    expect(stored.level1Id).toBe(k.engineer1.id);
  });

  it('answers 409 POLICY_IN_USE for a change while an incident is unresolved', async () => {
    const { k, admin, service } = await setup();
    const url = policyUrl(service.id, service.escalationPolicyId);
    const replacement = await createUser({ role: 'ENGINEER', teamId: k.team.id });
    await createIncident(k.team.id, service.id, 'MITIGATING');

    const res = await request(app)
      .patch(url)
      .set(bearer(admin.token))
      .send({ level1: replacement.id });
    expect([res.status, res.body.error.code]).toEqual([409, 'POLICY_IN_USE']);
    const same = await request(app)
      .patch(url)
      .set(bearer(admin.token))
      .send({ level1: k.engineer1.id });
    expect(same.status).toBe(200);
  });

  it('allows changes when incidents are only RESOLVED or CLOSED', async () => {
    const { k, admin, service } = await setup();
    await createIncident(k.team.id, service.id, 'RESOLVED');
    await createIncident(k.team.id, service.id, 'CLOSED');
    const replacement = await createUser({ role: 'ENGINEER', teamId: k.team.id });
    const res = await request(app)
      .patch(policyUrl(service.id, service.escalationPolicyId))
      .set(bearer(admin.token))
      .send({ level2: replacement.id });
    expect(res.status).toBe(200);
  });

  it('serializes with incident creation: a change waits for an in-flight incident insert', async () => {
    const { k, admin, service } = await setup();
    const replacement = await createUser({ role: 'ENGINEER', teamId: k.team.id });
    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "Incident" ("id","title","description","severity","affectedServiceId","teamId")
         VALUES (gen_random_uuid(),'t','d','P1',$1,$2)`,
        [service.id, k.team.id],
      );
      let settled = false;
      const pending = request(app)
        .patch(policyUrl(service.id, service.escalationPolicyId))
        .set(bearer(admin.token))
        .send({ level1: replacement.id })
        .then((res) => {
          settled = true;
          return res;
        });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await client.query('COMMIT');
      const res = await pending;
      expect([res.status, res.body.error.code]).toEqual([409, 'POLICY_IN_USE']);
    } finally {
      await client.end();
    }
  });

  it('validates the body, the path and the gates', async () => {
    const { k, admin, service } = await setup();
    const url = policyUrl(service.id, service.escalationPolicyId);
    const send = (token: string, body: object, target = url) =>
      request(app).patch(target).set(bearer(token)).send(body);
    expect((await send(admin.token, {})).status).toBe(422);
    expect((await send(admin.token, { level1: 'x' })).status).toBe(422);
    expect((await send(admin.token, { level1: k.engineer1.id, delayMinutes: 5 })).status).toBe(400);
    expect(
      (
        await send(
          admin.token,
          { level1: k.engineer1.id },
          `${api}/${service.id}/escalation-policies/x`,
        )
      ).status,
    ).toBe(422);
    const noService = await send(
      admin.token,
      { level1: k.engineer1.id },
      policyUrl(NIL, service.escalationPolicyId),
    );
    expect([noService.status, noService.body.error.code]).toEqual([404, 'SERVICE_NOT_FOUND']);
    const noPolicy = await send(
      admin.token,
      { level1: k.engineer1.id },
      policyUrl(service.id, NIL),
    );
    expect([noPolicy.status, noPolicy.body.error.code]).toEqual([
      404,
      'ESCALATION_POLICY_NOT_FOUND',
    ]);
    expect((await request(app).patch(url).send({ level1: k.engineer1.id })).status).toBe(401);
    for (const role of ['ENGINEER', 'TEAM_LEAD'] as const) {
      const { token } = await sessionFor(app, role, k.team.id);
      const res = await send(token, { level1: k.engineer1.id });
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
    }
  });
});

describe('database constraints and configuration read contract', () => {
  it('enforces unique service names and one service per policy in the database', async () => {
    const { k, admin, service } = await setup();
    const db = getPrisma();
    const data = {
      ...SLA,
      teamId: k.team.id,
    };
    await expect(
      db.appService.create({
        data: {
          ...data,
          name: service.name,
          escalationPolicyId: (
            await db.escalationPolicy.create({
              data: {
                level1Id: admin.admin.id,
                level2Id: admin.admin.id,
                level3Id: admin.admin.id,
                fallbackAdminId: admin.admin.id,
              },
            })
          ).id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.appService.create({
        data: { ...data, name: 'another', escalationPolicyId: service.escalationPolicyId },
      }),
    ).rejects.toThrow();
  });

  it('exports the service configuration and the policy users for other modules', async () => {
    const { k, admin, service } = await setup();
    expect(await getServiceConfig(service.id)).toEqual({
      id: service.id,
      name: service.name,
      status: 'ACTIVE',
      teamId: k.team.id,
      defaultSeverity: 'P1',
      escalationPolicyId: service.escalationPolicyId,
      sla: {
        P0: { responseMinutes: 5, resolutionMinutes: 30 },
        P1: { responseMinutes: 10, resolutionMinutes: 60 },
        P2: { responseMinutes: 30, resolutionMinutes: 120 },
        P3: { responseMinutes: 60, resolutionMinutes: 240 },
      },
    });
    expect(await getEscalationPolicyByService(service.id)).toEqual({
      level1: k.engineer1.id,
      level2: k.engineer2.id,
      level3: k.lead.id,
      fallbackAdmin: admin.admin.id,
    });
    expect(await getServiceConfig(NIL)).toBeNull();
    expect(await getEscalationPolicyByService(NIL)).toBeNull();
  });
});
