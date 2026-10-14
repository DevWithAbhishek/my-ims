import type { Express } from 'express';
import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { createRedisConnection, getRedis } from '../../src/infra/redis/redis';
import { writeBlockedNotice } from '../../src/modules/alerts/admin-notice';
import { createRateLimiter, rateLimitKeys } from '../../src/modules/alerts/rate-limiter';
import { createReplayStore, replayKey } from '../../src/modules/alerts/replay.store';
import type { VerifiedAlertContext } from '../../src/modules/alerts';
import { buildTestApp } from '../helpers/app';
import {
  createAlertSource,
  makeAlerts,
  nowSeconds,
  postWebhook,
  SEVERITY_MAPPING,
  SIGNING_SECRET,
  signBody,
  withoutRequestId,
} from '../helpers/alert-source';
import { resetState } from '../helpers/identity';

const ingest = jest.fn<Promise<unknown>, [VerifiedAlertContext]>();
let app: Express;
let sourceId: string;

const OK_BODY = { data: { results: [] } };

beforeEach(async () => {
  await resetState();
  ingest.mockReset().mockResolvedValue(OK_BODY);
  app = buildTestApp(undefined, { ingest });
  sourceId = (await createAlertSource()).id;
});

afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

const keys = () => rateLimitKeys(sourceId);
const outboxRows = () => getPrisma().outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });

describe('W1 · POST /webhooks/alerts/:alertSourceId', () => {
  describe('a valid request', () => {
    it('is verified and handed to ingestion with the bounded context', async () => {
      const alerts = makeAlerts(3);
      const res = await postWebhook(app, sourceId, alerts, { requestId: 'req-ok-1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(OK_BODY);
      expect(res.headers['x-request-id']).toBe('req-ok-1');
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest.mock.calls[0]?.[0]).toEqual({
        alertSource: {
          id: sourceId,
          name: 'Test source',
          sourceType: 'GENERIC',
          configuration: { signingSecret: SIGNING_SECRET, severityMapping: SEVERITY_MAPPING },
        },
        items: alerts,
        rateLimitedIndices: [],
        requestId: 'req-ok-1',
      });
    });

    it('without ingestion wired (SLICE-04 pending) is answered 501 NOT_IMPLEMENTED', async () => {
      const res = await postWebhook(buildTestApp(), sourceId, makeAlerts(1));
      expect(res.status).toBe(501);
      expect(res.body.error).toMatchObject({ code: 'NOT_IMPLEMENTED', details: [] });
      expect(await getPrisma().alert.count()).toBe(0);
    });
  });

  describe('step 2 · source authentication', () => {
    it('every failure is the identical 401 SOURCE_AUTH_FAILED', async () => {
      const deactivated = await createAlertSource({ status: 'DEACTIVATED' });
      const alerts = makeAlerts(1);
      const sent = JSON.stringify({ alerts });
      const attempts = await Promise.all([
        postWebhook(app, sourceId, alerts, { secret: 'a-completely-different-secret-value!' }),
        postWebhook(app, sourceId, alerts, {
          body: sent,
          signedBody: sent.replace('alert-0', 'x'),
        }),
        postWebhook(app, '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f90', alerts),
        postWebhook(app, deactivated.id, alerts),
        postWebhook(app, 'not-a-uuid', alerts),
        postWebhook(app, sourceId, alerts, { headers: { 'X-Signature': null } }),
        postWebhook(app, sourceId, alerts, { headers: { 'X-Timestamp': null } }),
        postWebhook(app, sourceId, alerts, { headers: { 'X-Signature': 'sha256=zz' } }),
        postWebhook(app, sourceId, alerts, { headers: { 'X-Timestamp': 'yesterday' } }),
      ]);

      for (const res of attempts) {
        expect(res.status).toBe(401);
        expect(withoutRequestId(res.body)).toEqual(withoutRequestId(attempts[0]!.body));
      }
      expect(withoutRequestId(attempts[0]!.body)).toEqual({
        code: 'SOURCE_AUTH_FAILED',
        message: 'Source authentication failed',
        details: [],
      });
      expect(JSON.stringify(attempts.map((r) => r.body))).not.toContain(SIGNING_SECRET);
      expect(ingest).not.toHaveBeenCalled();
    });

    it('a failed authentication stores nothing in Redis', async () => {
      await postWebhook(app, sourceId, makeAlerts(2), {
        secret: 'wrong-secret-wrong-secret-wrong-secret',
      });
      expect(await getRedis().keys('wh:*')).toEqual([]);
    });
  });

  describe('step 3 · timestamp', () => {
    const NOW = 1_900_000_000;
    let fixed: Express;
    beforeEach(() => {
      fixed = buildTestApp(undefined, { ingest, now: () => NOW * 1000 + 250 });
    });

    it.each([
      ['300 s in the past', NOW - 300, 200],
      ['301 s in the past', NOW - 301, 401],
      ['300 s in the future', NOW + 300, 200],
      ['301 s in the future', NOW + 301, 401],
    ])('%s', async (_name, timestamp, status) => {
      const res = await postWebhook(fixed, sourceId, makeAlerts(1), { timestamp });
      expect(res.status).toBe(status);
      if (status === 401) {
        expect(res.body.error).toMatchObject({ code: 'REQUEST_STALE', details: [] });
      }
    });

    it('a stale request is not remembered as seen', async () => {
      await postWebhook(fixed, sourceId, makeAlerts(1), { timestamp: NOW - 400 });
      expect(await getRedis().keys('wh:*')).toEqual([]);
    });
  });

  describe('step 4 · replay protection', () => {
    it('the identical signed request again is 409 REPLAY_DETECTED', async () => {
      const body = JSON.stringify({ alerts: makeAlerts(1) });
      const timestamp = nowSeconds();
      expect((await postWebhook(app, sourceId, null, { body, timestamp })).status).toBe(200);

      const again = await postWebhook(app, sourceId, null, { body, timestamp });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({ code: 'REPLAY_DETECTED', details: [] });
      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it('the same alerts, freshly signed, are not a replay', async () => {
      const NOW = 1_900_000_000;
      const fixed = buildTestApp(undefined, { ingest, now: () => NOW * 1000 });
      const body = JSON.stringify({ alerts: makeAlerts(1) });
      expect((await postWebhook(fixed, sourceId, null, { body, timestamp: NOW })).status).toBe(200);
      expect((await postWebhook(fixed, sourceId, null, { body, timestamp: NOW + 1 })).status).toBe(
        200,
      );
      expect(ingest).toHaveBeenCalledTimes(2);
    });

    it('records the signature for the whole acceptance window', async () => {
      const body = JSON.stringify({ alerts: makeAlerts(1) });
      const timestamp = nowSeconds();
      await postWebhook(app, sourceId, null, { body, timestamp });
      const hex = signBody(body, timestamp).slice('sha256='.length);
      const ttl = await getRedis().ttl(replayKey(sourceId, hex));
      expect(ttl).toBeGreaterThanOrEqual(600);
      expect(ttl).toBeLessThanOrEqual(610);
    });

    it('simultaneous identical requests: exactly one passes', async () => {
      const body = JSON.stringify({ alerts: makeAlerts(1) });
      const timestamp = nowSeconds();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => postWebhook(app, sourceId, null, { body, timestamp })),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(11);
      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it('a rejected request still leaves its signature marked (retries must be re-signed)', async () => {
      const body = JSON.stringify({ alerts: makeAlerts(1) });
      const timestamp = nowSeconds();
      expect(
        (await postWebhook(app, sourceId, null, { body, timestamp, contentType: null })).status,
      ).toBe(400);
      expect((await postWebhook(app, sourceId, null, { body, timestamp })).status).toBe(409);
    });
  });

  describe('step 5 · rate limiting (15 alerts/min per source, counted per alert)', () => {
    it('accepts 15 alerts, then answers 429 RATE_LIMITED with Retry-After', async () => {
      expect((await postWebhook(app, sourceId, makeAlerts(15))).status).toBe(200);
      const res = await postWebhook(app, sourceId, makeAlerts(1));
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('300');
      expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED', details: [] });
      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it('counts alerts, not requests', async () => {
      for (let i = 0; i < 3; i++) {
        expect((await postWebhook(app, sourceId, makeAlerts(5))).status).toBe(200);
      }
      expect((await postWebhook(app, sourceId, makeAlerts(1))).status).toBe(429);
    });

    it('with partial capacity the first alerts pass and the rest are marked rate limited', async () => {
      await postWebhook(app, sourceId, makeAlerts(10));
      const alerts = makeAlerts(10);
      const res = await postWebhook(app, sourceId, alerts);

      expect(res.status).toBe(200);
      const context = ingest.mock.calls[1]![0];
      expect(context.items).toEqual(alerts);
      expect(context.rateLimitedIndices).toEqual([5, 6, 7, 8, 9]);
      expect((await postWebhook(app, sourceId, makeAlerts(1))).status).toBe(429);
    });

    it('limits sources independently', async () => {
      const other = await createAlertSource({ name: 'Other' });
      await postWebhook(app, sourceId, makeAlerts(15));
      expect((await postWebhook(app, sourceId, makeAlerts(1))).status).toBe(429);
      expect((await postWebhook(app, other.id, makeAlerts(1))).status).toBe(200);
    });

    it('a blocked source gets 429 with the remaining block, whatever the body', async () => {
      await postWebhook(app, sourceId, makeAlerts(15));
      await postWebhook(app, sourceId, makeAlerts(1));

      const res = await postWebhook(app, sourceId, null, { body: 'not json' });
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(290);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(300);
      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it('a block ends by itself when its window passes', async () => {
      await postWebhook(app, sourceId, makeAlerts(15));
      await postWebhook(app, sourceId, makeAlerts(1));
      await getRedis().del(keys().block); // the block's TTL elapsing
      expect((await postWebhook(app, sourceId, makeAlerts(1))).status).toBe(200);
    });

    it('never lets concurrent requests exceed the capacity', async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, () => postWebhook(app, sourceId, makeAlerts(1))),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(15);
      expect(results.filter((r) => r.status === 429)).toHaveLength(15);
      expect(ingest).toHaveBeenCalledTimes(15);
      expect(await getRedis().get(keys().level)).toBe('1'); // one violation, not fifteen
    });

    it('a request with nothing to count is not rate limited', async () => {
      const base = nowSeconds();
      for (let i = 0; i < 20; i++) {
        // distinct timestamps give distinct signatures: none of these is a replay
        expect((await postWebhook(app, sourceId, [], { timestamp: base - i })).status).toBe(422);
      }
      expect(await getRedis().get(keys().count)).toBeNull();
    });

    describe('the ladder', () => {
      const EXPECTED_SECONDS = [300, 1200, 2700, 7200, 86_400];

      /** Fills the window, then violates; returns the violating response. */
      async function violate(application: Express = app) {
        expect((await postWebhook(application, sourceId, makeAlerts(15))).status).toBe(200);
        return postWebhook(application, sourceId, makeAlerts(1));
      }

      it('escalates 5 min → 20 min → 45 min → 2 h → final block, notifying only at the end', async () => {
        for (let violation = 1; violation <= 5; violation++) {
          const res = await violate();
          expect(res.status).toBe(429);
          expect(res.headers['retry-after']).toBe(String(EXPECTED_SECONDS[violation - 1]));
          if (violation < 5) {
            expect(await outboxRows()).toHaveLength(0);
            await getRedis().del(keys().block); // the block's window passes
          }
        }
        expect(await getRedis().get(keys().level)).toBe('5');
      });

      it('writes one NOTIFICATION_REQUESTED outbox event per block and no timeline event', async () => {
        for (let violation = 1; violation <= 5; violation++) {
          await violate();
          if (violation < 5) await getRedis().del(keys().block);
        }
        // Repeated attempts inside the final block, some at once.
        await Promise.all(
          Array.from({ length: 8 }, () => postWebhook(app, sourceId, makeAlerts(1))),
        );
        await postWebhook(app, sourceId, makeAlerts(1));

        const rows = await outboxRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          eventType: 'NOTIFICATION_REQUESTED',
          aggregateType: 'ALERT_SOURCE',
          aggregateId: sourceId,
          status: 'PENDING',
        });
        expect(rows[0]!.payload).toEqual({
          kind: 'ALERT_SOURCE_BLOCKED',
          alertSourceId: sourceId,
          attemptCount: 5,
          requestId: expect.any(String),
        });
        expect(await getPrisma().auditEvent.count()).toBe(0);
        expect(await getPrisma().incident.count()).toBe(0);
      });

      it('a later block (the window passed, violated again) is a new block with its own notice', async () => {
        for (let violation = 1; violation <= 5; violation++) {
          await violate();
          await getRedis().del(keys().block);
        }
        expect(await outboxRows()).toHaveLength(1);

        const res = await violate();
        expect(res.status).toBe(429);
        expect(res.headers['retry-after']).toBe('86400');
        const rows = await outboxRows();
        expect(rows).toHaveLength(2);
        expect(rows[1]!.payload).toMatchObject({ attemptCount: 6 });
      });

      it('retries a notice whose write failed on the next blocked request, then once only', async () => {
        const flaky = jest
          .fn<Promise<void>, Parameters<typeof writeBlockedNotice>>()
          .mockRejectedValueOnce(new Error('database down'))
          .mockImplementation(writeBlockedNotice);
        const flakyApp = buildTestApp(undefined, { ingest, notifyBlocked: flaky });

        for (let violation = 1; violation <= 5; violation++) {
          const res = await violate(flakyApp);
          expect(res.status).toBe(429); // the answer does not depend on the notice
          if (violation < 5) await getRedis().del(keys().block);
        }
        expect(flaky).toHaveBeenCalledTimes(1);
        expect(await outboxRows()).toHaveLength(0);

        await getRedis().del(keys().noticeLock); // the writer's claim elapsing
        expect((await postWebhook(flakyApp, sourceId, makeAlerts(1))).status).toBe(429);
        expect(flaky).toHaveBeenCalledTimes(2);
        expect(await outboxRows()).toHaveLength(1);

        await getRedis().del(keys().noticeLock);
        await postWebhook(flakyApp, sourceId, makeAlerts(1));
        expect(flaky).toHaveBeenCalledTimes(2);
        expect(await outboxRows()).toHaveLength(1);
      });
    });
  });

  describe('step 6 · envelope', () => {
    const failure = async (res: request.Response, status: number, code: string) => {
      expect(res.status).toBe(status);
      expect(res.body.error).toMatchObject({ code });
      expect(res.body.error.details).toEqual(expect.any(Array));
      expect(ingest).not.toHaveBeenCalled();
    };

    it('a missing Content-Type is 400 BAD_REQUEST', async () => {
      await failure(
        await postWebhook(app, sourceId, makeAlerts(1), { contentType: null }),
        400,
        'BAD_REQUEST',
      );
    });

    it('a Content-Type other than JSON is 400 BAD_REQUEST', async () => {
      await failure(
        await postWebhook(app, sourceId, makeAlerts(1), { contentType: 'text/plain' }),
        400,
        'BAD_REQUEST',
      );
    });

    it('malformed JSON is 422 VALIDATION_FAILED', async () => {
      await failure(
        await postWebhook(app, sourceId, null, { body: '{"alerts": [' }),
        422,
        'VALIDATION_FAILED',
      );
    });

    it.each([
      ['a missing alerts', '{}'],
      ['an empty alerts', '{"alerts":[]}'],
      ['alerts that is not an array', '{"alerts":"x"}'],
      ['a body that is not an object', '[]'],
    ])('%s is 422 VALIDATION_FAILED', async (_name, body) => {
      await failure(await postWebhook(app, sourceId, null, { body }), 422, 'VALIDATION_FAILED');
    });

    it('an unknown top-level field is 400 BAD_REQUEST', async () => {
      const body = JSON.stringify({ alerts: makeAlerts(1), extra: true });
      await failure(await postWebhook(app, sourceId, null, { body }), 400, 'BAD_REQUEST');
    });

    it('101 alerts is 400 BAD_REQUEST; 100 alerts pass, the rate-limited ones marked', async () => {
      await failure(await postWebhook(app, sourceId, makeAlerts(101)), 400, 'BAD_REQUEST');

      const other = await createAlertSource({ name: 'Other' });
      const res = await postWebhook(app, other.id, makeAlerts(100));
      expect(res.status).toBe(200);
      const context = ingest.mock.calls[0]![0];
      expect(context.items).toHaveLength(100);
      expect(context.rateLimitedIndices).toEqual(Array.from({ length: 85 }, (_, i) => 15 + i));
    });

    it('a request that fails the envelope never reaches ingestion and persists nothing', async () => {
      await postWebhook(app, sourceId, []);
      expect(await getPrisma().alert.count()).toBe(0);
      expect(await getPrisma().incident.count()).toBe(0);
      expect(await outboxRows()).toHaveLength(0);
    });
  });

  describe('step 1 · body size', () => {
    const LIMIT = 1024 * 1024;
    const padded = (bytes: number) => {
      const shell = '{"alerts":[{"pad":""}]}';
      return shell.replace('"pad":""', `"pad":"${'x'.repeat(bytes - shell.length)}"`);
    };

    it('accepts a body of exactly 1 MB', async () => {
      const body = padded(LIMIT);
      expect(Buffer.byteLength(body)).toBe(LIMIT);
      const res = await postWebhook(app, sourceId, null, { body });
      expect(res.status).toBe(200);
      expect(ingest.mock.calls[0]![0].items).toHaveLength(1);
    });

    it('rejects a body of 1 MB + 1 byte with 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await postWebhook(app, sourceId, null, { body: padded(LIMIT + 1) });
      expect(res.status).toBe(413);
      expect(res.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: [] });
      expect(ingest).not.toHaveBeenCalled();
    });

    it('decides before authentication: an unsigned or unknown-source oversize body is 413', async () => {
      const big = padded(LIMIT + 1);
      const unknown = await request(app)
        .post('/webhooks/alerts/0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f90')
        .set('Content-Type', 'application/json')
        .send(big);
      expect(unknown.status).toBe(413);
      expect(await getRedis().keys('wh:*')).toEqual([]);
    });
  });

  describe('Redis unavailable: fail closed', () => {
    const dead = createRedisConnection('general', 'redis://127.0.0.1:1');
    afterAll(() => {
      if (dead.status !== 'end') dead.disconnect();
    });

    it('at step 4 (replay store): 503 DEPENDENCY_UNAVAILABLE with Retry-After, nothing processed', async () => {
      const down = buildTestApp(undefined, { ingest, replayStore: createReplayStore(dead) });
      const res = await postWebhook(down, sourceId, makeAlerts(1));

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', details: [] });
      expect(ingest).not.toHaveBeenCalled();
      expect(await getRedis().keys('wh:*')).toEqual([]); // the rate limiter was not run either
    });

    it('at step 5 (rate limiter): 503 with Retry-After, nothing processed or stored', async () => {
      const down = buildTestApp(undefined, { ingest, rateLimiter: createRateLimiter(dead) });
      const res = await postWebhook(down, sourceId, makeAlerts(1));

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(ingest).not.toHaveBeenCalled();
      expect(await getPrisma().alert.count()).toBe(0);
      expect(await getRedis().get(keys().count)).toBeNull();
    });

    it('steps that do not need Redis answer as specified', async () => {
      const down = buildTestApp(undefined, {
        ingest,
        replayStore: createReplayStore(dead),
        rateLimiter: createRateLimiter(dead),
      });
      const oversize = await request(down)
        .post(`/webhooks/alerts/${sourceId}`)
        .set('Content-Type', 'application/json')
        .send('x'.repeat(1024 * 1024 + 1));
      expect(oversize.status).toBe(413);

      expect(
        (
          await postWebhook(down, sourceId, makeAlerts(1), {
            secret: 'wrong-wrong-wrong-wrong-wrong-wrong',
          })
        ).status,
      ).toBe(401);
      expect(
        (await postWebhook(down, sourceId, makeAlerts(1), { timestamp: nowSeconds() - 1000 })).body
          .error.code,
      ).toBe('REQUEST_STALE');
    });

    it('recovers when Redis is back, and a wiped Redis starts empty', async () => {
      const body = JSON.stringify({ alerts: makeAlerts(15) });
      const timestamp = nowSeconds();
      expect((await postWebhook(app, sourceId, null, { body, timestamp })).status).toBe(200);
      expect((await postWebhook(app, sourceId, null, { body, timestamp })).status).toBe(409);
      expect((await postWebhook(app, sourceId, makeAlerts(1))).status).toBe(429);

      await getRedis().flushdb(); // replay records, counters, ladder memory and blocks reset

      expect((await postWebhook(app, sourceId, null, { body, timestamp })).status).toBe(200);
    });
  });
});
