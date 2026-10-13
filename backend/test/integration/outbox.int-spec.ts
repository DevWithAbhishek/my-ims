import { randomUUID } from 'node:crypto';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import { OutboxContractError, enqueueOutbox } from '../../src/infra/jobs/outbox';
import { claimBatch, markPublished } from '../../src/infra/jobs/outbox.repository';
import { purgeFinishedOutbox, recoverStaleOutbox } from '../../src/infra/jobs/maintenance';
import { redriveOutboxEvent, RedriveError } from '../../src/infra/jobs/redrive';
import { runRelayCycle } from '../../src/infra/jobs/relay';
import { getRedis } from '../../src/infra/redis/redis';
import { resetState } from '../helpers/identity';
import { FakeGateway, insertOutbox, testJobsConfig } from '../helpers/jobs';

const db = () => getPrisma();
const row = (id: string) => db().outboxEvent.findUniqueOrThrow({ where: { id } });
const config = testJobsConfig();

beforeEach(resetState);
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

describe('enqueueOutbox (write contract)', () => {
  it('leaves exactly one PENDING row with zero counters when the transaction commits', async () => {
    const { id, incidentId } = await insertOutbox();
    const stored = await row(id);
    expect(stored).toMatchObject({
      eventType: 'SLA_EVALUATION_REQUESTED',
      aggregateType: 'Incident',
      aggregateId: incidentId,
      status: 'PENDING',
      publishAttemptCount: 0,
      executionAttemptCount: 0,
      publishedAt: null,
      processedAt: null,
      leaseExpiresAt: null,
      errorClass: null,
      lastError: null,
    });
    expect(stored.payload).toEqual({ incidentId, requestId: 'req-test' });
    expect(await db().outboxEvent.count()).toBe(1);
  });

  it('leaves no row when the producer transaction rolls back', async () => {
    await expect(
      runInTransaction(async (tx) => {
        await insertInTx(tx);
        throw new Error('producer failed after enqueue');
      }),
    ).rejects.toThrow('producer failed');
    expect(await db().outboxEvent.count()).toBe(0);
  });

  it('honors availableAt', async () => {
    const later = new Date(Date.now() + 3_600_000);
    const id = await runInTransaction((tx) => insertInTx(tx, later));
    expect((await row(id)).availableAt.getTime()).toBe(later.getTime());
  });

  it.each([
    ['an unsupported event type', { eventType: 'NOPE' }, 'UNSUPPORTED_EVENT_TYPE'],
    ['an invalid payload', { payload: { incidentId: 'not-a-uuid' } }, 'INVALID_PAYLOAD'],
    [
      'a payload with extra keys',
      { payload: { incidentId: randomUUID(), body: 'x' } },
      'INVALID_PAYLOAD',
    ],
    ['a non-UUID aggregate id', { aggregateId: 'abc' }, 'INVALID_AGGREGATE'],
  ])('rejects %s and writes nothing', async (_name, override, reason) => {
    const attempt = runInTransaction((tx) =>
      enqueueOutbox(tx, {
        eventType: 'SLA_EVALUATION_REQUESTED',
        aggregateType: 'Incident',
        aggregateId: randomUUID(),
        payload: { incidentId: randomUUID() },
        ...override,
      }),
    );
    await expect(attempt).rejects.toMatchObject({ name: 'OutboxContractError', reason });
    await expect(attempt).rejects.toBeInstanceOf(OutboxContractError);
    expect(await db().outboxEvent.count()).toBe(0);
  });
});

async function insertInTx(tx: Parameters<typeof enqueueOutbox>[0], availableAt?: Date) {
  const incidentId = randomUUID();
  return enqueueOutbox(tx, {
    eventType: 'SLA_EVALUATION_REQUESTED',
    aggregateType: 'Incident',
    aggregateId: incidentId,
    payload: { incidentId },
    availableAt,
  });
}

describe('relay: claim and publish', () => {
  it('publishes once and moves the row to PROCESSING with publishedAt and a lease', async () => {
    const { id } = await insertOutbox();
    const gateway = new FakeGateway();

    const result = await runRelayCycle(config, gateway);
    expect(result).toMatchObject({ claimed: 1, published: 1, retried: 0, deadLettered: 0 });
    expect(gateway.published).toHaveLength(1);
    expect(gateway.published[0]).toMatchObject({
      queue: 'sla-escalation',
      data: { outboxEventId: id, eventType: 'SLA_EVALUATION_REQUESTED' },
    });

    const stored = await row(id);
    expect(stored.status).toBe('PROCESSING');
    expect(stored.publishedAt).not.toBeNull();
    expect(stored.publishAttemptCount).toBe(1);
    expect(stored.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // Nothing left to claim.
    expect((await runRelayCycle(config, gateway)).claimed).toBe(0);
    expect(gateway.published).toHaveLength(1);
  });

  it('does not claim rows that are not yet available', async () => {
    const later = new Date(Date.now() + 3_600_000);
    await runInTransaction((tx) => insertInTx(tx, later));
    const gateway = new FakeGateway();
    expect((await runRelayCycle(config, gateway)).claimed).toBe(0);
  });

  it('never double-claims when two relays run in parallel', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => insertOutbox()));
    const [a, b] = [new FakeGateway(), new FakeGateway()];
    a.publishDelayMs = b.publishDelayMs = 30;

    const [first, second] = await Promise.all([
      runRelayCycle({ ...config, relayBatchSize: 20 }, a),
      runRelayCycle({ ...config, relayBatchSize: 20 }, b),
    ]);

    const published = [...a.published, ...b.published].map((p) => p.data.outboxEventId);
    expect(new Set(published).size).toBe(published.length);
    expect([...published].sort()).toEqual(ids.map((x) => x.id).sort());
    expect(first.claimed + second.claimed).toBe(20);
  });

  it('claims in batches no larger than the configured size', async () => {
    await Promise.all(Array.from({ length: 5 }, () => insertOutbox()));
    const result = await runRelayCycle({ ...config, relayBatchSize: 2 }, new FakeGateway());
    expect(result.claimed).toBe(2);
  });

  it('reclaims and republishes a row whose claim expired (relay crashed after claiming)', async () => {
    const { id } = await insertOutbox();
    const claimed = await runInTransaction((tx) => claimBatch(tx, 10, 60_000));
    expect(claimed).toHaveLength(1); // the "crashed" relay holds the claim and never publishes

    const gateway = new FakeGateway();
    expect((await runRelayCycle(config, gateway)).claimed).toBe(0); // lease still valid

    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "leaseExpiresAt" = now() - interval '1 minute' WHERE id = ${id}::uuid`;
    expect((await runRelayCycle(config, gateway)).published).toBe(1);
    expect((await row(id)).status).toBe('PROCESSING');
  });

  it('a stale relay cannot overwrite a row that was reclaimed', async () => {
    const { id } = await insertOutbox();
    const [stale] = await runInTransaction((tx) => claimBatch(tx, 10, 60_000));
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "leaseExpiresAt" = now() - interval '1 minute' WHERE id = ${id}::uuid`;
    expect((await runRelayCycle(config, new FakeGateway())).published).toBe(1);

    expect(await markPublished(db(), id, stale.lease, 60_000)).toBe(false);
    expect((await row(id)).publishAttemptCount).toBe(1);
  });
});

describe('relay: publication failures', () => {
  it('keeps the row PENDING, counts attempts, backs off and never dead-letters (no maximum)', async () => {
    const { id } = await insertOutbox();
    const gateway = new FakeGateway();
    gateway.failWith = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      await db().$executeRaw`UPDATE "OutboxEvent" SET "availableAt" = now() WHERE id = ${id}::uuid`;
      const before = Date.now();
      const result = await runRelayCycle(config, gateway);
      expect(result).toMatchObject({ claimed: 1, retried: 1, deadLettered: 0 });

      const stored = await row(id);
      expect(stored.status).toBe('PENDING');
      expect(stored.publishAttemptCount).toBe(attempt);
      expect(stored.executionAttemptCount).toBe(0);
      expect(stored.leaseExpiresAt).toBeNull();
      expect(stored.errorClass).toBe('NETWORK');
      expect(stored.lastError).toBe('Error (ECONNREFUSED)');
      delays.push(Math.round((stored.availableAt.getTime() - before) / 1000));
    }
    // base 1s, cap 8s: 1, 2, 4, 8, 8, 8, 8, 8 (seconds, allowing rounding)
    expect(delays.map((d, i) => Math.abs(d - Math.min(8, 2 ** i)) <= 1)).toEqual(
      Array(8).fill(true),
    );
    expect(gateway.deadLetters).toHaveLength(0);
  });

  it('does not retry before the backoff has elapsed, then publishes when Redis returns', async () => {
    const { id } = await insertOutbox();
    const gateway = new FakeGateway();
    gateway.failWith = new Error('Redis down');
    await runRelayCycle(config, gateway);
    expect((await runRelayCycle(config, gateway)).claimed).toBe(0); // still backing off

    gateway.failWith = null;
    await db().$executeRaw`UPDATE "OutboxEvent" SET "availableAt" = now() WHERE id = ${id}::uuid`;
    expect((await runRelayCycle(config, gateway)).published).toBe(1);
    const stored = await row(id);
    expect(stored.status).toBe('PROCESSING');
    expect(stored.publishAttemptCount).toBe(2);
    expect(stored.errorClass).toBeNull();
  });

  it('treats a publish that hangs as a retryable failure', async () => {
    const { id } = await insertOutbox();
    const gateway = new FakeGateway();
    gateway.publishDelayMs = 400;
    const result = await runRelayCycle({ ...config, publishTimeoutMs: 50 }, gateway);
    expect(result.retried).toBe(1);
    expect(await row(id)).toMatchObject({ status: 'PENDING', errorClass: 'REDIS_UNAVAILABLE' });
  });

  it('dead-letters an unsupported event type and an invalid payload straight away', async () => {
    const unsupported = await insertOutbox();
    const invalid = await insertOutbox();
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "eventType" = 'RETIRED_EVENT' WHERE id = ${unsupported.id}::uuid`;
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "payload" = '{"incidentId":"x","secret":"s3cr3t"}'::jsonb WHERE id = ${invalid.id}::uuid`;

    const gateway = new FakeGateway();
    const result = await runRelayCycle(config, gateway);
    expect(result).toMatchObject({ claimed: 2, deadLettered: 2, published: 0 });
    expect(gateway.published).toHaveLength(0);

    const [u, i] = [await row(unsupported.id), await row(invalid.id)];
    expect(u).toMatchObject({
      status: 'DEAD_LETTER',
      errorClass: 'UNSUPPORTED_EVENT_TYPE',
      publishAttemptCount: 1,
    });
    expect(i).toMatchObject({ status: 'DEAD_LETTER', errorClass: 'INVALID_PAYLOAD' });
    expect(i.lastError).not.toContain('s3cr3t');
    expect(gateway.deadLetters.map((d) => d.outboxEventId).sort()).toEqual(
      [unsupported.id, invalid.id].sort(),
    );
    expect(gateway.deadLetters.find((d) => d.outboxEventId === invalid.id)).toEqual({
      outboxEventId: invalid.id,
      eventType: 'SLA_EVALUATION_REQUESTED',
      sourceQueue: 'sla-escalation',
      errorClass: 'INVALID_PAYLOAD',
    });
  });

  it('keeps the DEAD_LETTER record when the dead-letter job cannot be published', async () => {
    const { id } = await insertOutbox();
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "eventType" = 'RETIRED_EVENT' WHERE id = ${id}::uuid`;
    const gateway = new FakeGateway();
    gateway.publishDeadLetter = async () => {
      throw new Error('Redis down');
    };
    await runRelayCycle(config, gateway);
    expect((await row(id)).status).toBe('DEAD_LETTER');
  });
});

describe('stale PROCESSING recovery', () => {
  it('returns expired PROCESSING rows to PENDING and they are republished', async () => {
    const stale = await insertOutbox();
    const fresh = await insertOutbox();
    const gateway = new FakeGateway();
    await runRelayCycle(config, gateway);
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "leaseExpiresAt" = now() - interval '1 minute' WHERE id = ${stale.id}::uuid`;

    expect(await recoverStaleOutbox()).toBe(1);
    expect(await row(stale.id)).toMatchObject({ status: 'PENDING', leaseExpiresAt: null });
    expect((await row(fresh.id)).status).toBe('PROCESSING'); // deadline not reached

    const republish = new FakeGateway();
    expect((await runRelayCycle(config, republish)).published).toBe(1);
    expect(republish.published[0].data.outboxEventId).toBe(stale.id);
    expect((await row(stale.id)).publishAttemptCount).toBe(2);
  });

  it('ignores SUCCESS, DEAD_LETTER and PENDING rows', async () => {
    const [a, b, c] = await Promise.all([insertOutbox(), insertOutbox(), insertOutbox()]);
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "status" = 'SUCCESS', "leaseExpiresAt" = now() - interval '1 hour' WHERE id = ${a.id}::uuid`;
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "status" = 'DEAD_LETTER', "leaseExpiresAt" = now() - interval '1 hour' WHERE id = ${b.id}::uuid`;
    expect(await recoverStaleOutbox()).toBe(0);
    expect((await row(a.id)).status).toBe('SUCCESS');
    expect((await row(b.id)).status).toBe('DEAD_LETTER');
    expect((await row(c.id)).status).toBe('PENDING');
  });
});

describe('retention', () => {
  it('deletes SUCCESS rows past the window and never DEAD_LETTER rows', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => insertOutbox()));
    const [oldSuccess, freshSuccess, oldDead, oldPending, oldProcessing] = ids.map((x) => x.id);
    const old = `now() - interval '2 hours'`;
    await db().$executeRawUnsafe(
      `UPDATE "OutboxEvent" SET "status" = 'SUCCESS', "processedAt" = ${old} WHERE id = '${oldSuccess}'::uuid`,
    );
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "status" = 'SUCCESS', "processedAt" = now() WHERE id = ${freshSuccess}::uuid`;
    await db().$executeRawUnsafe(
      `UPDATE "OutboxEvent" SET "status" = 'DEAD_LETTER', "processedAt" = ${old} WHERE id = '${oldDead}'::uuid`,
    );
    await db().$executeRawUnsafe(
      `UPDATE "OutboxEvent" SET "createdAt" = ${old} WHERE id = '${oldPending}'::uuid`,
    );
    await db().$executeRawUnsafe(
      `UPDATE "OutboxEvent" SET "status" = 'PROCESSING', "processedAt" = ${old} WHERE id = '${oldProcessing}'::uuid`,
    );

    expect(await purgeFinishedOutbox(3_600_000)).toBe(1);
    const remaining = (await db().outboxEvent.findMany({ select: { id: true } })).map((r) => r.id);
    expect(remaining.sort()).toEqual([freshSuccess, oldDead, oldPending, oldProcessing].sort());
  });
});

describe('re-drive', () => {
  async function deadLetter(): Promise<string> {
    const { id } = await insertOutbox();
    await db().outboxEvent.update({
      where: { id },
      data: {
        status: 'DEAD_LETTER',
        errorClass: 'UNKNOWN_INTERNAL',
        lastError: 'Error',
        executionAttemptCount: 5,
        publishAttemptCount: 1,
        leaseExpiresAt: new Date(),
      },
    });
    return id;
  }

  it('requeues a DEAD_LETTER row: PENDING, available now, lease cleared, execution counter reset', async () => {
    const id = await deadLetter();
    await redriveOutboxEvent(id, 'operator-1');
    const stored = await row(id);
    expect(stored).toMatchObject({
      status: 'PENDING',
      leaseExpiresAt: null,
      executionAttemptCount: 0,
      publishAttemptCount: 1,
    });
    expect(stored.availableAt.getTime()).toBeLessThanOrEqual(Date.now());

    const gateway = new FakeGateway();
    expect((await runRelayCycle(config, gateway)).published).toBe(1);
    expect(gateway.published[0].data.outboxEventId).toBe(id);
  });

  it.each(['PENDING', 'PROCESSING', 'SUCCESS'] as const)('rejects a %s row', async (status) => {
    const { id } = await insertOutbox();
    await db().outboxEvent.update({ where: { id }, data: { status } });
    await expect(redriveOutboxEvent(id, 'op')).rejects.toMatchObject({ code: 'NOT_DEAD_LETTER' });
    expect((await row(id)).status).toBe(status);
  });

  it('rejects an unknown id, a malformed id, an unsupported event type and an invalid payload', async () => {
    await expect(redriveOutboxEvent(randomUUID(), 'op')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(redriveOutboxEvent('nope', 'op')).rejects.toBeInstanceOf(RedriveError);

    const unsupported = await deadLetter();
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "eventType" = 'RETIRED_EVENT' WHERE id = ${unsupported}::uuid`;
    await expect(redriveOutboxEvent(unsupported, 'op')).rejects.toMatchObject({
      code: 'UNSUPPORTED_EVENT_TYPE',
    });

    const invalid = await deadLetter();
    await db()
      .$executeRaw`UPDATE "OutboxEvent" SET "payload" = '{}'::jsonb WHERE id = ${invalid}::uuid`;
    await expect(redriveOutboxEvent(invalid, 'op')).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    expect((await row(invalid)).status).toBe('DEAD_LETTER');
  });
});
