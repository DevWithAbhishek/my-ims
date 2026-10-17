import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as auditModule from '../../src/infra/audit/append-audit-event';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import { enqueueOutbox } from '../../src/infra/jobs/outbox';
import { processOutboxJob } from '../../src/infra/jobs/processor';
import { runRelayCycle } from '../../src/infra/jobs/relay';
import { getRedis } from '../../src/infra/redis/redis';
import { AiProviderError } from '../../src/modules/ai/ai-provider';
import { FakeAiProvider } from '../../src/modules/ai/fake-ai-provider';
import { POSTMORTEM_INSTRUCTIONS } from '../../src/modules/ai/postmortem.prompt';
import { createPostmortemProcessor } from '../../src/modules/ai/postmortem.processor';
import * as enqueueModule from '../../src/modules/notifications/enqueue-notification';
import { buildTestApp } from '../helpers/app';
import { bearer, createTeam, createUser, login, resetState } from '../helpers/identity';
import { FakeGateway, testJobsConfig } from '../helpers/jobs';

// Everything the code under test logs is captured, to prove no prompt, incident text or model
// output reaches a log.
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

/** `JSON.stringify` that survives the circular request/response objects logs may carry. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return '[circular]';
      seen.add(item);
    }
    return item;
  });
}

const app = buildTestApp();
const db = () => getPrisma();
const config = testJobsConfig();
const QUEUE = 'postmortem';

beforeEach(async () => {
  mockLogs.length = 0;
  await resetState();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

const CREATED_AT = new Date('2026-10-17T08:00:00.000Z');
const RESOLVED_AT = new Date('2026-10-17T09:30:00.001Z'); // 90 minutes and 1 ms → 91
const DESCRIPTION = 'DESCRIPTION-MARKER checkout returned 500s';
const COMMENTS = [
  { title: 'TITLE-ONE', description: 'COMMENT-ONE pool exhausted' },
  { title: 'TITLE-TWO', description: 'COMMENT-TWO restarted pods' },
];
const RESOLUTION_MARKER = 'RESOLUTION-MARKER-DO-NOT-SEND';

const VALID_OUTPUT = {
  summary: 'Checkout failed for 90 minutes.',
  impact: 'Customers could not pay.',
  detection: 'Alert fired.',
  timeline: '08:00 start, 09:30 resolved.',
  rootCause: 'Connection pool exhausted.',
  contributingFactors: 'No pool alerting.',
  resolution: 'Pods restarted.',
  correctiveActions: 'Raise pool size.',
  preventiveActions: 'Add pool alerts.',
  unknowns: null,
  riskLevel: 'P1',
};
const validText = (overrides: object = {}) => JSON.stringify({ ...VALID_OUTPUT, ...overrides });

const CONTENT = {
  summary: 'edited summary',
  impact: 'impact',
  detection: 'detection',
  timeline: 'timeline',
  rootCause: 'root cause',
  contributingFactors: 'factors',
  resolution: 'resolution',
  correctiveActions: 'corrective',
  preventiveActions: 'preventive',
  riskLevel: 'P2',
};

async function buildWorld() {
  const teamA = await createTeam();
  const teamB = await createTeam();
  const level1 = await createUser({ role: 'TEAM_LEAD', teamId: teamA.id, name: 'Level One' });
  const level2 = await createUser({ role: 'TEAM_LEAD', teamId: teamA.id, name: 'Level Two' });
  const level3 = await createUser({ role: 'TEAM_LEAD', teamId: teamA.id, name: 'Level Three' });
  const fallbackAdmin = await createUser({ role: 'ADMIN', teamId: teamA.id, name: 'Fallback' });
  const engineer = await createUser({ role: 'ENGINEER', teamId: teamA.id, name: 'Eli Engineer' });
  const otherLead = await createUser({ role: 'TEAM_LEAD', teamId: teamA.id, name: 'Not In Chain' });
  const otherAdmin = await createUser({ role: 'ADMIN', teamId: teamA.id, name: 'Admin Not Chain' });
  const outsider = await createUser({ role: 'ENGINEER', teamId: teamB.id });
  const noTeam = await createUser({ role: 'ADMIN', teamId: null });
  const policy = await db().escalationPolicy.create({
    data: {
      level1Id: level1.id,
      level2Id: level2.id,
      level3Id: level3.id,
      fallbackAdminId: fallbackAdmin.id,
    },
  });
  const service = await db().appService.create({
    data: {
      name: `svc-${randomUUID().slice(0, 8)}`,
      teamId: teamA.id,
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
  const tokenOf = async (user: { email: string }) => bearer((await login(app, user.email)).token);
  return {
    teamA,
    level1,
    level2,
    level3,
    fallbackAdmin,
    engineer,
    service,
    auth: {
      level1: await tokenOf(level1),
      level2: await tokenOf(level2),
      level3: await tokenOf(level3),
      fallbackAdmin: await tokenOf(fallbackAdmin),
      engineer: await tokenOf(engineer),
      otherLead: await tokenOf(otherLead),
      otherAdmin: await tokenOf(otherAdmin),
      outsider: await tokenOf(outsider),
      noTeam: await tokenOf(noTeam),
    },
  };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

type Seed = {
  incident?: 'OPEN' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';
  generation?: 'GENERATING' | 'DRAFT' | 'FAILED';
  review?: 'PENDING' | 'REVIEWED';
  /** Draft content, as an AI draft (provenance set) unless `manual`. */
  filled?: boolean;
  manual?: boolean;
  failureReason?: 'AI_UNAVAILABLE' | 'OUTPUT_INVALID' | 'INSUFFICIENT_CONTEXT' | null;
  noPostmortem?: boolean;
  description?: string;
  comments?: { title: string | null; description: string }[];
};

async function seed(w: World, s: Seed = {}) {
  const status = s.incident ?? 'RESOLVED';
  const resolved = status === 'RESOLVED' || status === 'CLOSED';
  const incident = await db().incident.create({
    data: {
      title: 'Checkout is slow',
      description: s.description ?? DESCRIPTION,
      severity: 'P2',
      status,
      teamId: w.teamA.id,
      affectedServiceId: w.service.id,
      createdAt: CREATED_AT,
      resolutionSummary: resolved ? RESOLUTION_MARKER : null,
      ...(resolved ? { resolvedById: w.engineer.id, resolvedTimestamp: RESOLVED_AT } : {}),
      ...(status === 'CLOSED'
        ? { closedById: w.level1.id, closedTimestamp: new Date('2026-10-17T10:00:00.000Z') }
        : {}),
    },
  });
  for (const [index, comment] of (s.comments ?? COMMENTS).entries()) {
    await db().comment.create({
      data: {
        title: comment.title,
        description: comment.description,
        incidentId: incident.id,
        authorId: w.engineer.id,
        createdAt: new Date(CREATED_AT.getTime() + (index + 1) * 1000),
      },
    });
  }
  if (s.noPostmortem) return { incident, postmortem: null };
  const generation = s.generation ?? 'GENERATING';
  const review = s.review ?? 'PENDING';
  const filled = s.filled ?? generation === 'DRAFT';
  const postmortem = await db().postmortem.create({
    data: {
      incidentId: incident.id,
      generationStatus: generation,
      reviewStatus: review,
      failureReason: s.failureReason ?? (generation === 'FAILED' ? 'AI_UNAVAILABLE' : null),
      ...(filled
        ? {
            summary: 'original summary',
            impact: 'original impact',
            detection: 'original detection',
            timeline: 'original timeline',
            rootCause: 'original root cause',
            factors: 'original factors',
            resolution: 'original resolution',
            correctiveActions: 'original corrective',
            preventiveActions: 'original preventive',
            unknowns: 'original unknowns',
            riskLevel: 'P3',
            MTTR: 91,
            ...(s.manual
              ? {}
              : {
                  model: 'fake-model',
                  modelVersion: 'fake-model-1',
                  prompt: 'PROMPT-MARKER',
                  inputData: 'INPUT-MARKER',
                  generatedAt: new Date('2026-10-17T09:31:00.000Z'),
                }),
          }
        : {}),
      ...(review === 'REVIEWED'
        ? { reviewedById: w.level1.id, reviewedAt: new Date('2026-10-17T10:00:00.000Z') }
        : {}),
    },
  });
  return { incident, postmortem };
}

const url = (incidentId: string) => `/api/v1/incidents/${incidentId}/postmortem`;
const get = (token: Record<string, string>, incidentId: string) =>
  request(app).get(url(incidentId)).set(token);
const patch = (token: Record<string, string>, incidentId: string, body: unknown) =>
  request(app)
    .patch(url(incidentId))
    .set(token)
    .send(body as object);
const post = (token: Record<string, string>, incidentId: string, body: unknown) =>
  request(app)
    .post(url(incidentId))
    .set(token)
    .send(body as object);

const events = (incidentId: string) =>
  db().auditEvent.findMany({ where: { incidentId }, orderBy: { createdAt: 'asc' } });
const eventTypes = async (incidentId: string) =>
  (await events(incidentId)).map((event) => event.eventType);
const notifications = (eventType: string) =>
  db().notification.findMany({ where: { eventType: eventType as never } });
const postmortemOf = (incidentId: string) =>
  db().postmortem.findUniqueOrThrow({ where: { incidentId } });
const incidentOf = (id: string) => db().incident.findUniqueOrThrow({ where: { id } });
const outboxOf = (eventType: string) =>
  db().outboxEvent.findMany({
    where: { eventType: eventType as never },
    orderBy: { createdAt: 'asc' },
  });

// ---------------------------------------------------------------------------------------------
// The generation worker
// ---------------------------------------------------------------------------------------------

/** A committed `POSTMORTEM_GENERATION_REQUESTED` outbox row, as the resolve transaction writes it. */
async function requestGeneration(postmortemId: string, incidentId: string, overrides = {}) {
  return runInTransaction((tx) =>
    enqueueOutbox(tx, {
      eventType: 'POSTMORTEM_GENERATION_REQUESTED',
      aggregateType: 'POSTMORTEM',
      aggregateId: postmortemId,
      payload: { postmortemId, incidentId, requestId: 'req-pm', ...overrides },
    }),
  );
}

function harness(provider = new FakeAiProvider()) {
  provider.defaultText = validText();
  const gateway = new FakeGateway();
  const processor = createPostmortemProcessor({ provider, maxAttempts: config.executionAttempts });
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

describe('generation worker: success (SLICE-11 §4.2)', () => {
  it('stores the draft, provenance, MTTR, the audit event and one INFO notification in one commit', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const before = await incidentOf(incident.id);
    const outboxId = await requestGeneration(postmortem!.id, incident.id);
    const { provider, run } = harness();

    await run(outboxId);

    expect(provider.calls).toHaveLength(1);
    const row = await postmortemOf(incident.id);
    expect(row).toMatchObject({
      generationStatus: 'DRAFT',
      reviewStatus: 'PENDING',
      failureReason: null,
      summary: VALID_OUTPUT.summary,
      impact: VALID_OUTPUT.impact,
      detection: VALID_OUTPUT.detection,
      timeline: VALID_OUTPUT.timeline,
      rootCause: VALID_OUTPUT.rootCause,
      factors: VALID_OUTPUT.contributingFactors,
      resolution: VALID_OUTPUT.resolution,
      correctiveActions: VALID_OUTPUT.correctiveActions,
      preventiveActions: VALID_OUTPUT.preventiveActions,
      unknowns: null,
      riskLevel: 'P1',
      MTTR: 91,
      model: 'fake-model',
      modelVersion: 'fake-model-1',
      prompt: POSTMORTEM_INSTRUCTIONS,
      reviewedById: null,
      reviewedAt: null,
    });
    expect(row.generatedAt).toBeInstanceOf(Date);
    expect(JSON.parse(row.inputData!)).toEqual({
      description: DESCRIPTION,
      severity: 'P2',
      comments: COMMENTS.map((comment) => JSON.stringify(comment)),
    });
    expect(await db().postmortem.count()).toBe(1);

    const audit = await events(incident.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      eventType: 'POSTMORTEM_GENERATED',
      actor: null,
      metadata: { postmortemId: postmortem!.id },
    });

    const sent = await notifications('POSTMORTEM_GENERATED');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      notificationType: 'INFO',
      incidentId: incident.id,
      idempotencyKey: `POSTMORTEM_GENERATED:${incident.id}:${audit[0]!.id}`,
    });
    expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
      'SUCCESS',
    );
    expect(await incidentOf(incident.id)).toEqual(before);
  });

  it('sends the provider only the description, severity and the comments (title, description)', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const { provider, run } = harness();
    await run(await requestGeneration(postmortem!.id, incident.id));

    const [call] = provider.calls;
    expect(call!.instructions).toBe(POSTMORTEM_INSTRUCTIONS);
    expect(Object.keys(call!.input).sort()).toEqual(['comments', 'description', 'severity']);
    const sent = JSON.stringify(call);
    expect(sent).toContain('DESCRIPTION-MARKER');
    expect(sent).toContain('TITLE-ONE');
    expect(sent).toContain('COMMENT-TWO');
    for (const forbidden of [
      RESOLUTION_MARKER,
      w.engineer.email,
      w.engineer.id,
      'Checkout is slow',
    ]) {
      expect(sent).not.toContain(forbidden);
    }
  });

  it('stores unknowns when the model reports them, and ignores extra keys', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const provider = new FakeAiProvider();
    const { run } = harness(provider);
    provider.responses = [validText({ unknowns: 'Why the pool leaked', extra: 'ignored' })];
    await run(await requestGeneration(postmortem!.id, incident.id));
    expect((await postmortemOf(incident.id)).unknowns).toBe('Why the pool leaked');
  });

  it('exposes the draft through P1 without prompt or inputData', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const { run } = harness();
    await run(await requestGeneration(postmortem!.id, incident.id));

    const res = await get(w.auth.engineer, incident.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      generationStatus: 'DRAFT',
      reviewStatus: 'PENDING',
      aiGenerated: true,
      contributingFactors: VALID_OUTPUT.contributingFactors,
      mttrMinutes: 91,
      riskLevel: 'P1',
      provenance: { model: 'fake-model', modelVersion: 'fake-model-1' },
      review: null,
      failureReason: null,
    });
    expect(res.body.data.provenance.generatedAt).toMatch(/Z$/);
    expect(JSON.stringify(res.body)).not.toMatch(/prompt|inputData|PROMPT|factors"/);
  });

  it('logs neither the prompt, the incident text nor the model output', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const provider = new FakeAiProvider();
    const { runAllAttempts } = harness(provider);
    provider.responses = ['MODEL-OUTPUT-MARKER not json', validText()];
    await runAllAttempts(await requestGeneration(postmortem!.id, incident.id));
    const logged = safeJson(mockLogs);
    for (const secret of [
      'MODEL-OUTPUT-MARKER',
      'DESCRIPTION-MARKER',
      'COMMENT-ONE',
      'TITLE-TWO',
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain('You are an assistant');
    expect(logged).not.toContain(VALID_OUTPUT.summary);
  });
});

describe('generation worker: failure paths', () => {
  const failedState = async (incidentId: string) => {
    const row = await postmortemOf(incidentId);
    return { status: row.generationStatus, reason: row.failureReason, summary: row.summary };
  };

  it.each([
    ['provider unavailable', () => new AiProviderError('UNAVAILABLE', 503)],
    ['timeout', () => new AiProviderError('TIMEOUT')],
    ['rate limit', () => new AiProviderError('RATE_LIMITED', 429)],
  ])(
    '%s: retries, then FAILED/AI_UNAVAILABLE with a WARNING notification and no audit event',
    async (_name, makeError) => {
      const w = await buildWorld();
      const { incident, postmortem } = await seed(w);
      const outboxId = await requestGeneration(postmortem!.id, incident.id);
      const provider = new FakeAiProvider();
      const { gateway, run } = harness(provider);
      provider.responses = Array.from({ length: config.executionAttempts }, makeError);

      await run(outboxId, 0).catch(() => undefined);
      expect(await failedState(incident.id)).toMatchObject({ status: 'GENERATING', reason: null });
      expect(await notifications('POSTMORTEM_GENERATION_FAILED')).toHaveLength(0);

      for (let attempt = 1; attempt < config.executionAttempts; attempt += 1) {
        await run(outboxId, attempt).catch(() => undefined);
      }
      expect(provider.calls.length).toBe(config.executionAttempts);
      expect(await failedState(incident.id)).toEqual({
        status: 'FAILED',
        reason: 'AI_UNAVAILABLE',
        summary: null,
      });
      expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
      expect(await events(incident.id)).toHaveLength(0);

      const sent = await notifications('POSTMORTEM_GENERATION_FAILED');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        notificationType: 'WARNING',
        idempotencyKey: `POSTMORTEM_GENERATION_FAILED:${incident.id}:${outboxId}`,
      });
      const recipients = sent[0]!.recipients as string[];
      expect(recipients).toEqual(expect.arrayContaining([w.engineer.id, w.level3.id]));
      expect(gateway.deadLetters).toHaveLength(1);
      expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
        'DEAD_LETTER',
      );
    },
  );

  it('invalid output on every attempt: FAILED/OUTPUT_INVALID', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const provider = new FakeAiProvider();
    const { runAllAttempts } = harness(provider);
    provider.responses = Array.from({ length: config.executionAttempts }, () => 'not json at all');
    await runAllAttempts(await requestGeneration(postmortem!.id, incident.id));
    expect(provider.calls.length).toBe(config.executionAttempts);
    expect(await failedState(incident.id)).toMatchObject({
      status: 'FAILED',
      reason: 'OUTPUT_INVALID',
      summary: null,
    });
    expect(await events(incident.id)).toHaveLength(0);
    expect(await notifications('POSTMORTEM_GENERATION_FAILED')).toHaveLength(1);
  });

  it('a field over 20,000 characters is invalid output, and a later valid attempt succeeds', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const provider = new FakeAiProvider();
    const { runAllAttempts } = harness(provider);
    provider.responses = [validText({ summary: 'x'.repeat(20_001) }), validText()];
    const errors = await runAllAttempts(await requestGeneration(postmortem!.id, incident.id));
    expect(errors).toHaveLength(1);
    expect(await failedState(incident.id)).toMatchObject({ status: 'DRAFT', reason: null });
  });

  it('a non-retryable provider error fails at once, with no provider text stored or logged', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const provider = new FakeAiProvider();
    const { runAllAttempts } = harness(provider);
    const error = new AiProviderError('CONFIGURATION', 401);
    error.message = 'SECRET-PROVIDER-TEXT invalid api key';
    provider.responses = [error];
    await runAllAttempts(await requestGeneration(postmortem!.id, incident.id));
    expect(provider.calls).toHaveLength(1);
    expect(await failedState(incident.id)).toMatchObject({
      status: 'FAILED',
      reason: 'AI_UNAVAILABLE',
    });
    const dump = safeJson([
      await db().postmortem.findMany(),
      await db().notification.findMany(),
      await db().outboxEvent.findMany(),
      mockLogs,
    ]);
    expect(dump).not.toContain('SECRET-PROVIDER-TEXT');
  });

  it.each([
    ['no description and no comments', { description: '', comments: [] }],
    ['a blank description and no comments', { description: '  ', comments: [] }],
  ])('%s: INSUFFICIENT_CONTEXT without a provider call', async (_name, input) => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w, input);
    const outboxId = await requestGeneration(postmortem!.id, incident.id);
    const { provider, gateway, runAllAttempts } = harness();
    await runAllAttempts(outboxId);
    expect(provider.calls).toHaveLength(0);
    expect(await failedState(incident.id)).toMatchObject({
      status: 'FAILED',
      reason: 'INSUFFICIENT_CONTEXT',
    });
    expect(await notifications('POSTMORTEM_GENERATION_FAILED')).toHaveLength(1);
    expect(await events(incident.id)).toHaveLength(0);
    expect(gateway.deadLetters).toHaveLength(1);
    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
  });

  it('a description alone, or comments alone, is enough to call the provider', async () => {
    const w = await buildWorld();
    const first = await seed(w, { comments: [] });
    const second = await seed(w, { description: '' });
    const { provider, run } = harness();
    await run(await requestGeneration(first.postmortem!.id, first.incident.id));
    await run(await requestGeneration(second.postmortem!.id, second.incident.id));
    expect(provider.calls).toHaveLength(2);
  });

  it('a failing success transaction leaves no partial data and a later attempt succeeds', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const outboxId = await requestGeneration(postmortem!.id, incident.id);
    const { run } = harness();
    jest.spyOn(auditModule, 'appendAuditEvent').mockRejectedValueOnce(new Error('audit down'));

    await expect(run(outboxId, 0)).rejects.toBeDefined();
    expect(await failedState(incident.id)).toMatchObject({ status: 'GENERATING', summary: null });
    expect(await events(incident.id)).toHaveLength(0);
    expect(await notifications('POSTMORTEM_GENERATED')).toHaveLength(0);

    await run(outboxId, 1);
    expect((await postmortemOf(incident.id)).generationStatus).toBe('DRAFT');
    expect(await events(incident.id)).toHaveLength(1);
  });

  it('a failing failure transaction keeps GENERATING and still dead-letters', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const outboxId = await requestGeneration(postmortem!.id, incident.id);
    const provider = new FakeAiProvider();
    const { gateway, runAllAttempts } = harness(provider);
    provider.responses = Array.from({ length: config.executionAttempts }, () => 'bad');
    jest
      .spyOn(enqueueModule, 'enqueueNotification')
      .mockRejectedValue(new Error('notification producer down'));
    await runAllAttempts(outboxId);
    expect(await failedState(incident.id)).toMatchObject({ status: 'GENERATING', reason: null });
    expect(await notifications('POSTMORTEM_GENERATION_FAILED')).toHaveLength(0);
    expect(gateway.deadLetters).toHaveLength(1);
  });
});

describe('generation worker: idempotency', () => {
  it('a duplicate job is a no-op: one provider call, one audit event, one notification', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const first = await requestGeneration(postmortem!.id, incident.id);
    const second = await requestGeneration(postmortem!.id, incident.id);
    const { provider, run } = harness();
    await run(first);
    await run(second);
    expect(provider.calls).toHaveLength(1);
    expect(await events(incident.id)).toHaveLength(1);
    expect(await notifications('POSTMORTEM_GENERATED')).toHaveLength(1);
    expect(await db().postmortem.count()).toBe(1);
  });

  it.each([
    ['DRAFT', { generation: 'DRAFT' as const }],
    ['FAILED', { generation: 'FAILED' as const }],
    [
      'a CLOSED incident',
      { incident: 'CLOSED' as const, generation: 'DRAFT' as const, review: 'REVIEWED' as const },
    ],
  ])('a late job for %s is a no-op', async (_name, state) => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w, state);
    const before = await postmortemOf(incident.id);
    const { provider, run } = harness();
    await run(await requestGeneration(postmortem!.id, incident.id));
    expect(provider.calls).toHaveLength(0);
    expect(await postmortemOf(incident.id)).toEqual(before);
    expect(await events(incident.id)).toHaveLength(0);
    expect(await notifications('POSTMORTEM_GENERATION_FAILED')).toHaveLength(0);
  });

  it('a job for an incident that is not RESOLVED is a no-op', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w, { incident: 'MITIGATING' });
    const { provider, run } = harness();
    await run(await requestGeneration(postmortem!.id, incident.id));
    expect(provider.calls).toHaveLength(0);
    expect((await postmortemOf(incident.id)).generationStatus).toBe('GENERATING');
  });

  it('a missing postmortem or a mismatching incidentId is non-retryable and changes nothing', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const other = await seed(w);
    const { provider, gateway, runAllAttempts } = harness();
    await runAllAttempts(await requestGeneration(randomUUID(), incident.id));
    await runAllAttempts(await requestGeneration(postmortem!.id, other.incident.id));
    expect(provider.calls).toHaveLength(0);
    expect(gateway.deadLetters).toHaveLength(2);
    expect((await postmortemOf(incident.id)).generationStatus).toBe('GENERATING');
  });

  it('two parallel jobs produce one draft', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const first = await requestGeneration(postmortem!.id, incident.id);
    const second = await requestGeneration(postmortem!.id, incident.id);
    const provider = new FakeAiProvider();
    provider.delayMs = 50;
    const { run } = harness(provider);
    await Promise.all([run(first), run(second)]);
    expect(await events(incident.id)).toHaveLength(1);
    expect(await notifications('POSTMORTEM_GENERATED')).toHaveLength(1);
    expect((await postmortemOf(incident.id)).generationStatus).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------------------------
// P1 read
// ---------------------------------------------------------------------------------------------

describe('P1 GET /incidents/:incidentId/postmortem', () => {
  it('returns the generating postmortem with null content to every role of the team', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    for (const token of [w.auth.engineer, w.auth.otherLead, w.auth.otherAdmin, w.auth.level1]) {
      const res = await get(token, incident.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        id: postmortem!.id,
        incidentId: incident.id,
        generationStatus: 'GENERATING',
        reviewStatus: 'PENDING',
        aiGenerated: true,
        summary: null,
        impact: null,
        detection: null,
        timeline: null,
        rootCause: null,
        contributingFactors: null,
        resolution: null,
        correctiveActions: null,
        preventiveActions: null,
        unknowns: null,
        mttrMinutes: null,
        riskLevel: null,
        provenance: { model: null, modelVersion: null, generatedAt: null },
        review: null,
        failureReason: null,
      });
    }
  });

  it('returns a FAILED postmortem with its reason and aiGenerated true', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED', failureReason: 'OUTPUT_INVALID' });
    const res = await get(w.auth.engineer, incident.id);
    expect(res.body.data).toMatchObject({
      generationStatus: 'FAILED',
      aiGenerated: true,
      failureReason: 'OUTPUT_INVALID',
      summary: null,
    });
  });

  it('returns a reviewed postmortem of a CLOSED incident with the reviewer', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, {
      incident: 'CLOSED',
      generation: 'DRAFT',
      review: 'REVIEWED',
    });
    const res = await get(w.auth.engineer, incident.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      reviewStatus: 'REVIEWED',
      aiGenerated: true,
      contributingFactors: 'original factors',
      mttrMinutes: 91,
      review: { reviewedBy: { id: w.level1.id, name: 'Level One' } },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/PROMPT-MARKER|INPUT-MARKER|prompt|inputData/);
  });

  it('a manual postmortem is not aiGenerated', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, {
      incident: 'CLOSED',
      generation: 'DRAFT',
      review: 'REVIEWED',
      manual: true,
    });
    const res = await get(w.auth.engineer, incident.id);
    expect(res.body.data.aiGenerated).toBe(false);
    expect(res.body.data.provenance).toEqual({
      model: null,
      modelVersion: null,
      generatedAt: null,
    });
  });

  it.each(['OPEN', 'MITIGATING'] as const)(
    '404 POSTMORTEM_NOT_FOUND while the incident is %s',
    async (status) => {
      const w = await buildWorld();
      const { incident } = await seed(w, { incident: status, noPostmortem: true });
      const res = await get(w.auth.engineer, incident.id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('POSTMORTEM_NOT_FOUND');
    },
  );

  it('answers the error matrix', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w);
    expect((await get(w.auth.outsider, incident.id)).body.error.code).toBe('TEAM_ACCESS_DENIED');
    const noTeam = await get(w.auth.noTeam, incident.id);
    expect([noTeam.status, noTeam.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    const unknown = await get(w.auth.engineer, randomUUID());
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'INCIDENT_NOT_FOUND']);
    expect((await get(w.auth.engineer, 'not-a-uuid')).status).toBe(422);
    expect((await request(app).get(url(incident.id))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// P2 edit
// ---------------------------------------------------------------------------------------------

describe('P2 edit', () => {
  it('updates only the sent fields; review fields, events and notifications stay untouched', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    const incidentBefore = await incidentOf(incident.id);
    const before = await postmortemOf(incident.id);

    const res = await patch(w.auth.engineer, incident.id, {
      summary: '  new summary  ',
      riskLevel: 'P0',
      unknowns: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      summary: 'new summary',
      riskLevel: 'P0',
      unknowns: null,
      impact: 'original impact',
      reviewStatus: 'PENDING',
      review: null,
      mttrMinutes: 91,
      aiGenerated: true,
    });

    const after = await postmortemOf(incident.id);
    expect(after).toMatchObject({
      summary: 'new summary',
      riskLevel: 'P0',
      unknowns: null,
      impact: before.impact,
      factors: before.factors,
      reviewStatus: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      model: before.model,
      prompt: before.prompt,
      inputData: before.inputData,
      generatedAt: before.generatedAt,
      MTTR: 91,
    });
    expect(await events(incident.id)).toHaveLength(0);
    expect(await db().notification.count()).toBe(0);
    expect(await incidentOf(incident.id)).toEqual(incidentBefore);
  });

  it('maps contributingFactors to the factors column', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    await patch(w.auth.otherLead, incident.id, { contributingFactors: 'new factors' });
    expect((await postmortemOf(incident.id)).factors).toBe('new factors');
  });

  it('every role of the team may edit; the last write wins', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    for (const [index, token] of [w.auth.engineer, w.auth.otherLead, w.auth.otherAdmin].entries()) {
      expect((await patch(token, incident.id, { summary: `write ${index}` })).status).toBe(200);
    }
    expect((await postmortemOf(incident.id)).summary).toBe('write 2');
  });

  it.each([
    ['still generating', { generation: 'GENERATING' as const }],
    ['failed', { generation: 'FAILED' as const }],
    ['already reviewed', { generation: 'DRAFT' as const, review: 'REVIEWED' as const }],
    [
      'closed',
      { incident: 'CLOSED' as const, generation: 'DRAFT' as const, review: 'REVIEWED' as const },
    ],
  ])('409 POSTMORTEM_STATE_INVALID when the postmortem is %s', async (_name, state) => {
    const w = await buildWorld();
    const { incident } = await seed(w, state);
    const before = await postmortemOf(incident.id);
    const res = await patch(w.auth.engineer, incident.id, { summary: 'x' });
    expect([res.status, res.body.error.code]).toEqual([409, 'POSTMORTEM_STATE_INVALID']);
    expect(await postmortemOf(incident.id)).toEqual(before);
  });

  it('404 POSTMORTEM_NOT_FOUND while the incident is not resolved', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { incident: 'MITIGATING', noPostmortem: true });
    const res = await patch(w.auth.engineer, incident.id, { summary: 'x' });
    expect([res.status, res.body.error.code]).toEqual([404, 'POSTMORTEM_NOT_FOUND']);
  });

  it('validates before the state: 422 and 400 win over 409', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'GENERATING' });
    const cases: [object, number, string][] = [
      [{ summary: '' }, 422, 'VALIDATION_FAILED'],
      [{ summary: 'x'.repeat(20_001) }, 422, 'VALIDATION_FAILED'],
      [{ riskLevel: 'P7' }, 422, 'VALIDATION_FAILED'],
      [{}, 422, 'VALIDATION_FAILED'],
      [{ summary: 'x', reviewStatus: 'REVIEWED' }, 422, 'VALIDATION_FAILED'],
      [{ summary: 'x', mttrMinutes: 5 }, 400, 'BAD_REQUEST'],
      [{ summary: 'x', provenance: {} }, 400, 'BAD_REQUEST'],
      [{ summary: 'x', review: {} }, 400, 'BAD_REQUEST'],
    ];
    for (const [body, status, code] of cases) {
      const res = await patch(w.auth.engineer, incident.id, body);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
    }
  });

  it('answers the authorization matrix', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    expect((await patch(w.auth.outsider, incident.id, { summary: 'x' })).body.error.code).toBe(
      'TEAM_ACCESS_DENIED',
    );
    const noTeam = await patch(w.auth.noTeam, incident.id, { summary: 'x' });
    expect([noTeam.status, noTeam.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    expect((await patch(w.auth.engineer, randomUUID(), { summary: 'x' })).body.error.code).toBe(
      'INCIDENT_NOT_FOUND',
    );
    expect((await patch(w.auth.engineer, 'nope', { summary: 'x' })).status).toBe(422);
    expect((await request(app).patch(url(incident.id)).send({ summary: 'x' })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// P3 approve
// ---------------------------------------------------------------------------------------------

describe('P3 approve', () => {
  const approve = (token: Record<string, string>, incidentId: string) =>
    patch(token, incidentId, { reviewStatus: 'REVIEWED' });

  it.each(['level1', 'level2', 'level3', 'fallbackAdmin'] as const)(
    'chain member %s approves: the postmortem is reviewed and the incident closed atomically',
    async (member) => {
      const w = await buildWorld();
      const { incident, postmortem } = await seed(w, { generation: 'DRAFT' });
      const res = await approve(w.auth[member], incident.id);
      const user = {
        level1: w.level1,
        level2: w.level2,
        level3: w.level3,
        fallbackAdmin: w.fallbackAdmin,
      }[member];

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: postmortem!.id,
        reviewStatus: 'REVIEWED',
        generationStatus: 'DRAFT',
        review: { reviewedBy: { id: user.id }, reviewedAt: expect.stringMatching(/Z$/) },
      });
      const row = await postmortemOf(incident.id);
      const closed = await incidentOf(incident.id);
      expect(row).toMatchObject({ reviewStatus: 'REVIEWED', reviewedById: user.id });
      expect(closed).toMatchObject({ status: 'CLOSED', closedById: user.id });
      expect(row.reviewedAt).toEqual(closed.closedTimestamp);

      const audit = await events(incident.id);
      expect(audit.map((event) => [event.eventType, event.actor, event.metadata])).toEqual([
        ['POSTMORTEM_REVIEWED', user.id, { postmortemId: postmortem!.id, reviewedBy: user.id }],
        ['CLOSED', user.id, { closedAt: closed.closedTimestamp!.toISOString() }],
      ]);
      const [reviewed] = await notifications('POSTMORTEM_REVIEWED');
      const [closedNotification] = await notifications('CLOSED');
      expect(reviewed).toMatchObject({
        notificationType: 'INFO',
        idempotencyKey: `POSTMORTEM_REVIEWED:${incident.id}:${audit[0]!.id}`,
      });
      expect(closedNotification).toMatchObject({
        notificationType: 'ALERT',
        idempotencyKey: `CLOSED:${incident.id}:${audit[1]!.id}`,
      });
    },
  );

  it('403 FORBIDDEN for team members outside the chain, whatever their role', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    for (const token of [w.auth.engineer, w.auth.otherLead, w.auth.otherAdmin]) {
      const res = await approve(token, incident.id);
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
    }
    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
    expect(await events(incident.id)).toHaveLength(0);
  });

  it('a second approve is 409 POSTMORTEM_STATE_INVALID and writes no second event', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    expect((await approve(w.auth.level1, incident.id)).status).toBe(200);
    const again = await approve(w.auth.level2, incident.id);
    expect([again.status, again.body.error.code]).toEqual([409, 'POSTMORTEM_STATE_INVALID']);
    expect(await eventTypes(incident.id)).toEqual(['POSTMORTEM_REVIEWED', 'CLOSED']);
    expect(await notifications('CLOSED')).toHaveLength(1);
  });

  it.each([
    ['generating', { generation: 'GENERATING' as const }],
    ['failed', { generation: 'FAILED' as const }],
  ])('409 while the postmortem is %s, and the incident stays RESOLVED', async (_name, state) => {
    const w = await buildWorld();
    const { incident } = await seed(w, state);
    const res = await approve(w.auth.level1, incident.id);
    expect([res.status, res.body.error.code]).toEqual([409, 'POSTMORTEM_STATE_INVALID']);
    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
  });

  it('404 POSTMORTEM_NOT_FOUND while the incident is not resolved', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { incident: 'MITIGATING', noPostmortem: true });
    const res = await approve(w.auth.level1, incident.id);
    expect([res.status, res.body.error.code]).toEqual([404, 'POSTMORTEM_NOT_FOUND']);
  });

  it('answers the rest of the authorization matrix', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    expect((await approve(w.auth.outsider, incident.id)).body.error.code).toBe(
      'TEAM_ACCESS_DENIED',
    );
    const noTeam = await approve(w.auth.noTeam, incident.id);
    expect([noTeam.status, noTeam.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    expect((await approve(w.auth.level1, randomUUID())).body.error.code).toBe('INCIDENT_NOT_FOUND');
  });

  it('a failure inside the transaction leaves the incident not CLOSED and the postmortem unreviewed', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    const real = auditModule.appendAuditEvent;
    jest
      .spyOn(auditModule, 'appendAuditEvent')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('second event fails'));
    const res = await approve(w.auth.level1, incident.id);
    expect(res.status).toBeGreaterThanOrEqual(500);

    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
    expect(await postmortemOf(incident.id)).toMatchObject({
      reviewStatus: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
    });
    expect(await events(incident.id)).toHaveLength(0);
    expect(await db().notification.count()).toBe(0);
    expect(await db().outboxEvent.count()).toBe(0);
  });

  it('a failing notification producer rolls the whole closure back', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    jest
      .spyOn(enqueueModule, 'enqueueNotification')
      .mockRejectedValueOnce(new Error('producer down'));
    expect((await approve(w.auth.level1, incident.id)).status).toBeGreaterThanOrEqual(500);
    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
    expect(await events(incident.id)).toHaveLength(0);
  });

  it('concurrent approvals close once: one 200, one 409, one pair of events', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    const results = await Promise.all([
      approve(w.auth.level1, incident.id),
      approve(w.auth.level3, incident.id),
      approve(w.auth.fallbackAdmin, incident.id),
    ]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(await eventTypes(incident.id)).toEqual(['POSTMORTEM_REVIEWED', 'CLOSED']);
    expect(await notifications('CLOSED')).toHaveLength(1);
  });

  it('approve and edit are serialized by the row lock', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    const [approved, edited] = await Promise.all([
      approve(w.auth.level1, incident.id),
      patch(w.auth.engineer, incident.id, { summary: 'raced edit' }),
    ]);
    expect(approved.status).toBe(200);
    expect([200, 409]).toContain(edited.status);
    const row = await postmortemOf(incident.id);
    expect(row.summary).toBe(edited.status === 200 ? 'raced edit' : 'original summary');
    expect(row.reviewStatus).toBe('REVIEWED');
    expect(await eventTypes(incident.id)).toEqual(['POSTMORTEM_REVIEWED', 'CLOSED']);
  });

  it('after CLOSED the SLICE-05 lifecycle operations are rejected', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'DRAFT' });
    expect((await approve(w.auth.level1, incident.id)).status).toBe(200);
    for (const body of [
      { status: 'ACKNOWLEDGED' },
      { status: 'RESOLVED', resolutionSummary: 'again', serviceConfirmedWorking: true },
    ]) {
      const res = await request(app)
        .patch(`/api/v1/incidents/${incident.id}`)
        .set(w.auth.level1)
        .send(body);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect((await incidentOf(incident.id)).status).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------------------------
// P4 retry
// ---------------------------------------------------------------------------------------------

describe('P4 retry', () => {
  const retry = (token: Record<string, string>, incidentId: string) =>
    patch(token, incidentId, { generationStatus: 'GENERATING' });

  it('moves FAILED back to GENERATING, clears the reason and writes the request in the outbox', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w, { generation: 'FAILED' });
    const res = await retry(w.auth.engineer, incident.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      generationStatus: 'GENERATING',
      failureReason: null,
      summary: null,
    });
    expect(await postmortemOf(incident.id)).toMatchObject({
      generationStatus: 'GENERATING',
      failureReason: null,
    });
    const [event] = await outboxOf('POSTMORTEM_GENERATION_REQUESTED');
    expect(event).toMatchObject({
      aggregateType: 'POSTMORTEM',
      aggregateId: postmortem!.id,
      payload: { postmortemId: postmortem!.id, incidentId: incident.id },
    });
    expect((event!.payload as { requestId?: string }).requestId).toEqual(expect.any(String));
    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
    expect(await events(incident.id)).toHaveLength(0);
    expect(await db().notification.count()).toBe(0);
  });

  it('every role of the team may retry', async () => {
    const w = await buildWorld();
    for (const token of [w.auth.engineer, w.auth.otherLead, w.auth.otherAdmin, w.auth.level1]) {
      const { incident } = await seed(w, { generation: 'FAILED' });
      expect((await retry(token, incident.id)).status).toBe(200);
    }
  });

  it.each([
    ['generating', { generation: 'GENERATING' as const }],
    ['a draft', { generation: 'DRAFT' as const }],
    [
      'a reviewed draft of a CLOSED incident',
      { incident: 'CLOSED' as const, generation: 'DRAFT' as const, review: 'REVIEWED' as const },
    ],
  ])('403 INVALID_ACTION when the postmortem is %s', async (_name, state) => {
    const w = await buildWorld();
    const { incident } = await seed(w, state);
    const before = await postmortemOf(incident.id);
    const res = await retry(w.auth.engineer, incident.id);
    expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    expect(await postmortemOf(incident.id)).toEqual(before);
    expect(await outboxOf('POSTMORTEM_GENERATION_REQUESTED')).toHaveLength(0);
  });

  it('404 POSTMORTEM_NOT_FOUND while the incident is not resolved', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { incident: 'OPEN', noPostmortem: true });
    expect((await retry(w.auth.engineer, incident.id)).body.error.code).toBe(
      'POSTMORTEM_NOT_FOUND',
    );
  });

  it('is idempotent under concurrency: one request event, the others 403', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED' });
    const results = await Promise.all([
      retry(w.auth.engineer, incident.id),
      retry(w.auth.otherLead, incident.id),
      retry(w.auth.level1, incident.id),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 403, 403]);
    expect(await outboxOf('POSTMORTEM_GENERATION_REQUESTED')).toHaveLength(1);
  });

  it('answers the authorization matrix', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED' });
    expect((await retry(w.auth.outsider, incident.id)).body.error.code).toBe('TEAM_ACCESS_DENIED');
    expect((await retry(w.auth.noTeam, incident.id)).body.error.code).toBe('INVALID_ACTION');
    expect((await retry(w.auth.engineer, randomUUID())).body.error.code).toBe('INCIDENT_NOT_FOUND');
    expect((await patch(w.auth.engineer, incident.id, { generationStatus: 'FAILED' })).status).toBe(
      422,
    );
  });

  it('retry then worker: FAILED → GENERATING → DRAFT', async () => {
    const w = await buildWorld();
    const { incident, postmortem } = await seed(w);
    const provider = new FakeAiProvider();
    const { run, runAllAttempts } = harness(provider);
    provider.responses = Array.from({ length: config.executionAttempts }, () => 'bad');
    await runAllAttempts(await requestGeneration(postmortem!.id, incident.id));
    expect((await postmortemOf(incident.id)).generationStatus).toBe('FAILED');

    expect((await retry(w.auth.engineer, incident.id)).status).toBe(200);
    const [retried] = await outboxOf('POSTMORTEM_GENERATION_REQUESTED').then((rows) =>
      rows.slice(-1),
    );
    provider.defaultText = validText();
    await run(retried!.id);

    const res = await get(w.auth.engineer, incident.id);
    expect(res.body.data).toMatchObject({
      generationStatus: 'DRAFT',
      failureReason: null,
      mttrMinutes: 91,
    });
    expect(await db().postmortem.count()).toBe(1);
    expect(await eventTypes(incident.id)).toEqual(['POSTMORTEM_GENERATED']);
  });
});

// ---------------------------------------------------------------------------------------------
// P5 manual create
// ---------------------------------------------------------------------------------------------

describe('P5 POST manual create', () => {
  it.each(['level1', 'level2', 'level3', 'fallbackAdmin'] as const)(
    'chain member %s writes the postmortem of a FAILED generation and closes the incident',
    async (member) => {
      const w = await buildWorld();
      const { incident, postmortem } = await seed(w, { generation: 'FAILED' });
      const user = {
        level1: w.level1,
        level2: w.level2,
        level3: w.level3,
        fallbackAdmin: w.fallbackAdmin,
      }[member];
      const res = await post(w.auth[member], incident.id, {
        ...CONTENT,
        unknowns: 'open question',
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        id: postmortem!.id,
        generationStatus: 'DRAFT',
        reviewStatus: 'REVIEWED',
        aiGenerated: false,
        summary: 'edited summary',
        contributingFactors: 'factors',
        unknowns: 'open question',
        mttrMinutes: 91,
        riskLevel: 'P2',
        provenance: { model: null, modelVersion: null, generatedAt: null },
        review: { reviewedBy: { id: user.id } },
        failureReason: null,
      });
      expect(await db().postmortem.count()).toBe(1);
      expect(await postmortemOf(incident.id)).toMatchObject({
        id: postmortem!.id,
        failureReason: null,
        model: null,
        modelVersion: null,
        prompt: null,
        inputData: null,
        generatedAt: null,
        reviewedById: user.id,
        MTTR: 91,
      });
      expect(await incidentOf(incident.id)).toMatchObject({
        status: 'CLOSED',
        closedById: user.id,
      });
      expect(await eventTypes(incident.id)).toEqual(['POSTMORTEM_REVIEWED', 'CLOSED']);
      expect((await notifications('POSTMORTEM_REVIEWED'))[0]).toMatchObject({
        notificationType: 'INFO',
      });
      expect((await notifications('CLOSED'))[0]).toMatchObject({ notificationType: 'ALERT' });
    },
  );

  it('stores a null unknowns when it is omitted or null', async () => {
    const w = await buildWorld();
    for (const extra of [{}, { unknowns: null }]) {
      const { incident } = await seed(w, { generation: 'FAILED' });
      const res = await post(w.auth.level1, incident.id, { ...CONTENT, ...extra });
      expect(res.status).toBe(201);
      expect(res.body.data.unknowns).toBeNull();
    }
  });

  it('a repeat is 403 INVALID_ACTION: the incident is CLOSED', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED' });
    expect((await post(w.auth.level1, incident.id, CONTENT)).status).toBe(201);
    const again = await post(w.auth.level1, incident.id, CONTENT);
    expect([again.status, again.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    expect(await eventTypes(incident.id)).toEqual(['POSTMORTEM_REVIEWED', 'CLOSED']);
  });

  it('403 FORBIDDEN outside the chain', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED' });
    for (const token of [w.auth.engineer, w.auth.otherLead, w.auth.otherAdmin]) {
      const res = await post(token, incident.id, CONTENT);
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
    }
    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
  });

  it.each([
    ['generating', { generation: 'GENERATING' as const }],
    ['a draft', { generation: 'DRAFT' as const }],
    [
      'no postmortem yet (incident not resolved)',
      { incident: 'MITIGATING' as const, noPostmortem: true },
    ],
  ])('403 INVALID_ACTION when the postmortem is %s', async (_name, state) => {
    const w = await buildWorld();
    const { incident } = await seed(w, state);
    const res = await post(w.auth.level1, incident.id, CONTENT);
    expect([res.status, res.body.error.code]).toEqual([403, 'INVALID_ACTION']);
    expect((await incidentOf(incident.id)).status).toBe((state as Seed).incident ?? 'RESOLVED');
  });

  it('validates before authorization and state: 422 and 400', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'GENERATING' });
    const missing: Record<string, unknown> = { ...CONTENT };
    delete missing.rootCause;
    const cases: [object, number, string][] = [
      [{}, 422, 'VALIDATION_FAILED'],
      [missing, 422, 'VALIDATION_FAILED'],
      [{ ...CONTENT, riskLevel: 'P9' }, 422, 'VALIDATION_FAILED'],
      [{ ...CONTENT, summary: 'x'.repeat(20_001) }, 422, 'VALIDATION_FAILED'],
      [{ ...CONTENT, mttrMinutes: 1 }, 400, 'BAD_REQUEST'],
    ];
    for (const token of [w.auth.level1, w.auth.engineer]) {
      for (const [body, status, code] of cases) {
        const res = await post(token, incident.id, body);
        expect([res.status, res.body.error.code]).toEqual([status, code]);
      }
    }
  });

  it('answers the authorization matrix', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED' });
    expect((await post(w.auth.outsider, incident.id, CONTENT)).body.error.code).toBe(
      'TEAM_ACCESS_DENIED',
    );
    expect((await post(w.auth.noTeam, incident.id, CONTENT)).body.error.code).toBe(
      'INVALID_ACTION',
    );
    expect((await post(w.auth.level1, randomUUID(), CONTENT)).body.error.code).toBe(
      'INCIDENT_NOT_FOUND',
    );
    expect((await post(w.auth.level1, 'nope', CONTENT)).status).toBe(422);
    expect((await request(app).post(url(incident.id)).send(CONTENT)).status).toBe(401);
  });

  it('a failure inside the transaction leaves the FAILED row and the incident untouched', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED' });
    const before = await postmortemOf(incident.id);
    const real = auditModule.appendAuditEvent;
    jest
      .spyOn(auditModule, 'appendAuditEvent')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('second event fails'));
    expect((await post(w.auth.level1, incident.id, CONTENT)).status).toBeGreaterThanOrEqual(500);
    expect(await postmortemOf(incident.id)).toEqual(before);
    expect((await incidentOf(incident.id)).status).toBe('RESOLVED');
    expect(await events(incident.id)).toHaveLength(0);
  });

  it('concurrent creates close once; and P5 races P3 safely', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { generation: 'FAILED' });
    const results = await Promise.all([
      post(w.auth.level1, incident.id, CONTENT),
      post(w.auth.level2, incident.id, CONTENT),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 403]);
    expect(await eventTypes(incident.id)).toEqual(['POSTMORTEM_REVIEWED', 'CLOSED']);
  });
});

// ---------------------------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------------------------

describe('resolve → generate → edit → approve', () => {
  it('runs end to end through the API and the worker', async () => {
    const w = await buildWorld();
    const { incident } = await seed(w, { incident: 'MITIGATING', noPostmortem: true });
    await db().incident.update({
      where: { id: incident.id },
      data: { currentAssigneeId: w.engineer.id },
    });

    const resolve = await request(app)
      .patch(`/api/v1/incidents/${incident.id}`)
      .set(w.auth.level1)
      .send({
        status: 'RESOLVED',
        resolutionSummary: 'Rolled back',
        serviceConfirmedWorking: true,
      });
    expect(resolve.status).toBe(200);

    const generating = await get(w.auth.engineer, incident.id);
    expect(generating.body.data).toMatchObject({ generationStatus: 'GENERATING', summary: null });

    const [requested] = await outboxOf('POSTMORTEM_GENERATION_REQUESTED');
    const { provider, run } = harness();
    await run(requested!.id);
    expect(provider.calls).toHaveLength(1);
    expect(JSON.stringify(provider.calls[0])).not.toContain('Rolled back');

    const draft = await get(w.auth.engineer, incident.id);
    expect(draft.body.data).toMatchObject({ generationStatus: 'DRAFT', reviewStatus: 'PENDING' });
    expect(
      (await patch(w.auth.engineer, incident.id, { rootCause: 'Human-corrected cause' })).status,
    ).toBe(200);
    expect(
      (await patch(w.auth.engineer, incident.id, { reviewStatus: 'REVIEWED' })).body.error.code,
    ).toBe('FORBIDDEN');
    expect((await patch(w.auth.level1, incident.id, { reviewStatus: 'REVIEWED' })).status).toBe(
      200,
    );

    const done = await get(w.auth.engineer, incident.id);
    expect(done.body.data).toMatchObject({
      reviewStatus: 'REVIEWED',
      rootCause: 'Human-corrected cause',
      aiGenerated: true,
    });
    expect((await incidentOf(incident.id)).status).toBe('CLOSED');
    expect(await eventTypes(incident.id)).toEqual([
      'RESOLVED',
      'POSTMORTEM_GENERATED',
      'POSTMORTEM_REVIEWED',
      'CLOSED',
    ]);
  });
});
