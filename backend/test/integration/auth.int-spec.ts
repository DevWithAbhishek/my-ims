import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import { buildTestApp } from '../helpers/app';
import {
  PASSWORD,
  bearer,
  cookieValue,
  createTeam,
  createUser,
  login,
  resetState,
} from '../helpers/identity';

const app = buildTestApp();
const refreshWith = (cookie: string) =>
  request(app).post('/api/v1/auth/refresh').set('Cookie', `ims_refresh_cookie=${cookie}`);
const attempt = (email: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password });

/** Ends every active rate-limit block, as if the block window had passed. */
async function expireBlocks(): Promise<void> {
  const redis = getRedis();
  const keys = await redis.keys('rl:block:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(resetState);
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

describe('A1 POST /auth/login', () => {
  it('returns the token in the header, the refresh token only in the cookie, and no token in the body', async () => {
    const team = await createTeam();
    const user = await createUser({ teamId: team.id, role: 'TEAM_LEAD' });
    const res = await attempt(user.email, PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { tokenType: 'Bearer', expiresIn: 900 } });
    expect(res.headers['authorization']).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(res.headers['set-cookie'][0]).toMatch(
      /^ims_refresh_cookie=[^;]+; Max-Age=604800; Path=\/api\/v1\/auth; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(JSON.stringify(res.body)).not.toContain(cookieValue(res.headers['set-cookie']));

    const claims = JSON.parse(
      Buffer.from(res.headers['authorization'].split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({
      userId: user.id,
      email: user.email,
      role: 'TEAM_LEAD',
      teamId: team.id,
    });
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('puts teamId null in the claims for a user without a team', async () => {
    const user = await createUser();
    const { token } = await login(app, user.email);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims.teamId).toBeNull();
  });

  it('stores only a hash of the refresh secret and an Argon2 password hash', async () => {
    const user = await createUser();
    const { refresh } = await login(app, user.email);
    const secret = refresh.split('.')[2];

    const session = await getPrisma().userSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.refreshTokenHash).not.toBe(secret);
    expect(JSON.stringify(session)).not.toContain(secret);
    expect(session).toMatchObject({ revoked: false, lastRefreshHash: null });
    expect(session.expiresIn.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);

    const stored = await getPrisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
  });

  it('is case-insensitive on the email', async () => {
    const user = await createUser({ email: 'mixed@example.com' });
    const res = await attempt('MiXeD@Example.com', PASSWORD);
    expect(res.status).toBe(200);
    expect(user.email).toBe('mixed@example.com');
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const user = await createUser();
    const wrong = await attempt(user.email, 'wrong-password');
    const unknown = await attempt('nobody@example.com', 'wrong-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = ({
      error,
    }: {
      error: { code: string; message: string; details: unknown[] };
    }) => ({
      code: error.code,
      message: error.message,
      details: error.details,
    });
    expect(strip(wrong.body)).toEqual(strip(unknown.body));
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 403 ACCOUNT_DEACTIVATED only when the password is correct', async () => {
    const user = await createUser({ status: 'DEACTIVATED' });
    const ok = await attempt(user.email, PASSWORD);
    expect(ok.status).toBe(403);
    expect(ok.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    expect((await attempt(user.email, 'wrong-password')).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    expect(await getPrisma().userSession.count()).toBe(0);
  });

  it.each([
    ['short password', { email: 'a@example.com', password: 'short' }],
    ['long password', { email: 'a@example.com', password: 'x'.repeat(25) }],
    ['invalid email', { email: 'nope', password: PASSWORD }],
    ['email over 72 chars', { email: `${'a'.repeat(64)}@example.com`, password: PASSWORD }],
    ['missing password', { email: 'a@example.com' }],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_name, body) => {
    const res = await request(app).post('/api/v1/auth/login').send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects unknown fields, malformed JSON and a non-JSON body with 400 BAD_REQUEST', async () => {
    const unknownField = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: PASSWORD, extra: 1 });
    expect(unknownField.status).toBe(400);
    const malformed = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(malformed.status).toBe(400);
    const wrongType = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'text/plain')
      .send('email=a');
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('BAD_REQUEST');
  });

  it('creates one session per login', async () => {
    const user = await createUser();
    await login(app, user.email);
    await login(app, user.email);
    expect(await getPrisma().userSession.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe('rate limiting', () => {
  it('blocks the 11th attempt with 429 and Retry-After, escalating 10 min → 20 → 60 → 4 h → IP', async () => {
    const user = await createUser();
    const retryAfter: string[] = [];

    for (let violation = 1; violation <= 4; violation++) {
      for (let i = 0; i < 10; i++) {
        expect((await attempt(user.email, 'wrong-password')).status).toBe(401);
      }
      const blocked = await attempt(user.email, 'wrong-password');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      retryAfter.push(blocked.headers['retry-after']);

      // Still blocked, even with the right password.
      expect((await attempt(user.email, PASSWORD)).status).toBe(429);
      await expireBlocks();
    }
    expect(retryAfter).toEqual(['600', '1200', '3600', '14400']);

    for (let i = 0; i < 10; i++) await attempt(user.email, 'wrong-password');
    const ipBlocked = await attempt(user.email, 'wrong-password');
    expect(ipBlocked.status).toBe(429);
    expect(ipBlocked.headers['retry-after']).toBe('86400');

    // The IP block covers other identities and the refresh endpoint.
    await expireBlocks();
    const other = await createUser();
    expect((await attempt(other.email, PASSWORD)).status).toBe(429);
    expect((await refreshWith('anything')).status).toBe(429);
  });

  it('counts per email, so another account is not blocked by the first', async () => {
    const a = await createUser();
    const b = await createUser();
    for (let i = 0; i < 11; i++) await attempt(a.email, 'wrong-password');
    expect((await attempt(a.email, PASSWORD)).status).toBe(429);
    expect((await attempt(b.email, PASSWORD)).status).toBe(200);
  });

  it('resets the counter after a successful login', async () => {
    const user = await createUser();
    for (let i = 0; i < 9; i++) await attempt(user.email, 'wrong-password');
    expect((await attempt(user.email, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 10; i++) {
      expect((await attempt(user.email, 'wrong-password')).status).toBe(401);
    }
    expect((await attempt(user.email, 'wrong-password')).status).toBe(429);
  });

  it('keys refresh on IP + email + session id and resets after a success', async () => {
    const user = await createUser();
    const { refresh } = await login(app, user.email);
    const otherUser = await createUser();
    const other = await login(app, otherUser.email);

    const bad = `${refresh.split('.').slice(0, 2).join('.')}.wrong-secret`;
    for (let i = 0; i < 10; i++) expect((await refreshWith(bad)).status).toBe(401);
    const blocked = await refreshWith(bad);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('600');

    // A different session (and email) from the same IP is unaffected.
    expect((await refreshWith(other.refresh)).status).toBe(200);
  });

  it('fails closed with 503 and Retry-After when Redis is unavailable', async () => {
    const user = await createUser();
    const spy = jest.spyOn(getRedis(), 'eval').mockRejectedValue(new Error('redis down'));
    try {
      const login503 = await attempt(user.email, PASSWORD);
      expect(login503.status).toBe(503);
      expect(login503.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(login503.headers['retry-after']).toBe('5');
      const refresh503 = await refreshWith('00000000-0000-4000-8000-000000000000.YQ.s');
      expect(refresh503.status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect(await getPrisma().userSession.count()).toBe(0);
  });
});

describe('A2 POST /auth/refresh', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const user = await createUser();
    const first = await login(app, user.email);
    const before = await getPrisma().userSession.findFirstOrThrow({ where: { userId: user.id } });

    const res = await refreshWith(first.refresh);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { tokenType: 'Bearer', expiresIn: 900 } });
    expect(res.headers['authorization']).toMatch(/^Bearer /);
    const next = cookieValue(res.headers['set-cookie']);
    expect(next).not.toBe(first.refresh);
    expect(res.headers['set-cookie'][0]).toContain('Max-Age=604800');

    const after = await getPrisma().userSession.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.lastRefreshHash).toBe(before.refreshTokenHash);
    expect(after.refreshTokenHash).not.toBe(before.refreshTokenHash);
    expect(after.lastSeen).not.toBeNull();
    expect(after.revoked).toBe(false);

    expect((await refreshWith(next)).status).toBe(200);
  });

  it('reads the new claims from the database', async () => {
    const team = await createTeam();
    const user = await createUser();
    const first = await login(app, user.email);
    await getPrisma().user.update({
      where: { id: user.id },
      data: { role: 'TEAM_LEAD', teamId: team.id },
    });

    const res = await refreshWith(first.refresh);
    const claims = JSON.parse(
      Buffer.from(res.headers['authorization'].split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({ role: 'TEAM_LEAD', teamId: team.id });
  });

  it('treats reuse of a rotated token as theft: 401 and every session of the user is revoked', async () => {
    const user = await createUser();
    const other = await createUser();
    const first = await login(app, user.email);
    const second = await login(app, user.email);
    const bystander = await login(app, other.email);

    const rotated = await refreshWith(first.refresh);
    expect(rotated.status).toBe(200);

    const reuse = await refreshWith(first.refresh);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('INVALID_REFRESH_TOKEN');

    expect(
      await getPrisma().userSession.count({ where: { userId: user.id, revoked: false } }),
    ).toBe(0);
    expect((await refreshWith(cookieValue(rotated.headers['set-cookie']))).status).toBe(401);
    expect((await refreshWith(second.refresh)).status).toBe(401);
    expect((await refreshWith(bystander.refresh)).status).toBe(200);
  });

  it('lets exactly one of two concurrent refreshes with the same token win', async () => {
    const user = await createUser();
    const { refresh } = await login(app, user.email);

    const results = await Promise.all([refreshWith(refresh), refreshWith(refresh)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
    expect(results.find((r) => r.status === 401)?.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    expect(
      await getPrisma().userSession.count({ where: { userId: user.id, revoked: false } }),
    ).toBe(0);
  });

  it('returns 401 INVALID_REQUEST when the cookie is absent', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({ ignored: true });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 401 INVALID_REFRESH_TOKEN for garbage, a wrong secret, an unknown session, an expired and a revoked session', async () => {
    const user = await createUser();
    const { refresh } = await login(app, user.email);
    const [sessionId, email] = refresh.split('.');
    const forged = [
      'garbage',
      `${sessionId}.${email}.wrong-secret`,
      `00000000-0000-4000-8000-000000000000.${email}.${refresh.split('.')[2]}`,
    ];
    for (const value of forged) {
      const res = await refreshWith(value);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    }
    // A forged secret is not reuse: the real session is untouched.
    expect((await refreshWith(refresh)).status).toBe(200);

    const live = await login(app, user.email);
    await getPrisma().userSession.updateMany({
      where: { id: live.refresh.split('.')[0] },
      data: { expiresIn: new Date(Date.now() - 1000) },
    });
    expect((await refreshWith(live.refresh)).body.error.code).toBe('INVALID_REFRESH_TOKEN');

    const toRevoke = await login(app, user.email);
    await getPrisma().userSession.updateMany({
      where: { id: toRevoke.refresh.split('.')[0] },
      data: { revoked: true },
    });
    expect((await refreshWith(toRevoke.refresh)).body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('returns 403 ACCOUNT_DEACTIVATED for a deactivated user', async () => {
    const user = await createUser();
    const { refresh } = await login(app, user.email);
    await getPrisma().user.update({ where: { id: user.id }, data: { status: 'DEACTIVATED' } });
    const res = await refreshWith(refresh);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });
});

describe('A3 / A4 logout', () => {
  it('revokes the session, clears the cookie, and answers the same on a repeat', async () => {
    const user = await createUser();
    const { token, refresh } = await login(app, user.email);

    const res = await request(app).post('/api/v1/auth/logout').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { message: 'Logged out successfully' } });
    expect(res.headers['set-cookie'][0]).toBe(
      'ims_refresh_cookie=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax',
    );
    expect(await getPrisma().userSession.count({ where: { revoked: true } })).toBe(1);

    expect((await refreshWith(refresh)).status).toBe(401);
    // The access token stays valid until it expires.
    expect((await request(app).post('/api/v1/auth/logout').set(bearer(token))).status).toBe(200);
  });

  it('logout only touches the session in the token', async () => {
    const user = await createUser();
    const a = await login(app, user.email);
    const b = await login(app, user.email);
    await request(app).post('/api/v1/auth/logout').set(bearer(a.token));
    expect((await refreshWith(b.refresh)).status).toBe(200);
  });

  it('logout-all revokes every session of the caller and nobody else', async () => {
    const user = await createUser();
    const other = await createUser();
    const a = await login(app, user.email);
    const b = await login(app, user.email);
    const bystander = await login(app, other.email);

    const res = await request(app).post('/api/v1/auth/logout-all').set(bearer(a.token));
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Logged out successfully');
    expect(res.headers['set-cookie'][0]).toContain('Max-Age=0');
    expect((await refreshWith(a.refresh)).status).toBe(401);
    expect((await refreshWith(b.refresh)).status).toBe(401);
    expect((await refreshWith(bystander.refresh)).status).toBe(200);
  });

  it.each(['/api/v1/auth/logout', '/api/v1/auth/logout-all'])(
    '%s requires a valid access token',
    async (path) => {
      const missing = await request(app).post(path);
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe('UNAUTHENTICATED');
      expect((await request(app).post(path).set(bearer('bad.token.value'))).status).toBe(401);
    },
  );
});
