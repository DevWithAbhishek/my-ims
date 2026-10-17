import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as auditModule from '../../src/infra/audit/append-audit-event';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import { RetryableJobError } from '../../src/infra/jobs/errors';
import { enqueueOutbox } from '../../src/infra/jobs/outbox';
import { processOutboxJob } from '../../src/infra/jobs/processor';
import { runRelayCycle } from '../../src/infra/jobs/relay';
import { getRedis } from '../../src/infra/redis/redis';
import { AiProviderError } from '../../src/modules/ai/ai-provider';
import { FakeAiProvider } from '../../src/modules/ai/fake-ai-provider';
import { TRIAGE_ALLOWED_FIELDS } from '../../src/modules/ai/triage.allowlist';
import { TRIAGE_INSTRUCTIONS } from '../../src/modules/ai/triage.prompt';
import { createAlertTriageProcessor } from '../../src/modules/ai/triage.processor';
import * as enqueueModule from '../../src/modules/notifications/enqueue-notification';
import { buildTestApp } from '../helpers/app';
import {
  createAlertSource as createSigningSource,
  nowSeconds,
  postWebhook,
} from '../helpers/alert-source';
import { createAlertSource } from '../helpers/incidents';
import {
  bearer,
  createService,
  createTeam,
  createUser,
  login,
  resetState,
} from '../helpers/identity';
import { FakeGateway, testJobsConfig } from '../helpers/jobs';

// Everything the code under test logs is captured, to prove no prompt, alert text or model output
// reaches a log.
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

const app = buildTestApp();
const db = () => getPrisma();
const config = testJobsConfig();
const QUEUE = 'ai-triage';

beforeEach(async () => {
  mockLogs.length = 0;
  await resetState();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

const ALERT_SUMMARY = 'CPU above 90% on web-1';
const ALERT_DESCRIPTION = 'Sustained for ten minutes';
const ALERT_LABELS = ['host=web-1', 'team=checkout'];
const ALERT_DETAILS = 'runbook: restart the pool';
const PAYLOAD_MARKER = 'PAYLOAD-MARKER-DO-NOT-SEND';
const ALERT_NAME = 'NAME-MARKER-DO-NOT-SEND';

const VALID_OUTPUT = {
  category: 'Resource saturation',
  suggestedSeverity: 'P1',
  confidence: 0.82,
  evidence: [{ type: 'LABEL', reference: 'labels', excerpt: 'host=web-1' }],
  summary: 'CPU saturation on one web host.',
  reasoning: 'Sustained CPU above 90% on a checkout host.',
};
const validText = (overrides: object = {}) => JSON.stringify({ ...VALID_OUTPUT, ...overrides });

async function buildWorld(incidentStatus: 'OPEN' | 'RESOLVED' | 'CLOSED' = 'OPEN') {
  const team = await createTeam();
  const fallbackAdmin = await createUser({ role: 'ADMIN', name: 'Fallback' });
  const level3 = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
  const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
  const engineer = await createUser({ role: 'ENGINEER', teamId: team.id });
  const policy = await db().escalationPolicy.create({
    data: {
      level1Id: lead.id,
      level2Id: lead.id,
      level3Id: level3.id,
      fallbackAdminId: fallbackAdmin.id,
    },
  });
  const service = await db().appService.create({
    data: {
      name: `svc-${randomUUID().slice(0, 8)}`,
      teamId: team.id,
      escalationPolicyId: policy.id,
      P0ResponseSlaMinutes: 5,
      P0ResolutionSlaMinutes: 30,
      P1ResponseSlaMinutes: 10,
      P1ResolutionSlaMinutes: 60,
      P2ResponseSlaMinutes: 30,
      P2ResolutionSlaMinutes: 120,
      P3ResponseSlaMinutes: 60,
      P3ResolutionSlaMinutes: 240,
    },
  });
  const incident = await db().incident.create({
    data: {
      title: 'Checkout is slow',
      description: 'description',
      severity: 'P2',
      status: incidentStatus,
      teamId: team.id,
      affectedServiceId: service.id,
      ...(incidentStatus === 'OPEN' ? {} : { resolvedById: engineer.id }),
    },
  });
  const source = await createAlertSource('Datadog');
  const alert = await db().alert.create({
    data: {
      name: ALERT_NAME,
      environment: 'production',
      startedTimestamp: new Date('2026-10-14T10:00:00.000Z'),
      originalPayload: { marker: PAYLOAD_MARKER },
      sourceUrl: 'https://monitoring.example/alerts/1',
      summary: ALERT_SUMMARY,
      description: ALERT_DESCRIPTION,
      labels: ALERT_LABELS,
      additionalDetails: ALERT_DETAILS,
      alertSourceId: source.id,
      affectedServiceId: service.id,
      incidentId: incident.id,
    },
  });
  const login_ = await login(app, engineer.email);
  return {
    team,
    fallbackAdmin,
    level3,
    lead,
    engineer,
    service,
    incident,
    alert,
    token: bearer(login_.token),
  };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

/** A committed `ALERT_TRIAGE_REQUESTED` outbox row, as ingestion writes it. */
async function requestTriage(w: World, overrides: Record<string, unknown> = {}) {
  return runInTransaction((tx) =>
    enqueueOutbox(tx, {
      eventType: 'ALERT_TRIAGE_REQUESTED',
      aggregateType: 'Alert',
      aggregateId: w.alert.id,
      payload: {
        alertId: w.alert.id,
        incidentId: w.incident.id,
        requestId: 'req-triage',
        ...overrides,
      },
    }),
  );
}

function harness(provider = new FakeAiProvider()) {
  provider.defaultText = validText();
  const gateway = new FakeGateway();
  const processor = createAlertTriageProcessor({ provider, maxAttempts: config.executionAttempts });
  /** Publishes pending outbox rows as the relay would, then runs one attempt through SLICE-08. */
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
  /** Every attempt of the job, as the queue would make them; returns the errors thrown. */
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

const triageRow = (alertId: string) => db().aITriage.findUnique({ where: { alertId } });
const auditOf = (incidentId: string) =>
  db().auditEvent.findMany({ where: { incidentId, eventType: 'AI_TRIAGE_COMPLETED' } });
const notifications = () =>
  db().notification.findMany({ where: { eventType: 'AI_TRIAGE_COMPLETED' } });
const incidentSnapshot = (id: string) => db().incident.findUniqueOrThrow({ where: { id } });
const aiTriageOf = async (w: World) =>
  (await request(app).get(`/api/v1/incidents/${w.incident.id}`).set(w.token)).body.data.aiTriage;

describe('success (SLICE-10 §4.5)', () => {
  it('stores the validated suggestion, the audit event and one INFO notification in one commit', async () => {
    const w = await buildWorld();
    const before = await incidentSnapshot(w.incident.id);
    const outboxId = await requestTriage(w);
    const { provider, run } = harness();

    await run(outboxId);

    expect(provider.calls).toHaveLength(1);
    const row = await triageRow(w.alert.id);
    expect(row).toMatchObject({
      failureStatus: 'SUCCESS',
      suggestedSeverity: 'P1',
      category: 'Resource saturation',
      summary: 'CPU saturation on one web host.',
      reasoning: 'Sustained CPU above 90% on a checkout host.',
      confidence: 0.82,
      evidence: VALID_OUTPUT.evidence,
      rawOutput: VALID_OUTPUT,
      model: 'fake-model',
      modelVersion: 'fake-model-1',
    });
    expect(await db().aITriage.count()).toBe(1);

    const audit = await auditOf(w.incident.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: null, incidentId: w.incident.id });
    expect(audit[0]!.metadata).toEqual({ createdAt: row!.createdAt.toISOString() });

    const sent = await notifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      notificationType: 'INFO',
      incidentId: w.incident.id,
      idempotencyKey: `AI_TRIAGE_COMPLETED:${w.incident.id}:${audit[0]!.id}`,
    });
    expect([...(sent[0]!.recipients as string[])].sort()).toEqual(
      [w.level3.id, w.fallbackAdmin.id].sort(),
    );
    expect(await db().outboxEvent.count({ where: { eventType: 'NOTIFICATION_REQUESTED' } })).toBe(
      1,
    );
    expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
      'SUCCESS',
    );

    expect(await incidentSnapshot(w.incident.id)).toEqual(before);
  });

  it('exposes generatedAt equal to the audit createdAt, through the API and the timeline', async () => {
    const w = await buildWorld();
    expect((await aiTriageOf(w)).status).toBe('PENDING');
    const { run } = harness();
    await run(await requestTriage(w));

    const triage = await aiTriageOf(w);
    const [audit] = await auditOf(w.incident.id);
    expect(triage).toMatchObject({
      status: 'COMPLETED',
      category: 'Resource saturation',
      suggestedSeverity: 'P1',
      confidence: 0.82,
      reasoningSummary: 'Sustained CPU above 90% on a checkout host.',
      evidence: VALID_OUTPUT.evidence,
      model: 'fake-model',
      modelVersion: 'fake-model-1',
    });
    expect(triage.generatedAt).toBe((audit!.metadata as { createdAt: string }).createdAt);
    expect(JSON.stringify(triage)).not.toContain('CPU saturation on one web host');
    expect(triage).not.toHaveProperty('summary');
    expect(triage).not.toHaveProperty('rawOutput');

    const items = (
      await request(app).get(`/api/v1/incidents/${w.incident.id}/timeline`).set(w.token)
    ).body.data as { eventType: string; details: { createdAt: string } }[];
    const event = items.find((item) => item.eventType === 'AI_TRIAGE_COMPLETED');
    expect(event?.details.createdAt).toBe(triage.generatedAt);
  });

  it.each(['RESOLVED', 'CLOSED'] as const)(
    'runs regardless of the incident status (%s)',
    async (status) => {
      const w = await buildWorld(status);
      const before = await incidentSnapshot(w.incident.id);
      const { run } = harness();
      await run(await requestTriage(w));
      expect((await triageRow(w.alert.id))?.failureStatus).toBe('SUCCESS');
      expect(await incidentSnapshot(w.incident.id)).toEqual(before);
    },
  );

  it('keeps the severity the incident already has: the suggestion is advisory', async () => {
    const w = await buildWorld();
    const { run } = harness();
    await run(await requestTriage(w));
    const incident = await incidentSnapshot(w.incident.id);
    expect(incident.severity).toBe('P2');
    expect((await triageRow(w.alert.id))?.suggestedSeverity).toBe('P1');
  });
});

describe('data allow-list (SLICE-10 §4.1)', () => {
  it('sends the provider only summary, description, labels and additionalDetails', async () => {
    const w = await buildWorld();
    const { provider, run } = harness();
    await run(await requestTriage(w));

    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(Object.keys(call.input).sort()).toEqual([...TRIAGE_ALLOWED_FIELDS].sort());
    expect(call.input).toEqual({
      summary: ALERT_SUMMARY,
      description: ALERT_DESCRIPTION,
      labels: ALERT_LABELS,
      additionalDetails: ALERT_DETAILS,
    });
    expect(call.instructions).toBe(TRIAGE_INSTRUCTIONS);

    const everything = JSON.stringify(call);
    for (const forbidden of [
      w.alert.id,
      w.incident.id,
      w.service.id,
      w.team.id,
      ALERT_NAME,
      PAYLOAD_MARKER,
      'monitoring.example',
      'production',
      'Datadog',
    ]) {
      expect(everything).not.toContain(forbidden);
    }
  });
});

describe('invalid output (SLICE-10 §4.4)', () => {
  const invalidOutputs: [string, string][] = [
    ['a bad severity', validText({ suggestedSeverity: 'P9' })],
    ['a confidence out of range', validText({ confidence: 1.5 })],
    ['malformed evidence', validText({ evidence: [{ type: 'LABEL' }] })],
    ['a blank category', validText({ category: '  ' })],
    ['text that is not JSON', 'I think this is a P1.'],
    ['fenced JSON', '```json\n' + validText() + '\n```'],
  ];

  it.each(invalidOutputs)(
    '%s is never stored as valid: retried, then FAILED with no event or notification',
    async (_name, text) => {
      const w = await buildWorld();
      const before = await incidentSnapshot(w.incident.id);
      const provider = new FakeAiProvider();
      const { gateway, run, runAllAttempts } = harness(provider);
      provider.defaultText = text;
      const outboxId = await requestTriage(w);

      await run(outboxId, 0).catch((error: unknown) => error);
      const afterFirst = await triageRow(w.alert.id);
      expect(afterFirst?.failureStatus).toBe('PENDING');
      expect(afterFirst?.suggestedSeverity).toBeNull();
      expect(afterFirst?.category).toBeNull();
      expect(afterFirst?.rawOutput).not.toBeNull();
      expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
        'PROCESSING',
      );

      const errors = await runAllAttempts(outboxId);

      expect(errors).toHaveLength(config.executionAttempts);
      expect(provider.calls).toHaveLength(1 + config.executionAttempts);
      const row = await triageRow(w.alert.id);
      expect(row).toMatchObject({
        failureStatus: 'FAILED',
        suggestedSeverity: null,
        category: null,
      });
      expect(await auditOf(w.incident.id)).toHaveLength(0);
      expect(await notifications()).toHaveLength(0);
      expect(await db().auditEvent.count({ where: { incidentId: w.incident.id } })).toBe(0);
      expect(gateway.deadLetters).toHaveLength(1);
      expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
        'DEAD_LETTER',
      );
      expect(await incidentSnapshot(w.incident.id)).toEqual(before);

      const triage = await aiTriageOf(w);
      expect(triage).toMatchObject({ status: 'UNAVAILABLE', category: null, evidence: [] });
    },
  );

  it('succeeds when a later attempt produces valid output', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { run } = harness(provider);
    provider.responses = ['not json', validText()];
    const outboxId = await requestTriage(w);

    await expect(run(outboxId, 0)).rejects.toBeDefined();
    await run(outboxId, 1);

    expect((await triageRow(w.alert.id))?.failureStatus).toBe('SUCCESS');
    expect(await auditOf(w.incident.id)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });
});

describe('provider failures (SLICE-10 §4.6)', () => {
  it.each([
    ['RATE_LIMITED', new AiProviderError('RATE_LIMITED', 429, 10), 'RATE_LIMITED'],
    ['UNAVAILABLE', new AiProviderError('UNAVAILABLE', 503), 'SERVICE_UNAVAILABLE'],
    ['TIMEOUT', new AiProviderError('TIMEOUT'), 'SERVICE_UNAVAILABLE'],
    ['NETWORK', new AiProviderError('NETWORK'), 'NETWORK'],
    ['REJECTED', new AiProviderError('REJECTED', 404), 'SERVICE_UNAVAILABLE'],
  ])('%s is retried and recovers, with the incident untouched', async (_kind, failure, reason) => {
    const w = await buildWorld();
    const before = await incidentSnapshot(w.incident.id);
    const provider = new FakeAiProvider();
    const { run } = harness(provider);
    provider.responses = [failure, validText()];
    const outboxId = await requestTriage(w);

    const error = await run(outboxId, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableJobError);
    expect((error as RetryableJobError).reason).toBe(reason);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('PENDING');
    expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
      'PROCESSING',
    );

    await run(outboxId, 1);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('SUCCESS');
    expect((await incidentSnapshot(w.incident.id)).severity).toBe(before.severity);
  });

  it('honors the retry delay a rate-limited provider asks for', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { run } = harness(provider);
    provider.responses = [new AiProviderError('RATE_LIMITED', 429, 4321)];
    const error = (await run(await requestTriage(w), 0).catch(
      (e: unknown) => e,
    )) as RetryableJobError;
    expect(error.retryAfterMs).toBe(4321);
  });

  it('ends FAILED after the bounded attempts, with a dead letter and no event or notification', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { gateway, runAllAttempts } = harness(provider);
    provider.defaultText = '';
    provider.responses = Array.from(
      { length: config.executionAttempts },
      () => new AiProviderError('UNAVAILABLE', 503),
    );
    const outboxId = await requestTriage(w);

    const errors = await runAllAttempts(outboxId);

    expect(errors).toHaveLength(config.executionAttempts);
    expect(provider.calls).toHaveLength(config.executionAttempts);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('FAILED');
    expect(gateway.deadLetters).toHaveLength(1);
    expect(await auditOf(w.incident.id)).toHaveLength(0);
    expect(await notifications()).toHaveLength(0);
  });

  it('a configuration or authentication error is final: FAILED at once, no retry', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { gateway, run } = harness(provider);
    provider.responses = [new AiProviderError('CONFIGURATION', 403)];
    const outboxId = await requestTriage(w);

    const error = await run(outboxId, 0).catch((e: unknown) => e);

    expect((error as Error).name).toBe('UnrecoverableError');
    expect(provider.calls).toHaveLength(1);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('FAILED');
    expect(gateway.deadLetters).toHaveLength(1);
    expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
      'DEAD_LETTER',
    );
  });

  it('an unexpected provider error is retried like any other unclassified failure', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { run } = harness(provider);
    provider.responses = [new Error('boom'), validText()];
    const outboxId = await requestTriage(w);
    await expect(run(outboxId, 0)).rejects.toThrow('boom');
    await run(outboxId, 1);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('SUCCESS');
  });

  it('keeps ingestion and incident management working throughout a provider outage', async () => {
    const team = await createTeam();
    const admin = await createUser({ role: 'ADMIN', teamId: team.id });
    const engineer = await createUser({ role: 'ENGINEER', teamId: team.id });
    const service = await createService(team.id, admin.id);
    const source = await createSigningSource();
    const token = bearer((await login(app, engineer.email)).token);
    const ingest = (name: string) =>
      postWebhook(
        app,
        source.id,
        [
          {
            serviceId: service.id,
            environment: 'production',
            startedAt: '2026-10-14T10:00:00Z',
            name,
            sourceEventId: `evt-${randomUUID()}`,
            summary: 'CPU high',
          },
        ],
        { timestamp: nowSeconds() - Math.floor(Math.random() * 100) },
      );

    const provider = new FakeAiProvider();
    const { gateway, runAllAttempts } = harness(provider);
    provider.defaultText = '';
    provider.responses = Array.from(
      { length: config.executionAttempts },
      () => new AiProviderError('UNAVAILABLE', 503),
    );

    const first = await ingest('first');
    expect(first.status).toBe(200);
    const incidentId = first.body.data.results[0].incidentId as string;
    const alertId = first.body.data.results[0].alertId as string;
    const outbox = await db().outboxEvent.findFirstOrThrow({
      where: { eventType: 'ALERT_TRIAGE_REQUESTED', aggregateId: alertId },
    });

    await runAllAttempts(outbox.id);
    expect((await triageRow(alertId))?.failureStatus).toBe('FAILED');
    expect(gateway.deadLetters).toHaveLength(1);

    const second = await ingest('second');
    expect(second.status).toBe(200);
    expect(second.body.data.results[0].incidentId).toBeTruthy();

    const ack = await request(app)
      .patch(`/api/v1/incidents/${incidentId}`)
      .set(token)
      .send({ status: 'ACKNOWLEDGED' });
    expect(ack.status).toBe(200);
    expect((await incidentSnapshot(incidentId)).status).toBe('ACKNOWLEDGED');
  });
});

describe('job preconditions', () => {
  it('an unknown alert is a non-retryable error that creates no row', async () => {
    const w = await buildWorld();
    const { provider, gateway, run } = harness();
    const outboxId = await requestTriage(w, { alertId: randomUUID() });
    const error = await run(outboxId, 0).catch((e: unknown) => e);
    expect((error as Error).name).toBe('UnrecoverableError');
    expect(provider.calls).toHaveLength(0);
    expect(await db().aITriage.count()).toBe(0);
    expect(gateway.deadLetters).toHaveLength(1);
    expect(await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({
      status: 'DEAD_LETTER',
      errorClass: 'RESOURCE_NOT_FOUND',
    });
  });

  it('an incident that is not the alert’s is a non-retryable error: FAILED, provider not called', async () => {
    const w = await buildWorld();
    const { provider, run } = harness();
    const outboxId = await requestTriage(w, { incidentId: randomUUID() });
    await expect(run(outboxId, 0)).rejects.toBeDefined();
    expect(provider.calls).toHaveLength(0);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('FAILED');
    expect(await auditOf(w.incident.id)).toHaveLength(0);
  });

  it('an invalid payload is dead-lettered before the provider is called', async () => {
    const w = await buildWorld();
    const { provider, gateway, run } = harness();
    // enqueueOutbox refuses an invalid payload, so the row is written the way a bad producer would.
    const row = await db().outboxEvent.create({
      data: {
        eventType: 'ALERT_TRIAGE_REQUESTED',
        aggregateType: 'Alert',
        aggregateId: w.alert.id,
        payload: { alertId: 'not-a-uuid', incidentId: w.incident.id },
      },
    });
    await expect(run(row.id, 0)).rejects.toBeDefined();
    expect(provider.calls).toHaveLength(0);
    expect(await db().aITriage.count()).toBe(0);
    expect(gateway.deadLetters).toHaveLength(1);
    expect(await db().outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'DEAD_LETTER',
      errorClass: 'INVALID_PAYLOAD',
    });
  });
});

describe('idempotency and concurrency (SLICE-10 §8)', () => {
  it('a duplicate job after success is a no-op: one record, one event, one notification', async () => {
    const w = await buildWorld();
    const { provider, run } = harness();
    const first = await requestTriage(w);
    const second = await requestTriage(w);

    await run(first);
    const stored = await triageRow(w.alert.id);
    await run(second);

    expect(provider.calls).toHaveLength(1);
    expect(await db().aITriage.count()).toBe(1);
    expect(await auditOf(w.incident.id)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
    expect(await triageRow(w.alert.id)).toEqual(stored);
    expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: second } })).status).toBe(
      'SUCCESS',
    );
  });

  it('parallel jobs for one alert store a single result, one event and one notification', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { run } = harness(provider);
    provider.delayMs = 150;
    const jobs = [await requestTriage(w), await requestTriage(w), await requestTriage(w)];

    await Promise.all(jobs.map((id) => run(id)));

    expect(await db().aITriage.count()).toBe(1);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('SUCCESS');
    expect(await auditOf(w.incident.id)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
    expect(await db().outboxEvent.count({ where: { eventType: 'NOTIFICATION_REQUESTED' } })).toBe(
      1,
    );
  });

  it('a FAILED triage that is re-driven goes back to PENDING and can succeed', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { run, runAllAttempts } = harness(provider);
    provider.defaultText = 'garbage';
    await runAllAttempts(await requestTriage(w));
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('FAILED');

    provider.defaultText = validText();
    await run(await requestTriage(w), 0);

    expect(await db().aITriage.count()).toBe(1);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('SUCCESS');
    expect(await auditOf(w.incident.id)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });

  it('a SUCCESS triage is never overwritten by a later failing job', async () => {
    const w = await buildWorld();
    const provider = new FakeAiProvider();
    const { run } = harness(provider);
    await run(await requestTriage(w));
    const stored = await triageRow(w.alert.id);

    provider.defaultText = 'garbage';
    await run(await requestTriage(w), config.executionAttempts - 1);

    expect(await triageRow(w.alert.id)).toEqual(stored);
  });
});

describe('atomic success (SLICE-10 §8)', () => {
  it('rolls the row, the audit event and the notification back when the notification fails', async () => {
    const w = await buildWorld();
    const { run } = harness();
    const outboxId = await requestTriage(w);
    jest.spyOn(enqueueModule, 'enqueueNotification').mockRejectedValueOnce(new Error('boom'));

    await expect(run(outboxId, 0)).rejects.toThrow('boom');

    const row = await triageRow(w.alert.id);
    expect(row).toMatchObject({
      failureStatus: 'PENDING',
      suggestedSeverity: null,
      rawOutput: null,
    });
    expect(await auditOf(w.incident.id)).toHaveLength(0);
    expect(await notifications()).toHaveLength(0);

    await run(outboxId, 1);
    expect((await triageRow(w.alert.id))?.failureStatus).toBe('SUCCESS');
    expect(await auditOf(w.incident.id)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });

  it('rolls the row back when the audit event cannot be written', async () => {
    const w = await buildWorld();
    const { run } = harness();
    const outboxId = await requestTriage(w);
    jest.spyOn(auditModule, 'appendAuditEvent').mockRejectedValueOnce(new Error('audit down'));

    await expect(run(outboxId, 0)).rejects.toThrow('audit down');

    expect((await triageRow(w.alert.id))?.failureStatus).toBe('PENDING');
    expect(await notifications()).toHaveLength(0);
  });
});

describe('logging (SLICE-10 §7)', () => {
  it('never logs a prompt, alert text or model output, on success or failure', async () => {
    const w = await buildWorld();
    const ok = harness();
    ok.provider.defaultText = validText({ reasoning: 'MODEL-OUTPUT-MARKER' });
    await ok.run(await requestTriage(w));

    const w2 = await buildWorld();
    const bad = new FakeAiProvider();
    const failing = harness(bad);
    bad.defaultText = '{"category": "MODEL-OUTPUT-MARKER"';
    await failing.runAllAttempts(await requestTriage(w2));

    // Log entries may hold circular request objects (HTTP logging); skip repeats.
    const seen = new WeakSet<object>();
    const logged = JSON.stringify(mockLogs, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return undefined;
        seen.add(value);
      }
      return value;
    });
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [
      'MODEL-OUTPUT-MARKER',
      ALERT_SUMMARY,
      ALERT_DESCRIPTION,
      ALERT_DETAILS,
      'host=web-1',
      PAYLOAD_MARKER,
      'incident triage assistant',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
