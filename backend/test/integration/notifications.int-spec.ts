import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { getPrisma, runInTransaction } from '../../src/infra/db/prisma';
import { NonRetryableJobError, RetryableJobError } from '../../src/infra/jobs/errors';
import { OUTBOX_EVENT_TYPES } from '../../src/infra/jobs/events';
import { enqueueOutbox } from '../../src/infra/jobs/outbox';
import { processOutboxJob } from '../../src/infra/jobs/processor';
import { runRelayCycle } from '../../src/infra/jobs/relay';
import { getRedis } from '../../src/infra/redis/redis';
import {
  NOTIFICATION_CATALOG,
  type NotificationEventType,
} from '../../src/modules/notifications/catalog';
import { createNotificationProcessor } from '../../src/modules/notifications/delivery.processor';
import { EmailProviderError } from '../../src/modules/notifications/email-provider';
import {
  enqueueNotification,
  type EnqueueNotificationInput,
} from '../../src/modules/notifications/enqueue-notification';
import { FakeEmailProvider } from '../../src/modules/notifications/fake-email-provider';
import { NotificationContractError } from '../../src/modules/notifications/record-notification';
import * as sessions from '../../src/modules/identity/auth/session.repository';
import { buildTestApp } from '../helpers/app';
import { createAlertSource } from '../helpers/incidents';
import { bearer, createTeam, createUser, resetState, sessionFor } from '../helpers/identity';
import { FakeGateway, testJobsConfig } from '../helpers/jobs';

// Everything the code under test logs is captured, to prove no address or secret reaches a log.
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
const QUEUE = 'notifications';

beforeEach(async () => {
  mockLogs.length = 0;
  await resetState();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  getRedis().disconnect();
});

type World = Awaited<ReturnType<typeof buildWorld>>;

/** Team A (the incident's), a distinct level3 and fallback admin, an assignee elsewhere. */
async function buildWorld() {
  const teamA = await createTeam();
  const teamB = await createTeam();
  const fallbackAdmin = await createUser({ role: 'ADMIN', name: 'Fallback' });
  const otherAdmin = await createUser({ role: 'ADMIN', name: 'Other Admin' });
  const deactivatedAdmin = await createUser({ role: 'ADMIN', status: 'DEACTIVATED' });
  const lead = await createUser({ role: 'TEAM_LEAD', teamId: teamA.id });
  const engineer = await createUser({ role: 'ENGINEER', teamId: teamA.id });
  const level3 = await createUser({ role: 'TEAM_LEAD', teamId: teamA.id });
  const inactiveMember = await createUser({
    role: 'ENGINEER',
    teamId: teamA.id,
    status: 'DEACTIVATED',
  });
  const outsider = await createUser({ role: 'ENGINEER', teamId: teamB.id });

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
  const incident = await db().incident.create({
    data: {
      title: 'Checkout is down',
      description: 'description',
      severity: 'P1',
      status: 'RESOLVED',
      teamId: teamA.id,
      affectedServiceId: service.id,
      resolvedById: engineer.id,
    },
  });
  const alertSource = await createAlertSource('Datadog');
  return {
    teamA,
    fallbackAdmin,
    otherAdmin,
    deactivatedAdmin,
    lead,
    engineer,
    level3,
    inactiveMember,
    outsider,
    service,
    incident,
    alertSource,
  };
}

const ids = (...users: { id: string }[]) => users.map((user) => user.id).sort();

function inputFor(
  w: World,
  eventType: NotificationEventType,
  occurrenceId: string = randomUUID(),
): EnqueueNotificationInput {
  switch (NOTIFICATION_CATALOG[eventType].scope) {
    case 'INCIDENT':
      return { eventType, occurrenceId, incidentId: w.incident.id, subjectUserId: w.outsider.id };
    case 'TEAM':
      return { eventType, occurrenceId, teamId: w.teamA.id };
    case 'SERVICE':
      return { eventType, occurrenceId, serviceId: w.service.id };
    case 'ADMIN':
      return { eventType, occurrenceId, alertSourceId: w.alertSource.id };
  }
}

const enqueue = (input: EnqueueNotificationInput) =>
  runInTransaction((tx) => enqueueNotification(tx, input));

function expectedRecipients(w: World, eventType: NotificationEventType): string[] {
  const members = [w.lead, w.engineer, w.level3]; // active members of team A
  switch (eventType) {
    case 'ASSIGNED':
    case 'AI_INVESTIGATION_COMPLETED':
      return ids(w.outsider, w.level3, w.fallbackAdmin);
    case 'AI_TRIAGE_COMPLETED':
      return ids(w.level3, w.fallbackAdmin);
    case 'POSTMORTEM_GENERATED':
    case 'POSTMORTEM_REVIEWED':
      return ids(w.engineer, w.level3, w.fallbackAdmin);
    case 'POSTMORTEM_GENERATION_FAILED':
      return ids(w.engineer, w.level3);
    case 'TEAM_UPDATED':
    case 'TEAM_DEACTIVATED':
      return ids(...members);
    case 'ALERT_SOURCE_BLOCKED':
    case 'INVESTIGATION_REQUEST_BLOCKED':
      return ids(w.fallbackAdmin, w.otherAdmin);
    default:
      return ids(...members, w.fallbackAdmin);
  }
}

describe('recipient resolution (SLICE-09 §4.3)', () => {
  it.each(Object.keys(NOTIFICATION_CATALOG) as NotificationEventType[])(
    '%s: right type, exactly the right active recipients',
    async (eventType) => {
      const w = await buildWorld();
      const result = await enqueue(inputFor(w, eventType));
      expect(result.created).toBe(true);

      const row = await db().notification.findUniqueOrThrow({
        where: { id: result.notificationId! },
      });
      expect(row.notificationType).toBe(NOTIFICATION_CATALOG[eventType].type);
      expect(row.eventType).toBe(eventType);
      expect([...row.recipients].sort()).toEqual(expectedRecipients(w, eventType));
      expect(row.recipients).not.toContain(w.inactiveMember.id);
      expect(row.recipients).not.toContain(w.deactivatedAdmin.id);
      expect(new Set(row.recipients).size).toBe(row.recipients.length);
      expect(row.deliveryStatus).toBe('REQUESTED');
    },
  );

  it('stores the recipients at enqueue time; later user changes do not alter the row', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    const before = (await db().notification.findUniqueOrThrow({ where: { id: notificationId! } }))
      .recipients;

    await db().user.update({ where: { id: w.lead.id }, data: { status: 'DEACTIVATED' } });
    await db().user.update({ where: { id: w.engineer.id }, data: { teamId: null } });

    const after = await db().notification.findUniqueOrThrow({ where: { id: notificationId! } });
    expect(after.recipients).toEqual(before);
  });
});

describe('enqueueNotification (producer contract)', () => {
  it('commits the row and its NOTIFICATION_REQUESTED event with the producer', async () => {
    const w = await buildWorld();
    const requestId = 'req-1';
    const { notificationId, created } = await enqueue({
      ...inputFor(w, 'ACKNOWLEDGED', 'audit-1'),
      requestId,
    });
    expect(created).toBe(true);

    const row = await db().notification.findUniqueOrThrow({ where: { id: notificationId! } });
    expect(row).toMatchObject({
      deliveryStatus: 'REQUESTED',
      notificationType: 'ALERT',
      incidentId: w.incident.id,
      idempotencyKey: `ACKNOWLEDGED:${w.incident.id}:audit-1`,
    });
    const events = await db().outboxEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'NOTIFICATION_REQUESTED',
      aggregateId: notificationId,
      status: 'PENDING',
    });
    expect(events[0].payload).toMatchObject({
      kind: 'ACKNOWLEDGED',
      notificationId,
      incidentId: w.incident.id,
      requestId,
    });
  });

  it('leaves neither the row nor the event when the producer rolls back', async () => {
    const w = await buildWorld();
    await expect(
      runInTransaction(async (tx) => {
        await enqueueNotification(tx, inputFor(w, 'ASSIGNED'));
        throw new Error('producer failed after enqueue');
      }),
    ).rejects.toThrow('producer failed');
    expect(await db().notification.count()).toBe(0);
    expect(await db().outboxEvent.count()).toBe(0);
  });

  it('returns created = false for the same occurrence and keeps one row', async () => {
    const w = await buildWorld();
    const first = await enqueue(inputFor(w, 'ASSIGNED', 'audit-1'));
    const second = await enqueue(inputFor(w, 'ASSIGNED', 'audit-1'));
    expect(first.created).toBe(true);
    expect(second).toEqual({ notificationId: null, created: false });
    expect(await db().notification.count()).toBe(1);
    expect(await db().outboxEvent.count()).toBe(1);
  });

  it('decides concurrent duplicates in the database: exactly one wins', async () => {
    const w = await buildWorld();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => enqueue(inputFor(w, 'SLA_WARNING', 'RESPONSE_WARNING'))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db().notification.count()).toBe(1);
    expect(await db().outboxEvent.count()).toBe(1);
  });

  it('records two different ASSIGNED occurrences as two notifications', async () => {
    const w = await buildWorld();
    await enqueue(inputFor(w, 'ASSIGNED', 'audit-1'));
    await enqueue(inputFor(w, 'ASSIGNED', 'audit-2'));
    expect(await db().notification.count()).toBe(2);
    expect(await db().outboxEvent.count()).toBe(2);
  });

  it('stores a FAILED row (NO_RECIPIENTS) and writes no event when nobody is active', async () => {
    const w = await buildWorld();
    await db().user.updateMany({ data: { status: 'DEACTIVATED' } });
    const { notificationId, created } = await enqueue(inputFor(w, 'RESOLVED'));
    expect(created).toBe(true);

    const row = await db().notification.findUniqueOrThrow({ where: { id: notificationId! } });
    expect(row).toMatchObject({
      deliveryStatus: 'FAILED',
      recipients: [],
      providerResponse: { reason: 'NO_RECIPIENTS' },
    });
    expect(await db().outboxEvent.count()).toBe(0);
  });

  it('rejects a call that misses required context', async () => {
    const w = await buildWorld();
    await expect(
      enqueue({ eventType: 'ASSIGNED', occurrenceId: 'a', incidentId: w.incident.id }),
    ).rejects.toBeInstanceOf(NotificationContractError);
    await expect(enqueue({ eventType: 'RESOLVED', occurrenceId: 'a' })).rejects.toBeInstanceOf(
      NotificationContractError,
    );
    await expect(
      enqueue({ eventType: 'RESOLVED', occurrenceId: 'a', incidentId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotificationContractError);
    expect(await db().notification.count()).toBe(0);
  });
});

describe('delivery worker (SLICE-09 §4.4)', () => {
  const email = (user: { email: string }) => user.email;

  function harness(provider = new FakeEmailProvider(), overrides = {}) {
    const gateway = new FakeGateway();
    const processor = createNotificationProcessor({
      provider,
      processingWindowMs: config.processingWindowMs,
      maxAttempts: config.executionAttempts,
      ...overrides,
    });
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
    return { provider, processor, run, gateway };
  }

  const outboxOf = async (notificationId: string) =>
    db().outboxEvent.findFirstOrThrow({ where: { aggregateId: notificationId } });
  const notification = (id: string) => db().notification.findUniqueOrThrow({ where: { id } });
  const notified = () => db().auditEvent.findMany({ where: { eventType: 'NOTIFIED' } });

  it('delivers one email to all recipients, completes the row and audits NOTIFIED', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    const { provider, run } = harness();

    await run((await outboxOf(notificationId!)).id);

    expect(provider.sent).toHaveLength(1);
    expect([...provider.sent[0].to].sort()).toEqual(
      [w.lead, w.engineer, w.level3, w.fallbackAdmin].map(email).sort(),
    );
    expect(provider.sent[0].subject).toBe('[IMS] Incident resolved: Checkout is down');
    expect(provider.sent[0].idempotencyKey).toBe(
      (await notification(notificationId!)).idempotencyKey,
    );

    const row = await notification(notificationId!);
    expect(row).toMatchObject({
      deliveryStatus: 'COMPLETED',
      attemptCount: 1,
      providerResponse: { provider: 'fake', accepted: 4 },
    });
    expect(row.lastAttemptTimestamp).not.toBeNull();
    expect((await outboxOf(notificationId!)).status).toBe('SUCCESS');

    const audit = await notified();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ incidentId: w.incident.id, actor: null });
    expect([...(audit[0].metadata as { recipients: string[] }).recipients].sort()).toEqual(
      [...row.recipients].sort(),
    );
    expect(JSON.stringify(row.providerResponse)).not.toContain('@');
  });

  it('writes no NOTIFIED for team, service and alert-source notices', async () => {
    const w = await buildWorld();
    const { provider, run } = harness();
    for (const eventType of ['TEAM_UPDATED', 'SERVICE_UPDATED', 'ALERT_SOURCE_BLOCKED'] as const) {
      const { notificationId } = await enqueue(inputFor(w, eventType));
      await run((await outboxOf(notificationId!)).id);
      expect((await notification(notificationId!)).deliveryStatus).toBe('COMPLETED');
    }
    expect(provider.sent).toHaveLength(3);
    expect(provider.sent[2].text).toContain('Alert source: Datadog');
    expect(await notified()).toHaveLength(0);
  });

  it('puts a retryable failure back to REQUESTED, then delivers once on the retry', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'ACKNOWLEDGED'));
    const outboxId = (await outboxOf(notificationId!)).id;
    const provider = new FakeEmailProvider();
    provider.failures = [new EmailProviderError(true, 'SERVICE_UNAVAILABLE', { statusCode: 503 })];
    const { run } = harness(provider);

    await expect(run(outboxId, 0)).rejects.toBeInstanceOf(RetryableJobError);
    expect(await notification(notificationId!)).toMatchObject({
      deliveryStatus: 'REQUESTED',
      attemptCount: 1,
      providerResponse: { statusCode: 503 },
    });
    expect(provider.sent).toHaveLength(0);
    expect(await notified()).toHaveLength(0);

    await run(outboxId, 1);
    expect(await notification(notificationId!)).toMatchObject({
      deliveryStatus: 'COMPLETED',
      attemptCount: 2,
    });
    expect(provider.sent).toHaveLength(1);
    expect((await outboxOf(notificationId!)).status).toBe('SUCCESS');
    expect(await notified()).toHaveLength(1);
  });

  it('ends FAILED and DEAD_LETTER when the attempts are exhausted, without touching the incident', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    const outboxId = (await outboxOf(notificationId!)).id;
    const provider = new FakeEmailProvider();
    provider.failures = Array.from(
      { length: config.executionAttempts },
      () => new EmailProviderError(true, 'NETWORK', { error: 'NETWORK' }),
    );
    const { run, gateway } = harness(provider);
    const incidentBefore = await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } });
    const auditBefore = await db().auditEvent.count();

    for (let attempt = 0; attempt < config.executionAttempts; attempt += 1) {
      await expect(run(outboxId, attempt)).rejects.toBeDefined();
      const row = await notification(notificationId!);
      expect(row.attemptCount).toBe(attempt + 1);
      expect(row.deliveryStatus).toBe(
        attempt + 1 < config.executionAttempts ? 'REQUESTED' : 'FAILED',
      );
    }

    expect((await outboxOf(notificationId!)).status).toBe('DEAD_LETTER');
    expect(gateway.deadLetters).toHaveLength(1);
    expect(provider.sent).toHaveLength(0);
    expect(await db().auditEvent.count()).toBe(auditBefore); // failures write no audit event
    expect(await db().incident.findUniqueOrThrow({ where: { id: w.incident.id } })).toEqual(
      incidentBefore,
    );
  });

  it('fails at once on a non-retryable provider error', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    const provider = new FakeEmailProvider();
    provider.failures = [new EmailProviderError(false, 'CONFIGURATION', { statusCode: 401 })];
    const { run } = harness(provider);

    await expect(run((await outboxOf(notificationId!)).id)).rejects.toBeDefined();
    expect(await notification(notificationId!)).toMatchObject({
      deliveryStatus: 'FAILED',
      attemptCount: 1,
      providerResponse: { statusCode: 401 },
    });
    expect((await outboxOf(notificationId!)).status).toBe('DEAD_LETTER');
  });

  it('sends once when two jobs race for the same notification', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    const provider = new FakeEmailProvider();
    provider.sendDelayMs = 100;
    const { processor } = harness(provider);
    const input = (n: number) => ({
      outboxEventId: randomUUID(),
      eventType: 'NOTIFICATION_REQUESTED',
      aggregateType: 'NOTIFICATION',
      aggregateId: notificationId!,
      payload: { kind: 'RESOLVED', notificationId: notificationId! },
      attempt: n,
    });

    const results = await Promise.allSettled([processor(input(1)), processor(input(1))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(RetryableJobError);
    expect(provider.sent).toHaveLength(1);
    expect(await notified()).toHaveLength(1);

    await processor(input(2)); // the retry of the loser finds COMPLETED and does nothing
    expect(provider.sent).toHaveLength(1);
    expect(await notified()).toHaveLength(1);
  });

  it('re-claims a RUNNING row whose attempt is older than the processing window', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    const stale = new Date(Date.now() - config.processingWindowMs - 1000);
    await db().notification.update({
      where: { id: notificationId! },
      data: { deliveryStatus: 'RUNNING', lastAttemptTimestamp: stale },
    });
    const { provider, run } = harness();

    await run((await outboxOf(notificationId!)).id);
    expect(provider.sent).toHaveLength(1);
    expect((await notification(notificationId!)).deliveryStatus).toBe('COMPLETED');
  });

  it('leaves a recently claimed RUNNING row alone and asks for a retry', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    await db().notification.update({
      where: { id: notificationId! },
      data: { deliveryStatus: 'RUNNING', lastAttemptTimestamp: new Date() },
    });
    const { provider, processor } = harness();

    await expect(
      processor({
        outboxEventId: randomUUID(),
        eventType: 'NOTIFICATION_REQUESTED',
        aggregateType: 'NOTIFICATION',
        aggregateId: notificationId!,
        payload: { kind: 'RESOLVED', notificationId: notificationId! },
        attempt: 1,
      }),
    ).rejects.toBeInstanceOf(RetryableJobError);
    expect(provider.sent).toHaveLength(0);
    expect((await notification(notificationId!)).deliveryStatus).toBe('RUNNING');
  });

  it('does nothing for a COMPLETED row and refuses a FAILED one', async () => {
    const w = await buildWorld();
    const done = await enqueue(inputFor(w, 'RESOLVED', 'a'));
    const failed = await enqueue(inputFor(w, 'RESOLVED', 'b'));
    await db().notification.update({
      where: { id: done.notificationId! },
      data: { deliveryStatus: 'COMPLETED', attemptCount: 1 },
    });
    await db().notification.update({
      where: { id: failed.notificationId! },
      data: { deliveryStatus: 'FAILED' },
    });
    const { provider, processor } = harness();
    const call = (id: string) =>
      processor({
        outboxEventId: randomUUID(),
        eventType: 'NOTIFICATION_REQUESTED',
        aggregateType: 'NOTIFICATION',
        aggregateId: id,
        payload: { kind: 'RESOLVED', notificationId: id },
        attempt: 1,
      });

    await expect(call(done.notificationId!)).resolves.toBeUndefined();
    await expect(call(failed.notificationId!)).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(provider.sent).toHaveLength(0);
    expect(await notified()).toHaveLength(0);
  });

  it('dead-letters a payload that names no notification', async () => {
    const { run } = harness();
    const id = await runInTransaction((tx) =>
      enqueueOutbox(tx, {
        eventType: OUTBOX_EVENT_TYPES.NOTIFICATION_REQUESTED,
        aggregateType: 'NOTIFICATION',
        aggregateId: randomUUID(),
        payload: { kind: 'RESOLVED', notificationId: randomUUID() },
      }),
    );
    await expect(run(id)).rejects.toBeDefined();
    expect(await db().outboxEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'DEAD_LETTER',
      errorClass: 'RESOURCE_NOT_FOUND',
    });
  });

  it('marks a row whose recipients cannot be reached FAILED (NO_RECIPIENTS) without sending', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    await db().notification.update({ where: { id: notificationId! }, data: { recipients: [] } });
    const { provider, run } = harness();

    await run((await outboxOf(notificationId!)).id);
    expect(await notification(notificationId!)).toMatchObject({
      deliveryStatus: 'FAILED',
      providerResponse: { reason: 'NO_RECIPIENTS' },
    });
    expect(provider.sent).toHaveLength(0);
    expect((await outboxOf(notificationId!)).status).toBe('SUCCESS');
  });

  it('keeps addresses, credentials and message text out of the logs', async () => {
    const w = await buildWorld();
    const { notificationId } = await enqueue(inputFor(w, 'RESOLVED'));
    const provider = new FakeEmailProvider();
    provider.failures = [new EmailProviderError(true, 'NETWORK', { error: 'NETWORK' })];
    const { run } = harness(provider);
    const outboxId = (await outboxOf(notificationId!)).id;

    await expect(run(outboxId, 0)).rejects.toBeDefined();
    await run(outboxId, 1);

    const logged = JSON.stringify(mockLogs);
    expect(logged.length).toBeGreaterThan(2);
    for (const user of [w.lead, w.engineer, w.level3, w.fallbackAdmin]) {
      expect(logged).not.toContain(user.email);
    }
    expect(logged).not.toContain('Checkout is down');
  });

  describe('admin notice written by SLICE-03 before this slice (no notificationId)', () => {
    const writeLegacyNotice = (alertSourceId: string) =>
      runInTransaction((tx) =>
        enqueueOutbox(tx, {
          eventType: OUTBOX_EVENT_TYPES.NOTIFICATION_REQUESTED,
          aggregateType: 'ALERT_SOURCE',
          aggregateId: alertSourceId,
          payload: {
            kind: 'ALERT_SOURCE_BLOCKED',
            alertSourceId,
            attemptCount: 5,
            requestId: 'req-legacy',
          },
        }),
      );

    it('stores the Notification itself and emails all active Admins', async () => {
      const w = await buildWorld();
      const outboxId = await writeLegacyNotice(w.alertSource.id);
      const { provider, run } = harness();

      await run(outboxId);

      const rows = await db().notification.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventType: 'ALERT_SOURCE_BLOCKED',
        notificationType: 'ALERT',
        deliveryStatus: 'COMPLETED',
        incidentId: null,
        idempotencyKey: `ALERT_SOURCE_BLOCKED:${w.alertSource.id}:${outboxId}`,
      });
      expect([...rows[0].recipients].sort()).toEqual(ids(w.fallbackAdmin, w.otherAdmin));
      expect(provider.sent).toHaveLength(1);
      expect([...provider.sent[0].to].sort()).toEqual(
        [w.fallbackAdmin, w.otherAdmin].map(email).sort(),
      );
      expect(await notified()).toHaveLength(0);
      expect((await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(
        'SUCCESS',
      );
    });

    it('is idempotent on the outbox event: a redelivery sends nothing more', async () => {
      const w = await buildWorld();
      const outboxId = await writeLegacyNotice(w.alertSource.id);
      const { provider, processor } = harness();
      const input = {
        outboxEventId: outboxId,
        eventType: 'NOTIFICATION_REQUESTED',
        aggregateType: 'ALERT_SOURCE',
        aggregateId: w.alertSource.id,
        payload: { kind: 'ALERT_SOURCE_BLOCKED', alertSourceId: w.alertSource.id },
        attempt: 1,
      };

      await processor(input);
      await processor({ ...input, attempt: 1 });

      expect(await db().notification.count()).toBe(1);
      expect(provider.sent).toHaveLength(1);
    });

    it('stores a FAILED row and sends nothing when no Admin is active', async () => {
      const w = await buildWorld();
      await db().user.updateMany({ where: { role: 'ADMIN' }, data: { status: 'DEACTIVATED' } });
      const outboxId = await writeLegacyNotice(w.alertSource.id);
      const { provider, run } = harness();

      await run(outboxId);
      expect(await db().notification.findFirstOrThrow()).toMatchObject({
        deliveryStatus: 'FAILED',
        recipients: [],
        providerResponse: { reason: 'NO_RECIPIENTS' },
      });
      expect(provider.sent).toHaveLength(0);
    });

    it('dead-letters any other payload without a notificationId', async () => {
      const { run } = harness();
      const outboxId = await runInTransaction((tx) =>
        enqueueOutbox(tx, {
          eventType: OUTBOX_EVENT_TYPES.NOTIFICATION_REQUESTED,
          aggregateType: 'ALERT_SOURCE',
          aggregateId: randomUUID(),
          payload: { kind: 'SOMETHING_ELSE', requestId: 'req-x' },
        }),
      );
      await expect(run(outboxId)).rejects.toBeDefined();
      expect(await db().outboxEvent.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({
        status: 'DEAD_LETTER',
        errorClass: 'INVALID_PAYLOAD',
      });
      expect(await db().notification.count()).toBe(0);
    });
  });
});

describe('retrofit of T4, S4 and S7 (SLICE-09 §4.9)', () => {
  async function teamWorld(options: { withService: boolean } = { withService: true }) {
    const team = await createTeam();
    const admin = await sessionFor(app, 'ADMIN', team.id);
    const lead = await createUser({ role: 'TEAM_LEAD', teamId: team.id });
    const engineer = await createUser({ role: 'ENGINEER', teamId: team.id });
    const inactive = await createUser({ role: 'ENGINEER', teamId: team.id, status: 'DEACTIVATED' });
    const fallback = await createUser({ role: 'ADMIN', teamId: team.id });
    const policy = await db().escalationPolicy.create({
      data: {
        level1Id: engineer.id,
        level2Id: engineer.id,
        level3Id: lead.id,
        fallbackAdminId: fallback.id,
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
    if (!options.withService) {
      await db().appService.delete({ where: { id: service.id } });
    }
    return { team, admin, lead, engineer, inactive, fallback, policy, service };
  }

  const rows = () => db().notification.findMany({ orderBy: { createdAt: 'asc' } });
  const auditOf = (eventType: string) =>
    db().auditEvent.findMany({ where: { eventType: eventType as never } });

  it('T4 update: one TEAM_UPDATED to the active members only (no fallback admin)', async () => {
    const t = await teamWorld();
    const res = await request(app)
      .patch(`/api/v1/identity/teams/${t.team.id}`)
      .set(bearer(t.admin.token))
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    const [audit] = await auditOf('TEAM_UPDATED');
    expect(row).toMatchObject({
      eventType: 'TEAM_UPDATED',
      notificationType: 'INFO',
      incidentId: null,
      idempotencyKey: `TEAM_UPDATED:${t.team.id}:${audit.id}`,
    });
    expect([...row.recipients].sort()).toEqual(ids(t.admin.user, t.lead, t.engineer, t.fallback));
    expect(await db().outboxEvent.count({ where: { eventType: 'NOTIFICATION_REQUESTED' } })).toBe(
      1,
    );
  });

  it('T4 deactivation: TEAM_DEACTIVATED goes to the members as they were before the detach', async () => {
    const t = await teamWorld({ withService: false });
    const res = await request(app)
      .patch(`/api/v1/identity/teams/${t.team.id}`)
      .set(bearer(t.admin.token))
      .send({ status: 'DEACTIVATED' });
    expect(res.status).toBe(200);

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ eventType: 'TEAM_DEACTIVATED', notificationType: 'INFO' });
    expect([...row.recipients].sort()).toEqual(ids(t.admin.user, t.lead, t.engineer, t.fallback));
    // ... and they really are detached afterwards.
    expect(await db().user.count({ where: { teamId: t.team.id } })).toBe(0);
  });

  it('S4 update: one SERVICE_UPDATED to the team members and the fallback admin', async () => {
    const t = await teamWorld();
    const res = await request(app)
      .patch(`/api/v1/services/${t.service.id}`)
      .set(bearer(t.admin.token))
      .send({ name: 'renamed-service' });
    expect(res.status).toBe(200);

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    const [audit] = await auditOf('SERVICE_UPDATED');
    expect(row).toMatchObject({
      eventType: 'SERVICE_UPDATED',
      notificationType: 'INFO',
      idempotencyKey: `SERVICE_UPDATED:${t.service.id}:${audit.id}`,
    });
    expect([...row.recipients].sort()).toEqual(ids(t.admin.user, t.lead, t.engineer, t.fallback));
  });

  it('S7 update: one ESCALATION_POLICY_UPDATED (ALERT) to the team members and the fallback admin', async () => {
    const t = await teamWorld();
    const replacement = await createUser({ role: 'ENGINEER', teamId: t.team.id });
    const res = await request(app)
      .patch(`/api/v1/services/${t.service.id}/escalation-policies/${t.policy.id}`)
      .set(bearer(t.admin.token))
      .send({ level1: replacement.id });
    expect(res.status).toBe(200);

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    const [audit] = await auditOf('ESCALATION_POLICY_UPDATED');
    expect(row).toMatchObject({
      eventType: 'ESCALATION_POLICY_UPDATED',
      notificationType: 'ALERT',
      idempotencyKey: `ESCALATION_POLICY_UPDATED:${t.service.id}:${audit.id}`,
    });
    expect([...row.recipients].sort()).toEqual(
      ids(t.admin.user, t.lead, t.engineer, replacement, t.fallback),
    );
  });

  it('creates nothing for no-op requests, failed requests, reads or user updates', async () => {
    const t = await teamWorld();
    const same = (url: string, body: object) =>
      request(app).patch(url).set(bearer(t.admin.token)).send(body);

    expect((await same(`/api/v1/identity/teams/${t.team.id}`, {})).status).toBe(422);
    expect((await same(`/api/v1/identity/teams/${t.team.id}`, { name: t.team.name })).status).toBe(
      200,
    );
    expect(
      (
        await same(`/api/v1/services/${t.service.id}/escalation-policies/${t.policy.id}`, {
          level1: t.engineer.id,
        })
      ).status,
    ).toBe(200);
    expect((await same(`/api/v1/services/${t.service.id}`, { name: '' })).status).toBe(422);
    expect(
      (await request(app).get(`/api/v1/services/${t.service.id}`).set(bearer(t.admin.token)))
        .status,
    ).toBe(200);
    expect(
      (await same(`/api/v1/identity/users/${t.engineer.id}`, { name: 'New Name' })).status,
    ).toBe(200);

    expect(await db().notification.count()).toBe(0);
    expect(await db().outboxEvent.count({ where: { eventType: 'NOTIFICATION_REQUESTED' } })).toBe(
      0,
    );
  });

  it('commits the notification with the change and rolls it back with a failed change', async () => {
    const t = await teamWorld({ withService: false });
    jest.spyOn(sessions, 'revokeSessionsForUsers').mockRejectedValueOnce(new Error('boom'));
    const failed = await request(app)
      .patch(`/api/v1/identity/teams/${t.team.id}`)
      .set(bearer(t.admin.token))
      .send({ status: 'DEACTIVATED' });
    expect(failed.status).toBe(500);

    expect(await db().notification.count()).toBe(0);
    expect(await db().outboxEvent.count({ where: { eventType: 'NOTIFICATION_REQUESTED' } })).toBe(
      0,
    );
    expect(await auditOf('TEAM_DEACTIVATED')).toHaveLength(0);
    expect((await db().team.findUniqueOrThrow({ where: { id: t.team.id } })).status).toBe('ACTIVE');
  });
});
