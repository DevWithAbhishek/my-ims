import { Queue, UnrecoverableError, type Worker } from 'bullmq';
import { getPrisma } from '../../src/infra/db/prisma';
import { NonRetryableJobError, RetryableJobError } from '../../src/infra/jobs/errors';
import { createBullmqGateway, type QueueGateway } from '../../src/infra/jobs/gateway';
import { createJobWorker, processOutboxJob } from '../../src/infra/jobs/processor';
import { recoverStaleOutbox } from '../../src/infra/jobs/maintenance';
import {
  clearProcessors,
  registerProcessor,
  type OutboxProcessor,
} from '../../src/infra/jobs/registry';
import { runRelayCycle } from '../../src/infra/jobs/relay';
import { startJobsRuntime } from '../../src/infra/jobs/runtime';
import { createRedisConnection, getRedis } from '../../src/infra/redis/redis';
import { resetState } from '../helpers/identity';
import { FakeGateway, insertOutbox, sleep, testJobsConfig, waitFor } from '../helpers/jobs';

const db = () => getPrisma();
const row = (id: string) => db().outboxEvent.findUniqueOrThrow({ where: { id } });
const config = testJobsConfig();

beforeEach(async () => {
  clearProcessors();
  await resetState();
});
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

/** The BullMQ job as the wrapper sees it, built from an outbox row id. */
async function jobFor(id: string, attemptsMade = 0) {
  const stored = await row(id);
  return {
    data: {
      outboxEventId: id,
      eventType: stored.eventType,
      aggregateType: stored.aggregateType,
      aggregateId: stored.aggregateId,
      payload: stored.payload,
    },
    attemptsMade,
    opts: { attempts: 5 },
  };
}

/** Puts a row into PROCESSING as the relay would. */
async function publishedRow() {
  const made = await insertOutbox();
  await runRelayCycle(config, new FakeGateway());
  expect((await row(made.id)).status).toBe('PROCESSING');
  return made;
}

const QUEUE = 'sla-escalation';

describe('worker wrapper', () => {
  it('marks the row SUCCESS (processedAt set, lease cleared) when the consumer succeeds', async () => {
    const { id } = await publishedRow();
    const seen: number[] = [];
    await processOutboxJob(
      await jobFor(id),
      QUEUE,
      async (input) => void seen.push(input.attempt),
      {
        config,
        gateway: new FakeGateway(),
      },
    );
    expect(seen).toEqual([1]);
    const stored = await row(id);
    expect(stored.status).toBe('SUCCESS');
    expect(stored.processedAt).not.toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
  });

  it('passes the validated payload (with requestId) to the consumer', async () => {
    const { id, incidentId } = await publishedRow();
    let payload: unknown;
    await processOutboxJob(
      await jobFor(id),
      QUEUE,
      async (input) => void (payload = input.payload),
      {
        config,
        gateway: new FakeGateway(),
      },
    );
    expect(payload).toEqual({ incidentId, requestId: 'req-test' });
  });

  it('retries a retryable failure up to 5 attempts, then dead-letters with a durable record', async () => {
    const { id } = await publishedRow();
    const gateway = new FakeGateway();
    const failing: OutboxProcessor = async () => {
      throw new RetryableJobError('SERVICE_UNAVAILABLE', 'provider temporarily down');
    };

    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(
        processOutboxJob(await jobFor(id, attempt - 1), QUEUE, failing, { config, gateway }),
      ).rejects.toBeInstanceOf(RetryableJobError);
      const stored = await row(id);
      expect(stored).toMatchObject({
        status: 'PROCESSING',
        executionAttemptCount: attempt,
        errorClass: 'SERVICE_UNAVAILABLE',
      });
      expect(stored.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    }
    expect(gateway.deadLetters).toHaveLength(0);

    await expect(
      processOutboxJob(await jobFor(id, 4), QUEUE, failing, { config, gateway }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await row(id)).toMatchObject({
      status: 'DEAD_LETTER',
      executionAttemptCount: 5,
      publishAttemptCount: 1,
      errorClass: 'SERVICE_UNAVAILABLE',
      lastError: 'provider temporarily down',
      leaseExpiresAt: null,
    });
    expect(gateway.deadLetters).toEqual([
      {
        outboxEventId: id,
        eventType: 'SLA_EVALUATION_REQUESTED',
        sourceQueue: QUEUE,
        errorClass: 'SERVICE_UNAVAILABLE',
      },
    ]);
  });

  it('dead-letters a non-retryable failure immediately', async () => {
    const { id } = await publishedRow();
    const gateway = new FakeGateway();
    await expect(
      processOutboxJob(
        await jobFor(id),
        QUEUE,
        async () => {
          throw new NonRetryableJobError('RESOURCE_NOT_FOUND', 'incident does not exist');
        },
        { config, gateway },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await row(id)).toMatchObject({
      status: 'DEAD_LETTER',
      executionAttemptCount: 1,
      errorClass: 'RESOURCE_NOT_FOUND',
    });
    expect(gateway.deadLetters).toHaveLength(1);
  });

  it('retries an unknown error a limited number of times, then dead-letters it', async () => {
    const { id } = await publishedRow();
    const gateway = new FakeGateway();
    const boom: OutboxProcessor = async () => {
      throw new Error('SELECT secret FROM somewhere');
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(
        processOutboxJob(await jobFor(id, attempt - 1), QUEUE, boom, { config, gateway }),
      ).rejects.toThrow();
    }
    const stored = await row(id);
    expect(stored).toMatchObject({
      status: 'DEAD_LETTER',
      executionAttemptCount: 5,
      errorClass: 'UNKNOWN_INTERNAL',
      lastError: 'Error',
    });
    expect(gateway.deadLetters).toHaveLength(1);
  });

  it('dead-letters a poison payload without running the consumer', async () => {
    const { id } = await publishedRow();
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "payload" = '{"nope":1}'::jsonb WHERE id = ${id}::uuid`;
    const consumer = jest.fn();
    await expect(
      processOutboxJob(await jobFor(id), QUEUE, consumer, { config, gateway: new FakeGateway() }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(consumer).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'DEAD_LETTER', errorClass: 'INVALID_PAYLOAD' });
  });

  it('dead-letters an event that does not belong to the queue it arrived on', async () => {
    const { id } = await publishedRow();
    await expect(
      processOutboxJob(await jobFor(id), 'notifications', jest.fn(), {
        config,
        gateway: new FakeGateway(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await row(id)).errorClass).toBe('UNSUPPORTED_EVENT_TYPE');
  });

  it('rejects job data that does not identify an outbox event', async () => {
    await expect(
      processOutboxJob(
        { data: { hello: 'x' }, attemptsMade: 0, opts: { attempts: 5 } },
        QUEUE,
        jest.fn(),
        {
          config,
          gateway: new FakeGateway(),
        },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('a duplicate publication has a single business effect and one final SUCCESS', async () => {
    const { id, incidentId } = await publishedRow();
    const effects = new Map<string, number>(); // the consumer's own once-only key
    const consumer: OutboxProcessor = async ({ payload }) => {
      const key = String(payload.incidentId);
      if (!effects.has(key)) effects.set(key, 1);
    };

    // The worker did the work, then "crashed" before marking SUCCESS: the row stays PROCESSING.
    await consumer({ ...(await jobFor(id)).data, attempt: 1, payload: { incidentId } });
    expect((await row(id)).status).toBe('PROCESSING');

    // Recovery republishes; the idempotent consumer is a no-op that then marks SUCCESS.
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "leaseExpiresAt" = now() - interval '1 minute' WHERE id = ${id}::uuid`;
    await recoverStaleOutbox();
    const gateway = new FakeGateway();
    await runRelayCycle(config, gateway);
    expect(gateway.published).toHaveLength(1);

    await processOutboxJob(await jobFor(id), QUEUE, consumer, { config, gateway });
    await processOutboxJob(await jobFor(id), QUEUE, consumer, { config, gateway }); // duplicate job
    expect([...effects.values()]).toEqual([1]);
    expect((await row(id)).status).toBe('SUCCESS');
  });
});

describe('relay -> BullMQ -> worker (real Redis)', () => {
  const openGateways: QueueGateway[] = [];
  const openWorkers: Worker[] = [];
  const connections: ReturnType<typeof createRedisConnection>[] = [];

  function realGateway(): QueueGateway {
    const connection = createRedisConnection('general');
    connections.push(connection);
    const gateway = createBullmqGateway(connection, config.executionAttempts);
    openGateways.push(gateway);
    return gateway;
  }

  function startWorker(gateway: QueueGateway, processor: OutboxProcessor): Worker {
    const connection = createRedisConnection('bullmq');
    connections.push(connection);
    const worker = createJobWorker(QUEUE, processor, { config, gateway }, connection);
    openWorkers.push(worker);
    return worker;
  }

  afterEach(async () => {
    await Promise.all(openWorkers.splice(0).map((w) => w.close()));
    await Promise.all(openGateways.splice(0).map((g) => g.close()));
    connections.splice(0).forEach((c) => c.disconnect());
  });

  it('delivers an outbox event end to end and marks it SUCCESS', async () => {
    const gateway = realGateway();
    const calls: string[] = [];
    startWorker(gateway, async ({ outboxEventId }) => void calls.push(outboxEventId));

    const { id } = await insertOutbox();
    await runRelayCycle(config, gateway);
    await waitFor(async () => (await row(id)).status === 'SUCCESS');
    expect(calls).toEqual([id]);
  });

  it('retries with exponential backoff for 5 attempts in total, then dead-letters and announces it', async () => {
    const gateway = realGateway();
    const attempts: number[] = [];
    startWorker(gateway, async ({ attempt }) => {
      attempts.push(attempt);
      throw new RetryableJobError('NETWORK', 'temporary network failure');
    });

    const { id } = await insertOutbox();
    await runRelayCycle(config, gateway);
    await waitFor(async () => (await row(id)).status === 'DEAD_LETTER');

    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(await row(id)).toMatchObject({
      executionAttemptCount: 5,
      publishAttemptCount: 1,
      errorClass: 'NETWORK',
    });

    const dlqConnection = createRedisConnection('general');
    connections.push(dlqConnection);
    const dlq = new Queue('dead-letter', { connection: dlqConnection });
    try {
      const jobs = await waitFor(async () => {
        const found = await dlq.getJobs(['waiting', 'delayed', 'completed']);
        return found.length > 0 && found;
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({
        outboxEventId: id,
        eventType: 'SLA_EVALUATION_REQUESTED',
        sourceQueue: QUEUE,
        errorClass: 'NETWORK',
      });
    } finally {
      await dlq.close();
    }
  });

  it('does not retry a non-retryable failure', async () => {
    const gateway = realGateway();
    let calls = 0;
    startWorker(gateway, async () => {
      calls++;
      throw new NonRetryableJobError('BUSINESS_RULE_VIOLATION', 'cannot be done');
    });
    const { id } = await insertOutbox();
    await runRelayCycle(config, gateway);
    await waitFor(async () => (await row(id)).status === 'DEAD_LETTER');
    await sleep(300);
    expect(calls).toBe(1);
    expect((await row(id)).executionAttemptCount).toBe(1);
  });

  it('honors a provider-supplied delay when rate limited', async () => {
    const gateway = realGateway();
    const times: number[] = [];
    startWorker(gateway, async () => {
      times.push(Date.now());
      if (times.length === 1) throw new RetryableJobError('RATE_LIMITED', 'slow down', 400);
    });
    const { id } = await insertOutbox();
    await runRelayCycle(config, gateway);
    await waitFor(async () => (await row(id)).status === 'SUCCESS');
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(380);
  });

  it('re-publishes the same event while its job still exists without running it twice', async () => {
    const gateway = realGateway();
    const { id } = await insertOutbox();
    await runRelayCycle(config, gateway);
    // Simulate the relay losing track: the row goes back to PENDING while the job is still queued.
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "status" = 'PENDING', "leaseExpiresAt" = NULL WHERE id = ${id}::uuid`;
    await runRelayCycle(config, gateway);

    const calls: string[] = [];
    startWorker(gateway, async ({ outboxEventId }) => void calls.push(outboxEventId));
    await waitFor(async () => (await row(id)).status === 'SUCCESS');
    await sleep(200);
    expect(calls).toEqual([id]); // BullMQ de-duplicated by jobId
  });

  it('recovers after Redis loses its jobs: the stale row is republished and processed', async () => {
    const gateway = realGateway();
    const { id } = await insertOutbox();
    await runRelayCycle(config, gateway);
    await getRedis().flushdb(); // Redis wiped: the job is gone, the row says PROCESSING
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "leaseExpiresAt" = now() - interval '1 minute' WHERE id = ${id}::uuid`;

    const calls: string[] = [];
    startWorker(gateway, async ({ outboxEventId }) => void calls.push(outboxEventId));
    expect(await recoverStaleOutbox()).toBe(1);
    await runRelayCycle(config, gateway);
    await waitFor(async () => (await row(id)).status === 'SUCCESS');
    expect(calls).toEqual([id]);
  });

  it('keeps events PENDING with backoff while Redis is unreachable, then publishes when it returns', async () => {
    const down = createRedisConnection('general', 'redis://127.0.0.1:1/0');
    connections.push(down);
    const downGateway = createBullmqGateway(down, config.executionAttempts);
    const { id } = await insertOutbox();

    const result = await runRelayCycle({ ...config, publishTimeoutMs: 500 }, downGateway);
    expect(result).toMatchObject({ claimed: 1, retried: 1, deadLettered: 0 });
    const stored = await row(id);
    expect(stored).toMatchObject({ status: 'PENDING', publishAttemptCount: 1 });
    expect(['REDIS_UNAVAILABLE', 'NETWORK']).toContain(stored.errorClass);
    expect(stored.availableAt.getTime()).toBeGreaterThan(Date.now());
    down.disconnect();

    // Redis is back: the same row is published through a healthy gateway.
    await db().$executeRaw`UPDATE "OutboxEvent" SET "availableAt" = now() WHERE id = ${id}::uuid`;
    const calls: string[] = [];
    const healthy = realGateway();
    startWorker(healthy, async ({ outboxEventId }) => void calls.push(outboxEventId));
    await runRelayCycle(config, healthy);
    await waitFor(async () => (await row(id)).status === 'SUCCESS');
    expect(calls).toEqual([id]);
  });
});

describe('jobs runtime', () => {
  it('drains pending rows through the relay loop, recovers stale rows and applies retention', async () => {
    const calls: string[] = [];
    registerProcessor(QUEUE, async ({ outboxEventId }) => void calls.push(outboxEventId));

    const staleSuccess = await insertOutbox();
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "status" = 'SUCCESS', "processedAt" = now() - interval '2 days' WHERE id = ${staleSuccess.id}::uuid`;
    const ids = await Promise.all(Array.from({ length: 30 }, () => insertOutbox()));

    const runtime = startJobsRuntime({
      ...config,
      relayBatchSize: 10,
      retentionWindowMs: 3_600_000,
    });
    try {
      await waitFor(
        async () => (await db().outboxEvent.count({ where: { status: 'SUCCESS' } })) === 30,
      );
      expect(new Set(calls)).toEqual(new Set(ids.map((x) => x.id)));
      await waitFor(
        async () =>
          (await db().outboxEvent.findUnique({ where: { id: staleSuccess.id } })) === null,
      );
    } finally {
      await runtime.stop();
    }
  });
});
