import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = 'postgresql://u:p@localhost:5432/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'unit-test-secret';

import jwt from 'jsonwebtoken';
import { errorMappingMiddleware } from '../../../shared/middleware/error-mapping.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { assertSameTeam, authenticate, requireRoles, requireTeam } from './guard.js';
import { signAccessToken } from './tokens.js';

// The guard must be verifiable offline: any database access in these tests is a failure.
jest.mock('../../../infra/db/prisma.js', () => ({
  getPrisma: () => {
    throw new Error('guard must not read the database');
  },
}));

const caller: AuthContext = {
  userId: randomUUID(),
  email: 'a@example.com',
  role: 'ENGINEER',
  teamId: randomUUID(),
  sessionId: randomUUID(),
};

function buildApp() {
  const app = express();
  app.get('/any', authenticate, (req, res) => {
    res.json({ auth: req.auth });
  });
  app.get('/lead', authenticate, requireRoles('TEAM_LEAD', 'ADMIN'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorMappingMiddleware);
  return app;
}

describe('authenticate', () => {
  it('sets req.auth from a valid Bearer token without any database read', async () => {
    const { token } = signAccessToken(caller);
    const res = await request(buildApp()).get('/any').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual(caller);
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['empty token', 'Bearer '],
    ['garbage token', 'Bearer not.a.jwt'],
    ['wrong secret', `Bearer ${jwt.sign(caller, 'other')}`],
    ['expired token', `Bearer ${jwt.sign(caller, 'unit-test-secret', { expiresIn: -5 })}`],
  ])('rejects %s with 401 UNAUTHENTICATED', async (_name, header) => {
    const req = request(buildApp()).get('/any');
    const res = await (header ? req.set('Authorization', header) : req);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('requireRoles', () => {
  it('rejects a role outside the list with 403 FORBIDDEN_ROLE', async () => {
    const { token } = signAccessToken(caller);
    const res = await request(buildApp()).get('/lead').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('lets a listed role through', async () => {
    const { token } = signAccessToken({ ...caller, role: 'TEAM_LEAD' });
    const res = await request(buildApp()).get('/lead').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('team helpers', () => {
  it('requireTeam returns the team id or throws 403 INVALID_ACTION', () => {
    expect(requireTeam(caller)).toBe(caller.teamId);
    expect(() => requireTeam({ ...caller, teamId: null })).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'INVALID_ACTION' }),
    );
  });

  it('assertSameTeam passes for the same team and throws 403 TEAM_ACCESS_DENIED otherwise', () => {
    expect(() => assertSameTeam(caller, caller.teamId)).not.toThrow();
    for (const other of [randomUUID(), null]) {
      expect(() => assertSameTeam(caller, other)).toThrow(
        expect.objectContaining({ statusCode: 403, code: 'TEAM_ACCESS_DENIED' }),
      );
    }
    expect(() => assertSameTeam({ ...caller, teamId: null }, null)).toThrow(
      expect.objectContaining({ code: 'TEAM_ACCESS_DENIED' }),
    );
  });
});
