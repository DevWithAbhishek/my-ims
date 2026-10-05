import { Router } from 'express';
import request from 'supertest';
import { createApp, JSON_BODY_LIMIT } from './app.js';
import { READINESS_RETRY_AFTER_SECONDS, READINESS_TIMEOUT_MS } from './shared/http/health.js';
import { logger } from './shared/observability/logger.js';

logger.level = 'silent';

const up = { name: 'up', check: () => Promise.resolve() };
const down = { name: 'down', check: () => Promise.reject(new Error('connection refused')) };

describe('createApp', () => {
  describe('GET /health', () => {
    it('is live without touching dependencies', async () => {
      const check = jest.fn();
      const res = await request(createApp({ readinessChecks: [{ name: 'x', check }] })).get(
        '/health',
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(check).not.toHaveBeenCalled();
    });

    it('is not mounted under /api/v1', async () => {
      const res = await request(createApp({ readinessChecks: [] })).get('/api/v1/health');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /ready', () => {
    it('returns 200 when every dependency responds', async () => {
      const res = await request(createApp({ readinessChecks: [up, up] })).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { status: 'ok' } });
    });

    it('returns 503 DEPENDENCY_UNAVAILABLE with Retry-After when a check fails', async () => {
      const res = await request(createApp({ readinessChecks: [up, down] }))
        .get('/ready')
        .set('X-Request-Id', 'ready-1');
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe(String(READINESS_RETRY_AFTER_SECONDS));
      expect(res.body).toEqual({
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: expect.any(String),
          details: [],
          requestId: 'ready-1',
        },
      });
      expect(JSON.stringify(res.body)).not.toContain('connection refused');
    });

    it(
      'returns 503 when a check hangs past the timeout',
      async () => {
        const hang = { name: 'hang', check: () => new Promise<never>(() => undefined) };
        const res = await request(createApp({ readinessChecks: [hang] })).get('/ready');
        expect(res.status).toBe(503);
      },
      READINESS_TIMEOUT_MS + 3000,
    );
  });

  describe('/api/v1 mounting', () => {
    it('mounts the api router under /api/v1 only', async () => {
      const apiRouter = Router();
      apiRouter.get('/ping', (_req, res) => {
        res.json({ data: 'pong' });
      });
      const app = createApp({ readinessChecks: [], apiRouter });

      expect((await request(app).get('/api/v1/ping')).body).toEqual({ data: 'pong' });
      expect((await request(app).get('/ping')).status).toBe(404);
    });

    it('does not serve the old welcome route', async () => {
      expect((await request(createApp({ readinessChecks: [] })).get('/')).status).toBe(404);
    });
  });

  describe('request handling', () => {
    const apiRouter = Router();
    apiRouter.post('/echo', (req, res) => {
      res.json({ data: req.body });
    });
    apiRouter.get('/boom', () => {
      throw new Error('kaboom');
    });
    const app = createApp({ readinessChecks: [], apiRouter });

    it('parses JSON bodies', async () => {
      const res = await request(app).post('/api/v1/echo').send({ a: 1 });
      expect(res.body).toEqual({ data: { a: 1 } });
    });

    it('maps malformed JSON to 400 BAD_REQUEST', async () => {
      const res = await request(app)
        .post('/api/v1/echo')
        .set('Content-Type', 'application/json')
        .send('{oops');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it(`applies the explicit ${JSON_BODY_LIMIT} body limit`, async () => {
      const res = await request(app)
        .post('/api/v1/echo')
        .send({ blob: 'x'.repeat(200 * 1024) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('turns unexpected errors into INTERNAL_ERROR with the request id', async () => {
      const res = await request(app).get('/api/v1/boom');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
      expect(JSON.stringify(res.body)).not.toContain('kaboom');
    });

    it('echoes X-Request-Id on success responses', async () => {
      const res = await request(app).post('/api/v1/echo').set('X-Request-Id', 'abc-1').send({});
      expect(res.headers['x-request-id']).toBe('abc-1');
    });
  });
});
