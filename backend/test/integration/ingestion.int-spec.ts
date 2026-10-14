import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as auditModule from '../../src/infra/audit/append-audit-event';
import { getPrisma } from '../../src/infra/db/prisma';
import * as prismaModule from '../../src/infra/db/prisma';
import * as outboxModule from '../../src/infra/jobs/outbox';
import * as alertRepository from '../../src/modules/alerts/alert.repository';
import { queueForEvent } from '../../src/infra/jobs/events';
import { getRedis } from '../../src/infra/redis/redis';
import { buildTestApp } from '../helpers/app';
import { createAlertSource, nowSeconds, postWebhook } from '../helpers/alert-source';
import { createService, createTeam, createUser, resetState } from '../helpers/identity';

const app = buildTestApp();
const db = () => getPrisma();

beforeEach(resetState);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

/**
 * Every request needs a signature of its own (an identical body at an identical timestamp is a
 * replay). Timestamps come from one fixed base minus a per-send offset, so they never depend on
 * the wall clock moving between two sends; the offset stays far inside the 5-minute window.
 */
const BASE_TIMESTAMP = nowSeconds();
let tick = 0;
const send = (sourceId: string, items: unknown, options: Parameters<typeof postWebhook>[3] = {}) =>
  postWebhook(app, sourceId, items, { timestamp: BASE_TIMESTAMP - (tick++ % 100), ...options });

type Result = {
  index: number;
  outcome: string;
  alertId: string | null;
  incidentId: string | null;
  error: { code: string; message: string } | null;
};
const resultsOf = (res: request.Response): Result[] => res.body.data.results;

async function world() {
  const team = await createTeam();
  const admin = await createUser({ role: 'ADMIN', teamId: team.id });
  const service = await createService(team.id, admin.id);
  const source = await createAlertSource();
  return { team, admin, service, source };
}

const alertFor = (serviceId: string, overrides: Record<string, unknown> = {}) => ({
  serviceId,
  environment: 'production',
  startedAt: '2026-10-14T10:00:00Z',
  name: 'cpu high',
  sourceEventId: `evt-${randomUUID()}`,
  ...overrides,
});

async function counts() {
  return {
    incidents: await db().incident.count(),
    alerts: await db().alert.count(),
    audit: await db().auditEvent.count(),
    outbox: await db().outboxEvent.count(),
  };
}

const NOTHING = { incidents: 0, alerts: 0, audit: 0, outbox: 0 };

describe('W1 ingestion · incident creation', () => {
  it('creates the incident, alert, both audit events and both outbox rows in one commit', async () => {
    const w = await world();
    await db().appService.update({ where: { id: w.service.id }, data: { defaultSeverity: 'P2' } });
    const element = {
      sourceEventId: 'evt-1',
      sourceFingerprint: 'fp-1',
      name: 'cpu high',
      serviceId: w.service.id,
      environment: 'production',
      sourceSeverity: 'Warning-ish',
      summary: 'CPU above 90%',
      description: 'The CPU of host-1 is above 90%',
      labels: ['host=host-1', 'tier=web'],
      additionalDetails: 'runbook: wiki/cpu',
      startedAt: '2026-10-14T10:00:00Z',
      sourceUrl: 'https://monitor.example.com/alerts/1',
      vendor: { unknown: ['fields', 1.5, null, true], text: 'héllo ✓' },
    };

    const res = await send(w.source.id, [element], { requestId: 'req-create-1' });

    expect(res.status).toBe(200);
    const [result] = resultsOf(res);
    expect(result).toEqual({
      index: 0,
      outcome: 'INCIDENT_CREATED',
      alertId: expect.any(String),
      incidentId: expect.any(String),
      error: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('originalPayload');

    const incident = await db().incident.findUniqueOrThrow({ where: { id: result!.incidentId! } });
    expect(incident).toMatchObject({
      title: 'cpu high',
      description: 'The CPU of host-1 is above 90%\n\nCPU above 90%',
      status: 'OPEN',
      severity: 'P2',
      teamId: w.team.id,
      affectedServiceId: w.service.id,
      currentAssigneeId: null,
      acknowledgedById: null,
      acknowledgedTimestamp: null,
      resolvedTimestamp: null,
      closedTimestamp: null,
    });

    const alert = await db().alert.findUniqueOrThrow({ where: { id: result!.alertId! } });
    expect(alert).toMatchObject({
      incidentId: incident.id,
      alertSourceId: w.source.id,
      affectedServiceId: w.service.id,
      sourceEventId: 'evt-1',
      sourceFingerprint: 'fp-1',
      name: 'cpu high',
      environment: 'production',
      sourceSeverity: 'Warning-ish',
      initialSeverity: 'P2',
      summary: 'CPU above 90%',
      description: 'The CPU of host-1 is above 90%',
      labels: ['host=host-1', 'tier=web'],
      additionalDetails: 'runbook: wiki/cpu',
      endedTimestamp: null,
      sourceUrl: 'https://monitor.example.com/alerts/1',
      activeIdentityKey: 'event:evt-1',
      sourceStatus: 'FIRING',
    });
    expect(alert.startedTimestamp.toISOString()).toBe('2026-10-14T10:00:00.000Z');
    // The element as delivered, not a re-serialization of the normalized form.
    expect(alert.originalPayload).toEqual(element);

    const audit = await db().auditEvent.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audit.map((e) => e.eventType)).toEqual(['INCIDENT_CREATED', 'ALERT_RECEIVED']);
    expect(audit.map((e) => e.actor)).toEqual([null, null]);
    expect(audit.map((e) => e.incidentId)).toEqual([incident.id, incident.id]);
    expect(audit[0]!.metadata).toEqual({ incidentId: incident.id });
    expect(audit[1]!.metadata).toEqual({ alertId: alert.id });

    const outbox = await db().outboxEvent.findMany({ orderBy: { eventType: 'asc' } });
    expect(outbox.map((e) => e.eventType)).toEqual([
      'ALERT_TRIAGE_REQUESTED',
      'SLA_EVALUATION_REQUESTED',
    ]);
    expect(outbox.map((e) => e.status)).toEqual(['PENDING', 'PENDING']);
    expect(outbox[0]!.payload).toEqual({
      alertId: alert.id,
      incidentId: incident.id,
      requestId: 'req-create-1',
    });
    expect(outbox[1]!.payload).toEqual({ incidentId: incident.id, requestId: 'req-create-1' });
    expect(outbox.map((e) => queueForEvent(e.eventType))).toEqual(['ai-triage', 'sla-escalation']);
    expect(await db().outboxEvent.count({ where: { eventType: 'NOTIFICATION_REQUESTED' } })).toBe(
      0,
    );
  });

  it('derives the team from the service, never from the request', async () => {
    const w = await world();
    const otherTeam = await createTeam();
    const res = await send(w.source.id, [alertFor(w.service.id, { teamId: otherTeam.id })]);
    const incident = await db().incident.findFirstOrThrow();
    expect(resultsOf(res)[0]!.outcome).toBe('INCIDENT_CREATED');
    expect(incident.teamId).toBe(w.team.id);
  });

  it('stores nothing from the signing secret and keeps the unknown fields only in the payload', async () => {
    const w = await world();
    await send(w.source.id, [alertFor(w.service.id)]);
    const stored = JSON.stringify([
      await db().alert.findMany(),
      await db().auditEvent.findMany(),
      await db().outboxEvent.findMany(),
    ]);
    expect(stored).not.toContain('integration-signing-secret');
  });

  describe('initial severity', () => {
    it.each([
      ['critical', 'P0'],
      ['high', 'P1'],
      ['warning', 'P2'],
      ['info', 'P3'],
      ['Critical', 'P0'],
      ['WARNING', 'P2'],
    ])('maps %s to %s from the source configuration', async (sourceSeverity, expected) => {
      const w = await world();
      await db().appService.update({
        where: { id: w.service.id },
        data: { defaultSeverity: 'P3' },
      });
      const res = await send(w.source.id, [alertFor(w.service.id, { sourceSeverity })]);
      const incident = await db().incident.findUniqueOrThrow({
        where: { id: resultsOf(res)[0]!.incidentId! },
      });
      const alert = await db().alert.findFirstOrThrow();
      expect(incident.severity).toBe(expected);
      expect(alert.initialSeverity).toBe(expected);
      expect(alert.sourceSeverity).toBe(sourceSeverity);
    });

    it('honors a custom mapping of another source', async () => {
      const w = await world();
      const custom = await db().alertSource.create({
        data: {
          name: 'custom',
          sourceType: 'GENERIC',
          configuration: {
            signingSecret: 'integration-signing-secret-0123456789',
            severityMapping: { sev1: 'P0', Sev2: 'P1' },
          },
        },
      });
      const res = await send(custom.id, [
        alertFor(w.service.id, { sourceSeverity: 'SEV1' }),
        alertFor(w.service.id, { sourceSeverity: 'sev2' }),
        alertFor(w.service.id, { sourceSeverity: 'critical' }),
      ]);
      const severities = await Promise.all(
        resultsOf(res).map(
          async (r) =>
            (await db().incident.findUniqueOrThrow({ where: { id: r.incidentId! } })).severity,
        ),
      );
      expect(severities).toEqual(['P0', 'P1', 'P1']);
    });

    it.each([
      ['an unrecognized value', { sourceSeverity: 'catastrophic' }],
      ['an absent value', {}],
    ])('uses the service default for %s', async (_label, extra) => {
      const w = await world();
      await db().appService.update({
        where: { id: w.service.id },
        data: { defaultSeverity: 'P2' },
      });
      const res = await send(w.source.id, [alertFor(w.service.id, extra)]);
      expect(resultsOf(res)[0]!.outcome).toBe('INCIDENT_CREATED');
      expect((await db().incident.findFirstOrThrow()).severity).toBe('P2');
    });

    it('uses the service default for a source without a mapping', async () => {
      const w = await world();
      await db().appService.update({
        where: { id: w.service.id },
        data: { defaultSeverity: 'P3' },
      });
      const bare = await db().alertSource.create({
        data: {
          name: 'bare',
          sourceType: 'GENERIC',
          configuration: { signingSecret: 'integration-signing-secret-0123456789' },
        },
      });
      const res = await send(bare.id, [alertFor(w.service.id, { sourceSeverity: 'critical' })]);
      expect(resultsOf(res)[0]!.outcome).toBe('INCIDENT_CREATED');
      expect((await db().incident.findFirstOrThrow()).severity).toBe('P3');
    });
  });

  describe('incident title and description', () => {
    it('uses the name as title and joins description and summary with a blank line', async () => {
      const w = await world();
      await send(w.source.id, [
        alertFor(w.service.id, { name: 'N', summary: 'S', description: 'D' }),
      ]);
      expect(await db().incident.findFirstOrThrow()).toMatchObject({
        title: 'N',
        description: 'D\n\nS',
      });
    });

    it('uses the summary as title when there is no name', async () => {
      const w = await world();
      await send(w.source.id, [alertFor(w.service.id, { name: undefined, summary: 'S' })]);
      expect(await db().incident.findFirstOrThrow()).toMatchObject({
        title: 'S',
        description: 'S',
      });
    });

    it('stores an empty (non-null) description when neither description nor summary exist', async () => {
      const w = await world();
      await send(w.source.id, [alertFor(w.service.id)]);
      expect((await db().incident.findFirstOrThrow()).description).toBe('');
    });

    it('rejects an alert with neither name nor summary and stores nothing', async () => {
      const w = await world();
      const res = await send(w.source.id, [alertFor(w.service.id, { name: undefined })]);
      expect(res.status).toBe(400);
      expect(resultsOf(res)[0]).toMatchObject({
        outcome: 'REJECTED',
        alertId: null,
        incidentId: null,
        error: { code: 'ALERT_INVALID' },
      });
      expect(await counts()).toEqual(NOTHING);
    });

    it('does not reject a duplicate or a source-resolved delivery for a missing name/summary', async () => {
      const w = await world();
      const identity = { sourceEventId: 'evt-text' };
      await send(w.source.id, [alertFor(w.service.id, { ...identity })]);

      const bare = {
        serviceId: w.service.id,
        environment: 'production',
        startedAt: '2026-10-14T10:05:00Z',
        ...identity,
      };
      const duplicate = await send(w.source.id, [bare]);
      expect(resultsOf(duplicate)[0]!.outcome).toBe('DUPLICATE');

      const resolved = await send(w.source.id, [{ ...bare, status: 'RESOLVED' }]);
      expect(resultsOf(resolved)[0]!.outcome).toBe('SOURCE_RESOLVED_RECORDED');
    });
  });
});

describe('W1 ingestion · deduplication', () => {
  const identities: [string, (serviceId: string) => Record<string, unknown>][] = [
    ['event id', () => ({ sourceEventId: 'evt-dup' })],
    ['fingerprint', () => ({ sourceEventId: undefined, sourceFingerprint: 'fp-dup' })],
    [
      'derived fingerprint',
      () => ({ sourceEventId: undefined, name: 'disk full', labels: ['host=a', 'dc=eu'] }),
    ],
  ];

  it.each(identities)(
    'treats a repeated %s as a DUPLICATE and writes only the audit event',
    async (_label, identity) => {
      const w = await world();
      const first = await send(w.source.id, [alertFor(w.service.id, identity(w.service.id))]);
      const created = resultsOf(first)[0]!;
      expect(created.outcome).toBe('INCIDENT_CREATED');
      const before = await counts();

      // Same identity; only fields outside the identity differ.
      const again = await send(w.source.id, [
        alertFor(w.service.id, {
          ...identity(w.service.id),
          summary: 'later summary',
          sourceSeverity: 'critical',
          startedAt: '2026-10-14T11:00:00Z',
          sourceUrl: 'https://monitor.example.com/other',
          labels: identity(w.service.id).labels ? ['dc=eu', 'host=a'] : undefined,
        }),
      ]);

      expect(again.status).toBe(200);
      expect(resultsOf(again)[0]).toEqual({
        index: 0,
        outcome: 'DUPLICATE',
        alertId: created.alertId,
        incidentId: created.incidentId,
        error: null,
      });
      expect(await counts()).toEqual({ ...before, audit: before.audit + 1 });
      const audit = await db().auditEvent.findFirstOrThrow({
        where: { eventType: 'ALERT_DUPLICATE' },
      });
      expect(audit).toMatchObject({
        incidentId: created.incidentId,
        actor: null,
        metadata: { alertSourceId: w.source.id },
      });
    },
  );

  it('stores the derived fingerprint in sourceFingerprint', async () => {
    const w = await world();
    await send(w.source.id, [
      alertFor(w.service.id, { sourceEventId: undefined, labels: ['a=1'] }),
    ]);
    const alert = await db().alert.findFirstOrThrow();
    expect(alert.sourceEventId).toBeNull();
    expect(alert.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(alert.activeIdentityKey).toBe(`fingerprint:${alert.sourceFingerprint}`);
  });

  it('does not confuse the same text used as an event id and as a fingerprint', async () => {
    const w = await world();
    const res = await send(w.source.id, [
      alertFor(w.service.id, { sourceEventId: 'same' }),
      alertFor(w.service.id, { sourceEventId: undefined, sourceFingerprint: 'same' }),
    ]);
    expect(resultsOf(res).map((r) => r.outcome)).toEqual(['INCIDENT_CREATED', 'INCIDENT_CREATED']);
    expect(await db().incident.count()).toBe(2);
  });

  it('keeps identities separate per source', async () => {
    const w = await world();
    const other = await createAlertSource({ name: 'other source' });
    const element = alertFor(w.service.id, { sourceEventId: 'shared' });
    await send(w.source.id, [element]);
    const res = await send(other.id, [element]);
    expect(resultsOf(res)[0]!.outcome).toBe('INCIDENT_CREATED');
    expect(await db().incident.count()).toBe(2);
  });

  it('resolves two same-identity alerts of one batch in order: the first creates, the second is a duplicate', async () => {
    const w = await world();
    const element = alertFor(w.service.id, { sourceEventId: 'twice' });
    const res = await send(w.source.id, [element, element]);
    const [first, second] = resultsOf(res);
    expect(first!.outcome).toBe('INCIDENT_CREATED');
    expect(second).toMatchObject({
      outcome: 'DUPLICATE',
      alertId: first!.alertId,
      incidentId: first!.incidentId,
    });
    expect(await db().incident.count()).toBe(1);
  });

  it('creates exactly one incident for simultaneous identical deliveries; the others are duplicates', async () => {
    const w = await world();
    const element = alertFor(w.service.id, { sourceEventId: 'race' });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => send(w.source.id, [element])),
    );

    const outcomes = responses.map((res) => {
      expect(res.status).toBe(200);
      return resultsOf(res)[0]!;
    });
    expect(outcomes.filter((r) => r.outcome === 'INCIDENT_CREATED')).toHaveLength(1);
    expect(outcomes.filter((r) => r.outcome === 'DUPLICATE')).toHaveLength(7);
    expect(new Set(outcomes.map((r) => r.incidentId)).size).toBe(1);
    expect(new Set(outcomes.map((r) => r.alertId)).size).toBe(1);

    expect(await counts()).toEqual({ incidents: 1, alerts: 1, audit: 2 + 7, outbox: 2 });
    expect(await db().auditEvent.count({ where: { eventType: 'ALERT_DUPLICATE' } })).toBe(7);
  });

  it('lets the database key decide when the read misses the existing alert: the loser is re-handled as a DUPLICATE', async () => {
    const w = await world();
    const element = alertFor(w.service.id, { sourceEventId: 'lost-race' });
    const first = resultsOf(await send(w.source.id, [element]))[0]!;

    // The duplicate check does not see the winner's row (as with a concurrent, uncommitted insert).
    jest.spyOn(alertRepository, 'findAlertByActiveKey').mockResolvedValueOnce(null);
    const res = await send(w.source.id, [element]);

    expect(res.status).toBe(200);
    expect(resultsOf(res)[0]).toEqual({
      index: 0,
      outcome: 'DUPLICATE',
      alertId: first.alertId,
      incidentId: first.incidentId,
      error: null,
    });
    // The aborted attempt rolled back its incident, alert, audit events and outbox rows.
    expect(await counts()).toEqual({ incidents: 1, alerts: 1, audit: 2 + 1, outbox: 2 });
  });

  it('creates a new incident once the earlier one is resolved and its key cleared', async () => {
    const w = await world();
    const element = alertFor(w.service.id, { sourceEventId: 'recurring' });
    const first = resultsOf(await send(w.source.id, [element]))[0]!;

    // What SLICE-05 does when an incident becomes RESOLVED.
    await db().incident.update({ where: { id: first.incidentId! }, data: { status: 'RESOLVED' } });
    await db().alert.updateMany({
      where: { incidentId: first.incidentId! },
      data: { activeIdentityKey: null },
    });

    const second = resultsOf(await send(w.source.id, [element]))[0]!;
    expect(second.outcome).toBe('INCIDENT_CREATED');
    expect(second.incidentId).not.toBe(first.incidentId);
    expect(await db().incident.count()).toBe(2);

    const alerts = await db().alert.findMany({ where: { sourceEventId: 'recurring' } });
    expect(alerts).toHaveLength(2);
    expect(await db().outboxEvent.count()).toBe(4);

    // And the new one is deduplicated again.
    const third = resultsOf(await send(w.source.id, [element]))[0]!;
    expect(third).toMatchObject({ outcome: 'DUPLICATE', incidentId: second.incidentId });
  });

  it('still reports a duplicate for an incident that is acknowledged or mitigating', async () => {
    const w = await world();
    const element = alertFor(w.service.id, { sourceEventId: 'busy' });
    const first = resultsOf(await send(w.source.id, [element]))[0]!;
    await db().incident.update({
      where: { id: first.incidentId! },
      data: { status: 'MITIGATING' },
    });
    const again = resultsOf(await send(w.source.id, [element]))[0]!;
    expect(again).toMatchObject({ outcome: 'DUPLICATE', incidentId: first.incidentId });
  });

  it('enforces the unique (alertSourceId, activeIdentityKey) in the database', async () => {
    const w = await world();
    const first = resultsOf(
      await send(w.source.id, [alertFor(w.service.id, { sourceEventId: 'db-key' })]),
    )[0]!;
    const row = await db().alert.findUniqueOrThrow({ where: { id: first.alertId! } });
    await expect(
      db().alert.create({
        data: {
          environment: 'production',
          startedTimestamp: new Date(),
          originalPayload: {},
          activeIdentityKey: row.activeIdentityKey,
          alertSourceId: w.source.id,
          affectedServiceId: w.service.id,
          incidentId: first.incidentId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('W1 ingestion · source-resolved deliveries', () => {
  const resolved = (serviceId: string, extra: Record<string, unknown> = {}) =>
    alertFor(serviceId, { status: 'RESOLVED', ...extra });

  it('records the source state on the alert and leaves incident status and active key alone', async () => {
    const w = await world();
    const created = resultsOf(
      await send(w.source.id, [alertFor(w.service.id, { sourceEventId: 'res-1' })]),
    )[0]!;
    const before = await counts();

    const res = await send(w.source.id, [
      resolved(w.service.id, { sourceEventId: 'res-1', endedAt: '2026-10-14T10:30:00Z' }),
    ]);

    expect(res.status).toBe(200);
    expect(resultsOf(res)[0]).toEqual({
      index: 0,
      outcome: 'SOURCE_RESOLVED_RECORDED',
      alertId: created.alertId,
      incidentId: created.incidentId,
      error: null,
    });
    const alert = await db().alert.findUniqueOrThrow({ where: { id: created.alertId! } });
    expect(alert.sourceStatus).toBe('RESOLVED');
    expect(alert.endedTimestamp?.toISOString()).toBe('2026-10-14T10:30:00.000Z');
    expect(alert.activeIdentityKey).toBe('event:res-1');
    expect(
      (await db().incident.findUniqueOrThrow({ where: { id: created.incidentId! } })).status,
    ).toBe('OPEN');
    expect(await counts()).toEqual({ ...before, audit: before.audit + 1 });
    expect(
      await db().auditEvent.findFirstOrThrow({ where: { eventType: 'SOURCE_ALERT_RESOLVED' } }),
    ).toMatchObject({
      incidentId: created.incidentId,
      actor: null,
      metadata: { alertId: created.alertId },
    });
  });

  it('records the time of receipt when the delivery has no endedAt', async () => {
    const w = await world();
    await send(w.source.id, [alertFor(w.service.id, { sourceEventId: 'res-2' })]);
    const before = Date.now();
    await send(w.source.id, [resolved(w.service.id, { sourceEventId: 'res-2' })]);
    const alert = await db().alert.findFirstOrThrow();
    expect(alert.endedTimestamp!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(alert.endedTimestamp!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('gives the same outcome and no extra audit event on re-delivery', async () => {
    const w = await world();
    await send(w.source.id, [alertFor(w.service.id, { sourceEventId: 'res-3' })]);
    const delivery = resolved(w.service.id, {
      sourceEventId: 'res-3',
      endedAt: '2026-10-14T10:30:00Z',
    });
    const first = resultsOf(await send(w.source.id, [delivery]))[0]!;
    const second = resultsOf(
      await send(w.source.id, [{ ...delivery, endedAt: '2026-10-14T10:45:00Z' }]),
    )[0]!;
    expect(second).toEqual(first);
    expect(await db().auditEvent.count({ where: { eventType: 'SOURCE_ALERT_RESOLVED' } })).toBe(1);
    expect((await db().alert.findFirstOrThrow()).endedTimestamp?.toISOString()).toBe(
      '2026-10-14T10:30:00.000Z',
    );
  });

  it('writes one audit event for simultaneous deliveries', async () => {
    const w = await world();
    await send(w.source.id, [alertFor(w.service.id, { sourceEventId: 'res-4' })]);
    const delivery = resolved(w.service.id, { sourceEventId: 'res-4' });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => send(w.source.id, [delivery])),
    );
    expect(responses.map((r) => resultsOf(r)[0]!.outcome)).toEqual(
      Array(5).fill('SOURCE_RESOLVED_RECORDED'),
    );
    expect(await db().auditEvent.count({ where: { eventType: 'SOURCE_ALERT_RESOLVED' } })).toBe(1);
  });

  it.each([
    ['fingerprint', { sourceEventId: undefined, sourceFingerprint: 'fp-res' }],
    ['derived fingerprint', { sourceEventId: undefined, name: 'disk full', labels: ['host=a'] }],
  ])('finds the alert by %s', async (_label, identity) => {
    const w = await world();
    const created = resultsOf(await send(w.source.id, [alertFor(w.service.id, identity)]))[0]!;
    const res = await send(w.source.id, [
      resolved(w.service.id, { ...identity, summary: 'back to normal' }),
    ]);
    expect(resultsOf(res)[0]).toMatchObject({
      outcome: 'SOURCE_RESOLVED_RECORDED',
      alertId: created.alertId,
    });
  });

  it('finds the alert although its incident was resolved and the key cleared, and picks the latest', async () => {
    const w = await world();
    const element = alertFor(w.service.id, { sourceEventId: 'res-5' });
    const first = resultsOf(await send(w.source.id, [element]))[0]!;
    await db().incident.update({ where: { id: first.incidentId! }, data: { status: 'RESOLVED' } });
    await db().alert.updateMany({
      where: { incidentId: first.incidentId! },
      data: { activeIdentityKey: null },
    });

    // Before any new incident exists, the cleared alert is still found.
    const late = resultsOf(
      await send(w.source.id, [resolved(w.service.id, { sourceEventId: 'res-5' })]),
    )[0]!;
    expect(late).toMatchObject({ outcome: 'SOURCE_RESOLVED_RECORDED', alertId: first.alertId });

    // A new incident with the same identity: now the most recent alert is the one resolved.
    const second = resultsOf(await send(w.source.id, [element]))[0]!;
    expect(second.outcome).toBe('INCIDENT_CREATED');
    const latest = resultsOf(
      await send(w.source.id, [
        resolved(w.service.id, { sourceEventId: 'res-5', summary: 'again' }),
      ]),
    )[0]!;
    expect(latest).toMatchObject({ outcome: 'SOURCE_RESOLVED_RECORDED', alertId: second.alertId });
    expect(
      (await db().alert.findUniqueOrThrow({ where: { id: second.alertId! } })).sourceStatus,
    ).toBe('RESOLVED');
    expect(
      (await db().incident.findUniqueOrThrow({ where: { id: second.incidentId! } })).status,
    ).toBe('OPEN');
  });

  it('rejects a resolved delivery with no earlier alert and creates nothing', async () => {
    const w = await world();
    const res = await send(w.source.id, [resolved(w.service.id, { sourceEventId: 'never-seen' })]);
    expect(res.status).toBe(400);
    expect(resultsOf(res)[0]).toMatchObject({
      outcome: 'REJECTED',
      alertId: null,
      incidentId: null,
      error: { code: 'ALERT_INVALID' },
    });
    expect(await counts()).toEqual(NOTHING);
  });

  it('does not match an alert of another source', async () => {
    const w = await world();
    const other = await createAlertSource({ name: 'other' });
    await send(other.id, [alertFor(w.service.id, { sourceEventId: 'foreign' })]);
    const res = await send(w.source.id, [resolved(w.service.id, { sourceEventId: 'foreign' })]);
    expect(resultsOf(res)[0]!.error?.code).toBe('ALERT_INVALID');
  });
});

describe('W1 ingestion · batches and rejections', () => {
  it('reports independent outcomes in request order and answers 200 when one alert was accepted', async () => {
    const w = await world();
    const first = alertFor(w.service.id, { sourceEventId: 'mix-1' });
    const res = await send(w.source.id, [
      first,
      { serviceId: 'nope' },
      first,
      alertFor(randomUUID()),
      alertFor(w.service.id, { sourceEventId: 'mix-2' }),
    ]);

    expect(res.status).toBe(200);
    const results = resultsOf(res);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(results.map((r) => r.outcome)).toEqual([
      'INCIDENT_CREATED',
      'REJECTED',
      'DUPLICATE',
      'REJECTED',
      'INCIDENT_CREATED',
    ]);
    expect(results.map((r) => r.error?.code ?? null)).toEqual([
      null,
      'ALERT_INVALID',
      null,
      'UNKNOWN_SERVICE',
      null,
    ]);
    expect(results[2]!.incidentId).toBe(results[0]!.incidentId);
    expect(results[1]).toMatchObject({ alertId: null, incidentId: null });
    expect(await db().incident.count()).toBe(2);
  });

  it('answers 400 with the same body shape when every alert was rejected', async () => {
    const w = await world();
    const res = await send(w.source.id, [{}, alertFor(randomUUID()), 'text']);
    expect(res.status).toBe(400);
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(resultsOf(res).map((r) => [r.index, r.outcome, r.error?.code])).toEqual([
      [0, 'REJECTED', 'ALERT_INVALID'],
      [1, 'REJECTED', 'UNKNOWN_SERVICE'],
      [2, 'REJECTED', 'ALERT_INVALID'],
    ]);
    expect(await counts()).toEqual(NOTHING);
  });

  it('reports the items beyond the rate limit as RATE_LIMITED, never as an HTTP status', async () => {
    const w = await world();
    const items = Array.from({ length: 16 }, (_, i) =>
      alertFor(w.service.id, { sourceEventId: `rl-${i}` }),
    );
    const res = await send(w.source.id, items);
    expect(res.status).toBe(200);
    const results = resultsOf(res);
    expect(results.slice(0, 15).every((r) => r.outcome === 'INCIDENT_CREATED')).toBe(true);
    expect(results[15]).toEqual({
      index: 15,
      outcome: 'REJECTED',
      alertId: null,
      incidentId: null,
      error: { code: 'RATE_LIMITED', message: expect.any(String) },
    });
    expect(await db().incident.count()).toBe(15);
  });

  type World = Awaited<ReturnType<typeof world>>;
  it.each([
    {
      label: 'an unknown service',
      build: () => alertFor(randomUUID()),
      code: 'UNKNOWN_SERVICE',
    },
    {
      label: 'bad fields',
      build: (w: World) => alertFor(w.service.id, { startedAt: 'soon', labels: ['nokey'] }),
      code: 'ALERT_INVALID',
    },
    { label: 'a non-object', build: () => 42, code: 'ALERT_INVALID' },
    {
      label: 'no identity',
      build: (w: World) =>
        alertFor(w.service.id, { sourceEventId: undefined, name: undefined, summary: 'x' }),
      code: 'IDENTITY_UNRESOLVABLE',
    },
    {
      label: 'a NUL character',
      build: (w: World) => alertFor(w.service.id, { name: 'a\u0000b' }),
      code: 'ALERT_INVALID',
    },
  ])('rejects $label with $code and stores nothing', async ({ build, code }) => {
    const w = await world();
    const res = await send(w.source.id, [build(w)]);
    expect(res.status).toBe(400);
    expect(resultsOf(res)[0]!.error?.code).toBe(code);
    expect(await counts()).toEqual(NOTHING);
  });

  it('rejects a deactivated service, for firing and resolved deliveries, and stores nothing', async () => {
    const w = await world();
    await db().appService.update({ where: { id: w.service.id }, data: { status: 'DEACTIVATED' } });
    const res = await send(w.source.id, [
      alertFor(w.service.id),
      alertFor(w.service.id, { status: 'RESOLVED' }),
    ]);
    expect(res.status).toBe(400);
    expect(resultsOf(res).map((r) => r.error?.code)).toEqual([
      'SERVICE_DEACTIVATED',
      'SERVICE_DEACTIVATED',
    ]);
    expect(await counts()).toEqual(NOTHING);
  });
});

describe('W1 ingestion · failures', () => {
  it('leaves no alert, incident, audit event or outbox row when it fails after the alert insert', async () => {
    const w = await world();
    const real = auditModule.appendAuditEvent;
    let calls = 0;
    jest.spyOn(auditModule, 'appendAuditEvent').mockImplementation((tx, input) => {
      calls += 1;
      // INCIDENT_CREATED is written after the Alert insert; fail on the next one.
      if (calls === 2) return Promise.reject(new Error('audit store exploded'));
      return real(tx, input);
    });

    const res = await send(w.source.id, [alertFor(w.service.id)]);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain('exploded');
    expect(await counts()).toEqual(NOTHING);
  });

  it('leaves nothing behind when the second outbox row cannot be written', async () => {
    const w = await world();
    const real = outboxModule.enqueueOutbox;
    let calls = 0;
    jest.spyOn(outboxModule, 'enqueueOutbox').mockImplementation((tx, input) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('outbox exploded'));
      return real(tx, input);
    });

    const res = await send(w.source.id, [alertFor(w.service.id)]);

    expect(res.status).toBe(500);
    expect(await counts()).toEqual(NOTHING);
  });

  it('answers 503 with Retry-After when the database is down; committed alerts become duplicates on retry', async () => {
    const w = await world();
    const items = [
      alertFor(w.service.id, { sourceEventId: 'down-1' }),
      alertFor(w.service.id, { sourceEventId: 'down-2' }),
    ];
    const real = prismaModule.runInTransaction;
    let calls = 0;
    jest.spyOn(prismaModule, 'runInTransaction').mockImplementation(((
      work: never,
      options: never,
    ) => {
      calls += 1;
      if (calls === 2) {
        return Promise.reject(
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        );
      }
      return real(work, options);
    }) as typeof real);

    const res = await send(w.source.id, items);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', details: [] });
    expect(res.headers['retry-after']).toBe('5');
    expect(await db().incident.count()).toBe(1);

    jest.restoreAllMocks();
    const retry = await send(w.source.id, items);
    expect(retry.status).toBe(200);
    expect(resultsOf(retry).map((r) => r.outcome)).toEqual(['DUPLICATE', 'INCIDENT_CREATED']);
    expect(await db().incident.count()).toBe(2);
  });
});
