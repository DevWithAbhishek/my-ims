import { randomUUID } from 'node:crypto';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import { RetryableJobError } from '../../src/infra/jobs/errors';
import { enqueueOutbox } from '../../src/infra/jobs/outbox';
import { processOutboxJob } from '../../src/infra/jobs/processor';
import { runRelayCycle } from '../../src/infra/jobs/relay';
import { getRedis } from '../../src/infra/redis/redis';
import {
  AiProviderError,
  EvaluationError,
  createInvestigationProcessor,
  runEvaluation,
  runInvestigationRetention,
} from '../../src/modules/ai';
import type {
  AiGenerateRequest,
  AiGenerateResult,
  AiProvider,
} from '../../src/modules/ai/ai-provider';
import * as repository from '../../src/modules/ai/investigation/investigation.repository';
import * as enqueueModule from '../../src/modules/notifications/enqueue-notification';
import { createService, createTeam, createUser, resetState } from '../helpers/identity';
import { FakeGateway, testJobsConfig } from '../helpers/jobs';

const mockLogs: unknown[] = [];
jest.mock('../../src/shared/observability/logger', () => {
  const actual = jest.requireActual('../../src/shared/observability/logger');
  const levels = ['debug', 'info', 'warn', 'error', 'fatal'];
  const wrap = (target: Record<string, unknown>): unknown =>
    new Proxy(target, {
      get(obj, prop) {
        const value = obj[prop as string];
        if (prop === 'child') {
          return (...args: unknown[]) =>
            wrap((value as (...a: unknown[]) => Record<string, unknown>).apply(obj, args));
        }
        if (typeof prop === 'string' && levels.includes(prop)) {
          return (...args: unknown[]) => {
            mockLogs.push(args);
            return (value as (...a: unknown[]) => unknown).apply(obj, args);
          };
        }
        return typeof value === 'function' ? value.bind(obj) : value;
      },
    });
  return {
    ...actual,
    logger: wrap(actual.logger),
    childLogger: (context: unknown) => wrap(actual.childLogger(context)),
  };
});

const db = () => getPrisma();
const config = testJobsConfig();
const QUEUE = 'investigation';

beforeEach(async () => {
  mockLogs.length = 0;
  await resetState();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

// --- a provider that answers from what it is sent ----------------------------------------------

type Respond = (request: AiGenerateRequest) => string | Error;
type Record_ = { id: string } & Record<string, string | null>;

const recordsOf = (request: AiGenerateRequest): Record_[] =>
  (request.input.evidence as string[]).map((entry) => JSON.parse(entry) as Record_);

/** FACT for the incident, INFERENCE for the first postmortem, a finding on the incident. */
function validOutputFor(request: AiGenerateRequest): string {
  const records = recordsOf(request);
  return JSON.stringify({
    evidence: records.map((record, index) => ({
      id: record.id,
      evidenceType: index === 0 ? 'FACT' : 'INFERENCE',
      sourceType: 'severity' in record ? 'INCIDENT' : 'POSTMORTEM',
      relevance: `record ${index}`,
    })),
    brief: {
      summary: 'A short brief.',
      findings: [{ text: 'The incident is real.', evidenceIds: [records[0].id] }],
      possibleAreas: records
        .slice(1, 2)
        .map((record) => ({ text: 'A past cause', evidenceIds: [record.id] })),
      suggestedSteps: [{ text: 'Check the dashboards' }],
      limitations: null,
    },
  });
}

class ScriptedProvider implements AiProvider {
  calls: AiGenerateRequest[] = [];
  respond: Respond = validOutputFor;
  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls.push(request);
    const answer = this.respond(request);
    if (answer instanceof Error) throw answer;
    return { text: answer, model: 'fake-model', modelVersion: 'fake-model-1' };
  }
}

// --- the world ------------------------------------------------------------------------------------

const INCIDENT_MARKER = 'INCIDENT-DESCRIPTION-MARKER';
const TITLE_MARKER = 'TITLE-MARKER-DO-NOT-SEND';

async function world() {
  const team = await createTeam();
  const fallbackAdmin = await createUser({ role: 'ADMIN', name: 'Fallback' });
  const requester = await createUser({ role: 'ENGINEER', teamId: team.id });
  const service = await createService(team.id, fallbackAdmin.id);
  const incident = await db().incident.create({
    data: {
      title: TITLE_MARKER,
      description: INCIDENT_MARKER,
      severity: 'P1',
      status: 'OPEN',
      teamId: team.id,
      affectedServiceId: service.id,
    },
  });
  return { team, fallbackAdmin, requester, service, incident };
}
type World = Awaited<ReturnType<typeof world>>;

async function reviewedPostmortem(
  w: World,
  n: number,
  overrides: {
    reviewStatus?: 'PENDING' | 'REVIEWED' | 'REJECTED';
    reviewedAt?: Date | null;
    serviceId?: string;
    teamId?: string;
    incidentId?: string;
  } = {},
) {
  const incident = overrides.incidentId
    ? { id: overrides.incidentId }
    : await db().incident.create({
        data: {
          title: `past ${n}`,
          description: `past description ${n}`,
          severity: 'P2',
          status: 'CLOSED',
          teamId: overrides.teamId ?? w.team.id,
          affectedServiceId: overrides.serviceId ?? w.service.id,
        },
      });
  return db().postmortem.create({
    data: {
      incidentId: incident.id,
      summary: `PM-${n}`,
      impact: `impact ${n}`,
      rootCause: `cause ${n}`,
      factors: `factors ${n}`,
      resolution: `resolution ${n}`,
      detection: 'DETECTION-MARKER-DO-NOT-SEND',
      timeline: 'TIMELINE-MARKER-DO-NOT-SEND',
      prompt: 'PROMPT-MARKER-DO-NOT-SEND',
      inputData: 'INPUT-MARKER-DO-NOT-SEND',
      generationStatus: 'DRAFT',
      reviewStatus: overrides.reviewStatus ?? 'REVIEWED',
      reviewedAt:
        overrides.reviewedAt === undefined
          ? new Date(Date.UTC(2026, 8, 1, 0, n))
          : overrides.reviewedAt,
    },
  });
}

async function requestInvestigation(w: World, input: object = { postmortemLimit: 20 }) {
  return runInTransaction(async (tx) => {
    const row = await tx.investigation.create({
      data: {
        idempotencyKey: `worker-${randomUUID()}`,
        requestedById: w.requester.id,
        incidentId: w.incident.id,
        input,
      },
    });
    const outboxId = await enqueueOutbox(tx, {
      eventType: 'INVESTIGATION_REQUESTED',
      aggregateType: 'INVESTIGATION',
      aggregateId: row.id,
      payload: { investigationId: row.id, incidentId: w.incident.id, requestId: 'req-inv' },
    });
    return { id: row.id, outboxId };
  });
}

function harness(provider = new ScriptedProvider()) {
  const gateway = new FakeGateway();
  const processor = createInvestigationProcessor({
    provider,
    maxAttempts: config.executionAttempts,
  });
  const run = async (outboxId: string, attemptsMade = 0) => {
    await runRelayCycle(config, gateway);
    const stored = await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } });
    await processOutboxJob(
      {
        data: {
          outboxEventId: outboxId,
          eventType: stored.eventType,
          aggregateType: stored.aggregateType,
          aggregateId: stored.aggregateId,
          payload: stored.payload,
        },
        attemptsMade,
        opts: { attempts: config.executionAttempts },
      },
      QUEUE,
      processor,
      { config, gateway },
    );
  };
  const runAllAttempts = async (outboxId: string) => {
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < config.executionAttempts; attempt += 1) {
      try {
        await run(outboxId, attempt);
        break;
      } catch (error) {
        errors.push(error);
        if (error instanceof Error && error.name === 'UnrecoverableError') break;
      }
    }
    return errors;
  };
  return { provider, gateway, run, runAllAttempts };
}

const investigationOf = (id: string) => db().investigation.findUniqueOrThrow({ where: { id } });
const auditOf = () =>
  db().auditEvent.findMany({ where: { eventType: 'AI_INVESTIGATION_COMPLETED' } });
const notificationsOf = () =>
  db().notification.findMany({ where: { eventType: 'AI_INVESTIGATION_COMPLETED' } });

describe('success (SLICE-12 §4.3 step 6)', () => {
  it('persists brief, evidence, audit event and INFO notification, and never touches the incident', async () => {
    const w = await world();
    await reviewedPostmortem(w, 1);
    const before = await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } });
    const { id, outboxId } = await requestInvestigation(w);
    const { provider, run } = harness();

    await run(outboxId);

    expect(provider.calls).toHaveLength(1);
    const row = await investigationOf(id);
    expect(row).toMatchObject({
      status: 'COMPLETED',
      model: 'fake-model',
      modelVersion: 'fake-model-1',
      failureReason: null,
    });
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.result).toMatchObject({ summary: 'A short brief.', limitations: null });

    const evidence = await db().evidence.findMany({ where: { investigationId: id } });
    expect(evidence).toHaveLength(2);
    expect(evidence.every((e) => e.incidentId !== null)).toBe(true);
    const incidentEvidence = evidence.find((e) => e.sourceType === 'INCIDENT')!;
    expect(incidentEvidence).toMatchObject({
      sourceReference: w.incident.id,
      incidentId: w.incident.id,
      evidenceType: 'FACT',
      relevanceInfo: 'record 0',
    });
    const brief = row.result as { findings: { evidenceIds: string[] }[] };
    expect(brief.findings[0].evidenceIds).toEqual([incidentEvidence.id]);

    const audit = await auditOf();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      incidentId: w.incident.id,
      actor: null,
      metadata: { investigationId: id },
    });
    const notifications = await notificationsOf();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ notificationType: 'INFO', incidentId: w.incident.id });
    expect(notifications[0].recipients).toContain(w.requester.id);
    expect(notifications[0].idempotencyKey).toBe(
      `AI_INVESTIGATION_COMPLETED:${w.incident.id}:${audit[0].id}`,
    );

    expect(await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } })).toEqual(before);
    expect(await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({
      status: 'SUCCESS',
    });
  });

  it('is a no-op for a duplicate job and for a terminal investigation', async () => {
    const w = await world();
    const { id, outboxId } = await requestInvestigation(w);
    const { provider, run } = harness();
    await run(outboxId);
    await run(outboxId);
    expect(provider.calls).toHaveLength(1);
    expect(await auditOf()).toHaveLength(1);
    expect(await db().evidence.count({ where: { investigationId: id } })).toBe(1);

    const failedWorld = await world();
    const failed = await requestInvestigation(failedWorld);
    await db().investigation.update({
      where: { id: failed.id },
      data: { status: 'FAILED', failureReason: 'AI_UNAVAILABLE' },
    });
    await run(failed.outboxId);
    expect(provider.calls).toHaveLength(1);
    expect((await investigationOf(failed.id)).status).toBe('FAILED');
  });

  it('takes over a RUNNING investigation left by a crashed attempt', async () => {
    const w = await world();
    const { id, outboxId } = await requestInvestigation(w);
    await db().investigation.update({ where: { id }, data: { status: 'RUNNING' } });
    await harness().run(outboxId);
    expect((await investigationOf(id)).status).toBe('COMPLETED');
  });

  it('commits nothing when the notification write fails (atomic), then succeeds on the retry', async () => {
    const w = await world();
    const { id, outboxId } = await requestInvestigation(w);
    const { run } = harness();
    jest
      .spyOn(enqueueModule, 'enqueueNotification')
      .mockRejectedValueOnce(new RetryableJobError('TRANSIENT_DATABASE', 'x'));

    await expect(run(outboxId, 0)).rejects.toBeDefined();
    expect((await investigationOf(id)).status).toBe('REQUESTED');
    expect(await db().evidence.count()).toBe(0);
    expect(await auditOf()).toHaveLength(0);

    await run(outboxId, 1);
    expect((await investigationOf(id)).status).toBe('COMPLETED');
    expect(await auditOf()).toHaveLength(1);
  });
});

describe('retrieval and the data allow-list (§4.3 steps 2–3)', () => {
  it('retrieves only reviewed postmortems of the same service, most recent first, last 20, excluding the incident', async () => {
    const w = await world();
    for (let n = 1; n <= 25; n += 1) await reviewedPostmortem(w, n);
    await reviewedPostmortem(w, 100, { reviewStatus: 'PENDING' });
    await reviewedPostmortem(w, 101, { reviewStatus: 'REJECTED' });
    const otherService = await createService(w.team.id, w.fallbackAdmin.id);
    await reviewedPostmortem(w, 102, { serviceId: otherService.id });
    const otherTeam = await createTeam();
    const foreignService = await createService(otherTeam.id, w.fallbackAdmin.id);
    await reviewedPostmortem(w, 103, { serviceId: foreignService.id, teamId: otherTeam.id });
    await reviewedPostmortem(w, 104, { incidentId: w.incident.id });

    const { id, outboxId } = await requestInvestigation(w);
    const { provider, run } = harness();
    await run(outboxId);

    const records = recordsOf(provider.calls[0]);
    expect(records).toHaveLength(21); // the incident + 20
    expect(records[0].description).toBe(INCIDENT_MARKER);
    expect(records.slice(1).map((r) => r.summary)).toEqual(
      Array.from({ length: 20 }, (_, i) => `PM-${25 - i}`),
    );
    expect((await investigationOf(id)).status).toBe('COMPLETED');
  });

  it('uses the limit stored with the request', async () => {
    const w = await world();
    for (let n = 1; n <= 5; n += 1) await reviewedPostmortem(w, n);
    const { outboxId } = await requestInvestigation(w, { postmortemLimit: 2 });
    const { provider, run } = harness();
    await run(outboxId);
    expect(
      recordsOf(provider.calls[0])
        .slice(1)
        .map((r) => r.summary),
    ).toEqual(['PM-5', 'PM-4']);
  });

  it('sends the provider only the allow-listed fields plus the generated ids', async () => {
    const w = await world();
    await reviewedPostmortem(w, 1);
    const { outboxId } = await requestInvestigation(w);
    const { provider, run } = harness();
    await run(outboxId);

    const [request] = provider.calls;
    expect(Object.keys(request.input)).toEqual(['evidence']);
    const [incident, postmortem] = recordsOf(request);
    expect(Object.keys(incident).sort()).toEqual(['description', 'id', 'severity']);
    expect(Object.keys(postmortem).sort()).toEqual(
      ['factors', 'id', 'impact', 'incidentId', 'resolution', 'rootCause', 'summary'].sort(),
    );
    const sent = JSON.stringify(request);
    for (const marker of [
      TITLE_MARKER,
      'DETECTION-MARKER',
      'TIMELINE-MARKER',
      'PROMPT-MARKER',
      'INPUT-MARKER',
      w.incident.id,
      w.team.id,
      w.requester.id,
    ]) {
      expect(sent).not.toContain(marker);
    }
  });

  it('puts the generated candidate ids on the stored evidence rows', async () => {
    const w = await world();
    await reviewedPostmortem(w, 1);
    const { id, outboxId } = await requestInvestigation(w);
    const { provider, run } = harness();
    await run(outboxId);
    const sentIds = recordsOf(provider.calls[0])
      .map((r) => r.id)
      .sort();
    const stored = (await db().evidence.findMany({ where: { investigationId: id } }))
      .map((e) => e.id)
      .sort();
    expect(stored).toEqual(sentIds);
    const pm = await db().evidence.findFirstOrThrow({
      where: { investigationId: id, sourceType: 'POSTMORTEM' },
    });
    expect(pm.sourceReference).toBe(pm.incidentId);
    expect(pm.incidentId).not.toBe(w.incident.id);
  });

  it('fails with RETRIEVAL_FAILED after bounded retries and never calls the provider', async () => {
    const w = await world();
    const { id, outboxId } = await requestInvestigation(w);
    jest.spyOn(repository, 'findReviewedPostmortems').mockRejectedValue(new Error('db'));
    const { provider, runAllAttempts } = harness();

    const errors = await runAllAttempts(outboxId);

    expect(errors.length).toBe(config.executionAttempts);
    expect(provider.calls).toHaveLength(0);
    expect(await investigationOf(id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'RETRIEVAL_FAILED',
    });
    expect(await auditOf()).toHaveLength(0);
    expect(await notificationsOf()).toHaveLength(0);
  });
});

describe('failures (§4.3 steps 5 and 7)', () => {
  it('retries a provider failure, shows REQUESTED between attempts, then FAILED with AI_UNAVAILABLE', async () => {
    const w = await world();
    const before = await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } });
    const { id, outboxId } = await requestInvestigation(w);
    const provider = new ScriptedProvider();
    provider.respond = () => new AiProviderError('UNAVAILABLE', 503);
    const { run, runAllAttempts } = harness(provider);

    await expect(run(outboxId, 0)).rejects.toBeDefined();
    expect((await investigationOf(id)).status).toBe('REQUESTED');

    const errors = await runAllAttempts(outboxId);
    expect(errors.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(1 + config.executionAttempts);
    expect(await investigationOf(id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'AI_UNAVAILABLE',
      result: null,
      completedAt: null,
    });
    expect(await db().evidence.count()).toBe(0);
    expect(await auditOf()).toHaveLength(0);
    expect(await notificationsOf()).toHaveLength(0);
    expect(await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } })).toEqual(before);
  });

  it('ends a configuration error at once with AI_UNAVAILABLE', async () => {
    const w = await world();
    const { id, outboxId } = await requestInvestigation(w);
    const provider = new ScriptedProvider();
    provider.respond = () => new AiProviderError('CONFIGURATION', 401);
    await harness(provider).runAllAttempts(outboxId);
    expect(provider.calls).toHaveLength(1);
    expect(await investigationOf(id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'AI_UNAVAILABLE',
    });
  });

  const invalidOutputs: [string, (request: AiGenerateRequest) => string][] = [
    ['text that is not JSON', () => 'sorry, I cannot'],
    [
      'an unknown evidence id',
      (request) => {
        const out = JSON.parse(validOutputFor(request));
        out.evidence[0].id = randomUUID();
        return JSON.stringify(out);
      },
    ],
    [
      'a missing origin type',
      (request) => {
        const out = JSON.parse(validOutputFor(request));
        delete out.evidence[0].sourceType;
        return JSON.stringify(out);
      },
    ],
    [
      'a finding without a FACT',
      (request) => {
        const out = JSON.parse(validOutputFor(request));
        out.evidence[0].evidenceType = 'INFERENCE';
        return JSON.stringify(out);
      },
    ],
    [
      'no evidence at all',
      (request) => {
        const out = JSON.parse(validOutputFor(request));
        out.evidence = [];
        return JSON.stringify(out);
      },
    ],
  ];
  it.each(invalidOutputs)(
    'fails with OUTPUT_INVALID for %s and stores nothing',
    async (_name, respond) => {
      const w = await world();
      const { id, outboxId } = await requestInvestigation(w);
      const provider = new ScriptedProvider();
      provider.respond = respond;
      await harness(provider).runAllAttempts(outboxId);

      expect(provider.calls).toHaveLength(config.executionAttempts);
      expect(await investigationOf(id)).toMatchObject({
        status: 'FAILED',
        failureReason: 'OUTPUT_INVALID',
        result: null,
      });
      expect(await db().evidence.count()).toBe(0);
      expect(await auditOf()).toHaveLength(0);
      expect(await notificationsOf()).toHaveLength(0);
    },
  );

  it('recovers when a later attempt answers validly', async () => {
    const w = await world();
    const { id, outboxId } = await requestInvestigation(w);
    const provider = new ScriptedProvider();
    let calls = 0;
    provider.respond = (request) => (++calls < 3 ? 'garbage' : validOutputFor(request));
    await harness(provider).runAllAttempts(outboxId);
    expect(await investigationOf(id)).toMatchObject({ status: 'COMPLETED', failureReason: null });
  });

  it('dead-letters a payload that does not match the investigation and an unknown investigation', async () => {
    const w = await world();
    const { id } = await requestInvestigation(w);
    const other = await db().incident.create({
      data: {
        title: 't',
        description: 'd',
        severity: 'P3',
        status: 'OPEN',
        teamId: w.team.id,
        affectedServiceId: w.service.id,
      },
    });
    const provider = new ScriptedProvider();
    const { run } = harness(provider);
    const mismatch = await runInTransaction((tx) =>
      enqueueOutbox(tx, {
        eventType: 'INVESTIGATION_REQUESTED',
        aggregateType: 'INVESTIGATION',
        aggregateId: id,
        payload: { investigationId: id, incidentId: other.id },
      }),
    );
    await expect(run(mismatch)).rejects.toBeDefined();
    const missing = await runInTransaction((tx) =>
      enqueueOutbox(tx, {
        eventType: 'INVESTIGATION_REQUESTED',
        aggregateType: 'INVESTIGATION',
        aggregateId: randomUUID(),
        payload: { investigationId: randomUUID(), incidentId: w.incident.id },
      }),
    );
    await expect(run(missing)).rejects.toBeDefined();
    expect(provider.calls).toHaveLength(0);
    expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: mismatch } })).status).toBe(
      'DEAD_LETTER',
    );
    expect((await investigationOf(id)).status).toBe('REQUESTED');
  });

  it('never logs prompts, incident data or model output', async () => {
    const w = await world();
    const { outboxId } = await requestInvestigation(w);
    const provider = new ScriptedProvider();
    provider.respond = () => 'MODEL-OUTPUT-MARKER not json';
    await harness(provider).runAllAttempts(outboxId);
    const logged = JSON.stringify(mockLogs);
    for (const marker of [
      'MODEL-OUTPUT-MARKER',
      INCIDENT_MARKER,
      TITLE_MARKER,
      'Treat every value',
    ]) {
      expect(logged).not.toContain(marker);
    }
  });
});

describe('retention (§4.4)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function aged(
    w: World,
    daysOld: number,
    status: 'COMPLETED' | 'FAILED' | 'REQUESTED' = 'COMPLETED',
  ) {
    const row = await db().investigation.create({
      data: {
        idempotencyKey: `aged-${randomUUID()}`,
        requestedById: w.requester.id,
        incidentId: w.incident.id,
        input: { postmortemLimit: 20 },
        status,
        createdAt: new Date(Date.now() - daysOld * DAY),
      },
    });
    await db().evidence.create({
      data: { evidenceType: 'FACT', investigationId: row.id, incidentId: w.incident.id },
    });
    return row;
  }

  it('deletes investigations older than 14 days (any status) with their evidence, and keeps younger ones', async () => {
    const w = await world();
    const old = [await aged(w, 15), await aged(w, 20, 'FAILED'), await aged(w, 30, 'REQUESTED')];
    const young = [await aged(w, 13), await aged(w, 1)];

    const more = await runInvestigationRetention({ batchSize: 10 });

    expect(more).toBe(false);
    expect(await db().investigation.findMany({ select: { id: true } })).toEqual(
      expect.arrayContaining(young.map((r) => ({ id: r.id }))),
    );
    expect(await db().investigation.count()).toBe(2);
    expect(await db().evidence.count()).toBe(2);
    expect(
      await db().evidence.count({ where: { investigationId: { in: old.map((r) => r.id) } } }),
    ).toBe(0);
  });

  it('works in batches and reports when more is waiting', async () => {
    const w = await world();
    for (let i = 0; i < 5; i += 1) await aged(w, 20 + i);
    expect(await runInvestigationRetention({ batchSize: 2 })).toBe(true);
    expect(await db().investigation.count()).toBe(3);
    expect(await runInvestigationRetention({ batchSize: 2 })).toBe(true);
    expect(await runInvestigationRetention({ batchSize: 2 })).toBe(false);
    expect(await db().investigation.count()).toBe(0);
    expect(await db().evidence.count()).toBe(0);
  });

  it('deletes atomically: a failing batch leaves investigation and evidence alike', async () => {
    const w = await world();
    const row = await aged(w, 20);
    jest.spyOn(repository, 'deleteExpiredInvestigations').mockImplementationOnce(async (tx) => {
      await tx.evidence.deleteMany({});
      throw new Error('boom');
    });
    await expect(runInvestigationRetention({ batchSize: 10 })).rejects.toThrow('boom');
    expect(await db().investigation.count({ where: { id: row.id } })).toBe(1);
    expect(await db().evidence.count()).toBe(1);
  });

  it('frees the idempotency key and hides the investigation afterwards', async () => {
    const w = await world();
    const row = await aged(w, 20);
    await runInvestigationRetention({ batchSize: 10 });
    expect(await db().investigation.findUnique({ where: { id: row.id } })).toBeNull();
    await expect(
      db().investigation.create({
        data: {
          idempotencyKey: row.idempotencyKey,
          requestedById: w.requester.id,
          incidentId: w.incident.id,
          input: {},
        },
      }),
    ).resolves.toBeDefined();
  });
});

describe('evaluation CLI service (§4.6)', () => {
  async function withEvidence(w: World) {
    const investigation = await db().investigation.create({
      data: {
        idempotencyKey: `eval-${randomUUID()}`,
        requestedById: w.requester.id,
        incidentId: w.incident.id,
        input: {},
        status: 'COMPLETED',
      },
    });
    const evidence = [];
    for (const [i, type] of (['FACT', 'INFERENCE', 'UNKNOWN'] as const).entries()) {
      evidence.push(
        await db().evidence.create({
          data: {
            evidenceType: type,
            relevanceInfo: `relevance ${i}`,
            sourceType: 'INCIDENT',
            sourceReference: 'SOURCE-REF-MARKER-DO-NOT-SEND',
            investigationId: investigation.id,
            incidentId: w.incident.id,
          },
        }),
      );
    }
    return evidence;
  }

  const output = (ids: string[]) =>
    JSON.stringify({
      patterns: [
        { text: 'Pool exhaustion recurs', label: 'INFERENCE', evidenceIds: ids.slice(0, 2) },
      ],
      limitations: null,
    });

  it('stores one Evaluation row with the specified fields and sends only id, relevanceInfo and evidenceType', async () => {
    const w = await world();
    const evidence = await withEvidence(w);
    // Evidence of another service must not be included.
    const otherWorld = await world();
    await withEvidence(otherWorld);
    const provider = new ScriptedProvider();
    provider.respond = (request) => output(recordsOf(request).map((r) => r.id));

    const result = await runEvaluation(w.service.id, { provider });

    expect(result.patternCount).toBe(1);
    const [row] = await db().evaluation.findMany();
    expect(row.id).toBe(result.evaluationId);
    const input = JSON.parse(row.input);
    expect(input.serviceId).toBe(w.service.id);
    expect(input.evidence).toEqual(
      evidence.map((e, i) => ({
        id: e.id,
        relevanceInfo: `relevance ${i}`,
        evidenceType: e.evidenceType,
      })),
    );
    expect(JSON.parse(row.evidence)).toEqual(evidence.map((e) => e.id));
    expect(JSON.parse(row.constraints).length).toBeGreaterThan(0);
    expect(row.result).toMatchObject({ patterns: [{ label: 'INFERENCE' }], limitations: null });

    expect(provider.calls).toHaveLength(1);
    expect(Object.keys(provider.calls[0].input)).toEqual(['evidence']);
    const sent = recordsOf(provider.calls[0]);
    expect(sent).toHaveLength(3);
    for (const record of sent) {
      expect(Object.keys(record).sort()).toEqual(['evidenceType', 'id', 'relevanceInfo']);
    }
    const text = JSON.stringify(provider.calls[0]);
    expect(text).not.toContain('SOURCE-REF-MARKER');
    expect(text).not.toContain(w.service.id);
  });

  it('rejects unsupported output and stores nothing', async () => {
    const w = await world();
    await withEvidence(w);
    const provider = new ScriptedProvider();
    provider.respond = () => output([randomUUID()]);
    await expect(runEvaluation(w.service.id, { provider })).rejects.toMatchObject({
      kind: 'OUTPUT_REJECTED',
    });
    provider.respond = () => 'not json';
    await expect(runEvaluation(w.service.id, { provider })).rejects.toBeInstanceOf(EvaluationError);
    expect(await db().evaluation.count()).toBe(0);
  });

  it('stores nothing for an invalid or unknown service or a service without evidence', async () => {
    const w = await world();
    const provider = new ScriptedProvider();
    await expect(runEvaluation('nope', { provider })).rejects.toMatchObject({
      kind: 'INVALID_SERVICE_ID',
    });
    await expect(runEvaluation(randomUUID(), { provider })).rejects.toMatchObject({
      kind: 'SERVICE_NOT_FOUND',
    });
    await expect(runEvaluation(w.service.id, { provider })).rejects.toMatchObject({
      kind: 'NO_EVIDENCE',
    });
    expect(provider.calls).toHaveLength(0);
    expect(await db().evaluation.count()).toBe(0);
  });
});
