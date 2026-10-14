import { isDatabaseUnavailable } from '../../infra/db/errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../shared/observability/logger.js';
import type { RateLimiter } from './rate-limiter.js';
import { computeSignature } from './signature.js';
import type { AlertSourceRecord } from './source.repository.js';
import { runTrustGate, type TrustGateDeps, type TrustGateInput } from './trust-gate.js';

logger.level = 'silent';

const SECRET = 'unit-test-signing-secret-0123456789';
const SOURCE_ID = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f90';
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const CONFIGURATION = { signingSecret: SECRET, severityMapping: { critical: 'P0' } };

const SOURCE: AlertSourceRecord = {
  id: SOURCE_ID,
  name: 'Generic',
  sourceType: 'GENERIC',
  status: 'ACTIVE',
  configuration: CONFIGURATION,
};

function input(overrides: Partial<TrustGateInput> & { body?: string; timestamp?: number } = {}) {
  const body = overrides.body ?? JSON.stringify({ alerts: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  const rawBody = overrides.rawBody ?? Buffer.from(body);
  const timestamp = String(overrides.timestamp ?? NOW_S);
  const signature = `sha256=${computeSignature(SECRET, timestamp, rawBody).toString('hex')}`;
  return {
    alertSourceId: SOURCE_ID,
    signatureHeader: signature,
    timestampHeader: timestamp,
    contentType: 'application/json',
    requestId: 'req-1',
    ...overrides,
    rawBody,
  } satisfies TrustGateInput;
}

function fakeDeps(overrides: Partial<TrustGateDeps> = {}) {
  const rateLimiter: jest.Mocked<RateLimiter> = {
    consume: jest
      .fn()
      .mockImplementation((_id: string, n: number) =>
        Promise.resolve({ kind: 'ALLOWED', allowed: n }),
      ),
    claimPendingNotice: jest.fn().mockResolvedValue(null),
    acknowledgeNotice: jest.fn().mockResolvedValue(undefined),
  };
  const deps: TrustGateDeps = {
    findSource: jest.fn().mockResolvedValue(SOURCE),
    replayStore: { markSeen: jest.fn().mockResolvedValue(true) },
    rateLimiter,
    notifyBlocked: jest.fn().mockResolvedValue(undefined),
    now: () => NOW_MS,
    ...overrides,
  };
  return { deps, rateLimiter };
}

const rejectsWith = (promise: Promise<unknown>, expected: object) =>
  expect(promise).rejects.toMatchObject(expected);

describe('runTrustGate', () => {
  it('hands over the verified context in request order', async () => {
    const { deps } = fakeDeps();
    const context = await runTrustGate(input(), deps);
    expect(context).toEqual({
      alertSource: {
        id: SOURCE_ID,
        name: 'Generic',
        sourceType: 'GENERIC',
        configuration: CONFIGURATION,
      },
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
      rateLimitedIndices: [],
      requestId: 'req-1',
    });
    expect(deps.replayStore.markSeen).toHaveBeenCalledWith(
      SOURCE_ID,
      input().signatureHeader.slice('sha256='.length),
    );
  });

  describe('step 2: source authentication', () => {
    const failed = { statusCode: 401, code: 'SOURCE_AUTH_FAILED' };

    it.each([
      ['a wrong signature', { signatureHeader: `sha256=${'0'.repeat(64)}` }],
      ['a missing signature', { signatureHeader: undefined }],
      ['a missing timestamp', { timestampHeader: undefined }],
      ['a malformed source id', { alertSourceId: 'not-a-uuid' }],
    ])('%s', async (_name, override) => {
      const { deps } = fakeDeps();
      await rejectsWith(runTrustGate({ ...input(), ...override }, deps), failed);
    });

    it('a tampered body', async () => {
      const { deps } = fakeDeps();
      await rejectsWith(
        runTrustGate({ ...input(), rawBody: Buffer.from('{"alerts":[]}') }, deps),
        failed,
      );
    });

    it.each([
      ['an unknown source', null],
      ['a deactivated source', { ...SOURCE, status: 'DEACTIVATED' as const }],
      ['a source without a signing secret', { ...SOURCE, configuration: {} }],
      ['a source whose configuration is not an object', { ...SOURCE, configuration: 'x' }],
    ])('%s', async (_name, record) => {
      const { deps } = fakeDeps({ findSource: jest.fn().mockResolvedValue(record) });
      await rejectsWith(runTrustGate(input(), deps), failed);
    });

    it('does not look up a malformed source id', async () => {
      const { deps } = fakeDeps();
      await runTrustGate({ ...input(), alertSourceId: 'nope' }, deps).catch(() => undefined);
      expect(deps.findSource).not.toHaveBeenCalled();
    });

    it('a database outage on the lookup is 503 DEPENDENCY_UNAVAILABLE with Retry-After', async () => {
      const outage = new Prisma.PrismaClientKnownRequestError('down', {
        code: 'P1001',
        clientVersion: 'test',
      });
      expect(isDatabaseUnavailable(outage)).toBe(true);
      const { deps } = fakeDeps({ findSource: jest.fn().mockRejectedValue(outage) });
      await rejectsWith(runTrustGate(input(), deps), {
        statusCode: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        retryAfterSeconds: 5,
      });
    });

    it('any other lookup error is not hidden as an authentication failure', async () => {
      const boom = new Error('boom');
      const { deps } = fakeDeps({ findSource: jest.fn().mockRejectedValue(boom) });
      await expect(runTrustGate(input(), deps)).rejects.toBe(boom);
    });
  });

  describe('step 3: timestamp', () => {
    it.each([
      [NOW_S - 300, true],
      [NOW_S - 301, false],
      [NOW_S + 300, true],
      [NOW_S + 301, false],
    ])('timestamp %i accepted: %s', async (timestamp, accepted) => {
      const { deps } = fakeDeps();
      const run = runTrustGate(input({ timestamp }), deps);
      if (accepted) await expect(run).resolves.toBeDefined();
      else await rejectsWith(run, { statusCode: 401, code: 'REQUEST_STALE' });
    });

    it('a bad signature wins over a stale timestamp', async () => {
      const { deps } = fakeDeps();
      await rejectsWith(
        runTrustGate(
          { ...input({ timestamp: NOW_S - 1000 }), signatureHeader: `sha256=${'0'.repeat(64)}` },
          deps,
        ),
        { code: 'SOURCE_AUTH_FAILED' },
      );
    });
  });

  describe('step 4: replay', () => {
    it('a signature already seen is 409 REPLAY_DETECTED, before the rate limit is touched', async () => {
      const { deps, rateLimiter } = fakeDeps({
        replayStore: { markSeen: jest.fn().mockResolvedValue(false) },
      });
      await rejectsWith(runTrustGate(input(), deps), { statusCode: 409, code: 'REPLAY_DETECTED' });
      expect(rateLimiter.consume).not.toHaveBeenCalled();
    });

    it('a replay store failure stops the request before the rate limit', async () => {
      const failure = Object.assign(new Error('down'), { statusCode: 503 });
      const { deps, rateLimiter } = fakeDeps({
        replayStore: { markSeen: jest.fn().mockRejectedValue(failure) },
      });
      await expect(runTrustGate(input(), deps)).rejects.toBe(failure);
      expect(rateLimiter.consume).not.toHaveBeenCalled();
    });
  });

  describe('step 5: rate limit', () => {
    it('counts the alerts of the request', async () => {
      const { deps, rateLimiter } = fakeDeps();
      await runTrustGate(input(), deps);
      expect(rateLimiter.consume).toHaveBeenCalledWith(SOURCE_ID, 3);
    });

    it.each([
      ['malformed JSON', 'not json'],
      ['alerts that is not an array', '{"alerts":"x"}'],
    ])('counts nothing for %s and lets step 6 decide', async (_name, body) => {
      const { deps, rateLimiter } = fakeDeps();
      await rejectsWith(runTrustGate(input({ body }), deps), { statusCode: 422 });
      expect(rateLimiter.consume).toHaveBeenCalledWith(SOURCE_ID, 0);
    });

    it('partial capacity: the rest are marked for item-level rejection', async () => {
      const { deps, rateLimiter } = fakeDeps();
      rateLimiter.consume.mockResolvedValue({ kind: 'ALLOWED', allowed: 1 });
      const context = await runTrustGate(input(), deps);
      expect(context.items).toHaveLength(3);
      expect(context.rateLimitedIndices).toEqual([1, 2]);
    });

    it('a violation is 429 RATE_LIMITED with the block as Retry-After (rounded up)', async () => {
      const { deps, rateLimiter } = fakeDeps();
      rateLimiter.consume.mockResolvedValue({
        kind: 'VIOLATION',
        retryAfterMs: 300_000,
        attemptCount: 1,
        finalStage: false,
      });
      await rejectsWith(runTrustGate(input(), deps), {
        statusCode: 429,
        code: 'RATE_LIMITED',
        retryAfterSeconds: 300,
      });
      expect(deps.notifyBlocked).not.toHaveBeenCalled();
    });

    it('a blocked source is 429 with the remaining block', async () => {
      const { deps, rateLimiter } = fakeDeps();
      rateLimiter.consume.mockResolvedValue({ kind: 'BLOCKED', retryAfterMs: 1_500 });
      await rejectsWith(runTrustGate(input(), deps), { statusCode: 429, retryAfterSeconds: 2 });
      expect(deps.notifyBlocked).not.toHaveBeenCalled();
    });

    it('is decided before the envelope: a blocked source with a bad body is still 429', async () => {
      const { deps, rateLimiter } = fakeDeps();
      rateLimiter.consume.mockResolvedValue({ kind: 'BLOCKED', retryAfterMs: 5_000 });
      await rejectsWith(runTrustGate(input({ body: 'not json' }), deps), { statusCode: 429 });
    });

    describe('final stage', () => {
      const final = {
        kind: 'VIOLATION',
        retryAfterMs: 86_400_000,
        attemptCount: 5,
        finalStage: true,
      } as const;

      it('writes the Admin notice once, records it, and still answers 429', async () => {
        const { deps, rateLimiter } = fakeDeps();
        rateLimiter.consume.mockResolvedValue(final);
        await rejectsWith(runTrustGate(input(), deps), {
          statusCode: 429,
          retryAfterSeconds: 86_400,
        });
        expect(deps.notifyBlocked).toHaveBeenCalledTimes(1);
        expect(deps.notifyBlocked).toHaveBeenCalledWith({
          alertSourceId: SOURCE_ID,
          attemptCount: 5,
          requestId: 'req-1',
        });
        expect(rateLimiter.acknowledgeNotice).toHaveBeenCalledWith(SOURCE_ID);
      });

      it('a failed write is not acknowledged (so it is retried) and does not change the answer', async () => {
        const { deps, rateLimiter } = fakeDeps({
          notifyBlocked: jest.fn().mockRejectedValue(new Error('db down')),
        });
        rateLimiter.consume.mockResolvedValue(final);
        await rejectsWith(runTrustGate(input(), deps), { statusCode: 429 });
        expect(rateLimiter.acknowledgeNotice).not.toHaveBeenCalled();
      });

      it('a blocked request retries a pending notice, claiming it first', async () => {
        const { deps, rateLimiter } = fakeDeps();
        rateLimiter.consume.mockResolvedValue({ kind: 'BLOCKED', retryAfterMs: 1_000 });
        rateLimiter.claimPendingNotice.mockResolvedValue(5);
        await rejectsWith(runTrustGate(input(), deps), { statusCode: 429 });
        expect(deps.notifyBlocked).toHaveBeenCalledWith({
          alertSourceId: SOURCE_ID,
          attemptCount: 5,
          requestId: 'req-1',
        });
        expect(rateLimiter.acknowledgeNotice).toHaveBeenCalledTimes(1);
      });

      it('a blocked request with nothing pending writes nothing', async () => {
        const { deps, rateLimiter } = fakeDeps();
        rateLimiter.consume.mockResolvedValue({ kind: 'BLOCKED', retryAfterMs: 1_000 });
        await rejectsWith(runTrustGate(input(), deps), { statusCode: 429 });
        expect(deps.notifyBlocked).not.toHaveBeenCalled();
      });

      it('a failure to check for a pending notice never changes the 429', async () => {
        const { deps, rateLimiter } = fakeDeps();
        rateLimiter.consume.mockResolvedValue({ kind: 'BLOCKED', retryAfterMs: 1_000 });
        rateLimiter.claimPendingNotice.mockRejectedValue(new Error('redis down'));
        await rejectsWith(runTrustGate(input(), deps), { statusCode: 429 });
      });
    });

    it('a limiter failure stops the request (fail closed)', async () => {
      const failure = Object.assign(new Error('down'), { statusCode: 503 });
      const { deps, rateLimiter } = fakeDeps();
      rateLimiter.consume.mockRejectedValue(failure);
      await expect(runTrustGate(input(), deps)).rejects.toBe(failure);
    });
  });

  describe('step 6: envelope', () => {
    it('is checked after the rate limit', async () => {
      const { deps, rateLimiter } = fakeDeps();
      await rejectsWith(runTrustGate(input({ contentType: undefined }), deps), { statusCode: 400 });
      expect(rateLimiter.consume).toHaveBeenCalled();
    });

    it.each([
      ['an empty alerts array', '{"alerts":[]}'],
      ['a missing alerts', '{}'],
    ])('%s is 422', async (_name, body) => {
      const { deps } = fakeDeps();
      await rejectsWith(runTrustGate(input({ body }), deps), {
        statusCode: 422,
        code: 'VALIDATION_FAILED',
      });
    });
  });
});
