import { randomUUID } from 'node:crypto';
import { getPrisma } from '../../src/infra/db/prisma';
import { createBullmqGateway } from '../../src/infra/jobs/gateway';
import { createJobWorker } from '../../src/infra/jobs/processor';
import {
  clearProcessors,
  registerDelayedProcessor,
  registerProcessor,
} from '../../src/infra/jobs/registry';
import { startJobsRuntime } from '../../src/infra/jobs/runtime';
import { createRedisConnection, getRedis } from '../../src/infra/redis/redis';
import { QUEUES } from '../../src/infra/jobs/events';
import { Queue, type Worker } from 'bullmq';
import { RetryableJobError } from '../../src/infra/jobs/errors';
import {
  createSlaEvaluationProcessor,
  createSlaMilestoneProcessor,
  runSlaScan,
} from '../../src/modules/incidents/sla-monitoring';
import * as evaluateModule from '../../src/modules/incidents/sla-monitoring/sla.evaluate';
import { createIncidentWith } from '../helpers/incidents';
import { createTeam, createUser, resetState } from '../helpers/identity';
import { insertOutbox, sleep, testJobsConfig, waitFor } from '../helpers/jobs';

const db = () => getPrisma();
const config = testJobsConfig();
const QUEUE = QUEUES.SLA_ESCALATION;

let connections: ReturnType<typeof createRedisConnection>[] = [];
let workers: Worker[] = [];
let queue: Queue;

const connect = (kind: 'general' | 'bullmq' = 'general') => {
  const connection = createRedisConnection(kind);
  connections.push(connection);
  return connection;
};

beforeEach(async () => {
  await resetState();
  clearProcessors();
  queue = new Queue(QUEUE, { connection: connect() });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
  await queue.close();
  connections.forEach((c) => c.disconnect());
  connections = [];
  clearProcessors();
});
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

async function service(responseMinutes: number) {
  const team = await createTeam();
  const eng = await createUser({ role: 'ENGINEER', teamId: team.id });
  const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
  const admin = await createUser({ role: 'ADMIN' });
  const policy = await db().escalationPolicy.create({
    data: { level1Id: eng.id, level2Id: eng.id, level3Id: lead.id, fallbackAdminId: admin.id },
  });
  const svc = await db().appService.create({
    data: {
      name: `svc-${randomUUID().slice(0, 8)}`,
      teamId: team.id,
      escalationPolicyId: policy.id,
      P0ResponseSlaMinutes: 5,
      P0ResolutionSlaMinutes: 30,
      P1ResponseSlaMinutes: responseMinutes,
      P1ResolutionSlaMinutes: 600,
      P2ResponseSlaMinutes: 30,
      P2ResolutionSlaMinutes: 120,
      P3ResponseSlaMinutes: 60,
      P3ResolutionSlaMinutes: 240,
    },
  });
  return { team, svc };
}

function startWorker(handler: Parameters<typeof registerDelayedProcessor>[1]): void {
  const gateway = createBullmqGateway(connect(), config.executionAttempts);
  const worker = createJobWorker(
    QUEUE,
    async () => undefined,
    { config, gateway },
    connect('bullmq'),
    handler,
  );
  workers.push(worker);
}

describe('delayed jobs on the real queue', () => {
  it('runs a scheduled job after its delay, once, and frees its id afterwards', async () => {
    const gateway = createBullmqGateway(connect(), config.executionAttempts);
    const seen: string[] = [];
    startWorker(async ({ data }) => void seen.push(data.incidentId));

    const started = Date.now();
    await gateway.scheduleDelayed(QUEUE, {
      jobId: 'sla-test-1',
      name: 'SLA_MILESTONE',
      data: { incidentId: 'a' },
      delayMs: 300,
    });
    expect(seen).toEqual([]);
    await waitFor(async () => seen.length === 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    await sleep(100);
    expect(await queue.getJob('sla-test-1')).toBeUndefined();
    await gateway.scheduleDelayed(QUEUE, {
      jobId: 'sla-test-1',
      name: 'SLA_MILESTONE',
      data: { incidentId: 'b' },
      delayMs: 10,
    });
    await waitFor(async () => seen.length === 2);
    expect(seen).toEqual(['a', 'b']);
  });

  it('scheduling the same id again replaces the waiting job (new delay, one run)', async () => {
    const gateway = createBullmqGateway(connect(), config.executionAttempts);
    const seen: string[] = [];
    startWorker(async ({ data }) => void seen.push(data.incidentId));

    await gateway.scheduleDelayed(QUEUE, {
      jobId: 'sla-test-2',
      name: 'SLA_MILESTONE',
      data: { incidentId: 'old' },
      delayMs: 60_000,
    });
    await gateway.scheduleDelayed(QUEUE, {
      jobId: 'sla-test-2',
      name: 'SLA_MILESTONE',
      data: { incidentId: 'new' },
      delayMs: 100,
    });

    await waitFor(async () => seen.length >= 1);
    await sleep(200);
    expect(seen).toEqual(['new']);
  });

  it('retries a retryable failure with the SLICE-08 attempts, then ends it with an error log and no stuck id', async () => {
    const gateway = createBullmqGateway(connect(), config.executionAttempts);
    let attempts = 0;
    startWorker(async () => {
      attempts += 1;
      throw new RetryableJobError('NETWORK', 'down');
    });

    await gateway.scheduleDelayed(QUEUE, {
      jobId: 'sla-test-3',
      name: 'SLA_MILESTONE',
      data: { incidentId: 'x' },
      delayMs: 0,
    });
    await waitFor(async () => attempts === config.executionAttempts, 15_000);
    await sleep(200);
    expect(attempts).toBe(config.executionAttempts);
    expect(await queue.getJob('sla-test-3')).toBeUndefined();
  });
});

describe('at-least-once: an exhausted delayed job is recovered by the scanner', () => {
  it('the milestone is recorded by the next scan once the failure is over', async () => {
    const { team, svc } = await service(10);
    const created = new Date(Date.now() - 11 * 60_000);
    const incident = await createIncidentWith({
      teamId: team.id,
      serviceId: svc.id,
      createdAt: created,
    });
    const gateway = createBullmqGateway(connect(), config.executionAttempts);

    // Every attempt of the job fails (a database problem, say).
    const real = evaluateModule.evaluateIncident;
    let failing = true;
    let calls = 0;
    jest.spyOn(evaluateModule, 'evaluateIncident').mockImplementation(async (id, deps) => {
      calls += 1;
      if (failing) throw new RetryableJobError('TRANSIENT_DATABASE', 'db down');
      return real(id, deps);
    });
    startWorker(createSlaMilestoneProcessor({ scheduler: gateway }));
    await gateway.scheduleDelayed(QUEUE, {
      jobId: `sla-${incident.id}-RESPONSE_BREACH`,
      name: 'SLA_MILESTONE',
      data: { incidentId: incident.id, milestone: 'RESPONSE_BREACH' },
      delayMs: 0,
    });
    await waitFor(async () => calls === config.executionAttempts, 15_000);
    await sleep(200);
    expect(await db().notification.count({ where: { incidentId: incident.id } })).toBe(0);

    // The job is gone for good, but the milestone is still a scan candidate until it is recorded.
    failing = false;
    const scan = await runSlaScan();
    expect(scan).toMatchObject({ candidates: 1, failed: 0 });
    expect(await db().notification.count({ where: { incidentId: incident.id } })).toBe(6);
    expect(await runSlaScan()).toMatchObject({ candidates: 0 });
  });
});

describe('end to end: outbox event → relay → worker → delayed BullMQ job', () => {
  it('SLA_EVALUATION_REQUESTED schedules the warning, which the delayed job then records at 80 %', async () => {
    const { team, svc } = await service(1); // 1-minute response window: warning after 48 s
    const incident = await createIncidentWith({
      teamId: team.id,
      serviceId: svc.id,
      createdAt: new Date(Date.now() - 47_000),
    });
    const gateway = createBullmqGateway(connect(), config.executionAttempts);
    registerProcessor(QUEUE, createSlaEvaluationProcessor({ scheduler: gateway }));
    registerDelayedProcessor(QUEUE, createSlaMilestoneProcessor({ scheduler: gateway }));
    const runtime = startJobsRuntime(config);

    try {
      const { id } = await insertOutbox({ incidentId: incident.id });
      await waitFor(async () => {
        const row = await db().outboxEvent.findUnique({ where: { id } });
        return row?.status === 'SUCCESS';
      });

      const delayed = await queue.getJob(`sla-${incident.id}-RESPONSE_WARNING`);
      expect(delayed?.opts.delay).toBeGreaterThan(0);

      const warning = await waitFor(
        async () =>
          db().auditEvent.findFirst({
            where: { incidentId: incident.id, eventType: 'SLA_WARNING' },
          }),
        10_000,
      );
      expect(warning?.metadata).toEqual({ kind: 'RESPONSE' });
      expect(await db().notification.count({ where: { incidentId: incident.id } })).toBe(1);
    } finally {
      await runtime.stop();
      await gateway.close();
    }
  });
});
