import { Redis } from 'ioredis';
import request from 'supertest';
import { disconnectPrisma, pingDatabase } from '../../src/infra/db/prisma';
import { buildReadinessChecks } from '../../src/infra/readiness';
import { closeRedis, pingRedis } from '../../src/infra/redis/redis';
import { buildTestApp } from '../helpers/app';

afterAll(async () => {
  await disconnectPrisma();
  await closeRedis();
});

describe('GET /health', () => {
  it('returns 200 without authentication', async () => {
    const res = await request(buildTestApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('returns 200 when PostgreSQL and Redis respond', async () => {
    const res = await request(buildTestApp()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' } });
  });

  it('returns 503 with Retry-After when Redis is unreachable', async () => {
    // Never reconnects, so the failed client leaves no timers behind.
    const unreachable = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    unreachable.on('error', () => undefined);
    const app = buildTestApp([
      { name: 'postgresql', check: () => pingDatabase() },
      { name: 'redis', check: () => pingRedis(unreachable) },
    ]);

    try {
      const res = await request(app).get('/ready').set('X-Request-Id', 'ready-int-1');
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.error).toEqual({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: expect.any(String),
        details: [],
        requestId: 'ready-int-1',
      });
    } finally {
      if (unreachable.status !== 'end') unreachable.disconnect();
    }
  });

  it('recovers once the dependency is back', async () => {
    const res = await request(buildTestApp(buildReadinessChecks())).get('/ready');
    expect(res.status).toBe(200);
  });
});
