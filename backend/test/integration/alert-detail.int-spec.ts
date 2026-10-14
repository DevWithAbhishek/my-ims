import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import { buildTestApp } from '../helpers/app';
import { resetState } from '../helpers/identity';
import {
  createAlert,
  createAlertSource,
  createIncidentWith,
  incidentWorld,
} from '../helpers/incidents';

const app = buildTestApp();
const NIL = '00000000-0000-4000-8000-000000000000';

beforeEach(resetState);
afterAll(async () => {
  await getPrisma().$disconnect();
  getRedis().disconnect();
});

const url = (incidentId: string, alertId: string) =>
  `/api/v1/incidents/${incidentId}/alerts/${alertId}`;

async function setup() {
  const w = await incidentWorld(app);
  const source = await createAlertSource('Datadog');
  const incident = await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });
  const originalPayload = {
    z: 1,
    a: { nested: ['x', 2.5, null, true], text: 'héllo ✓' },
    sourceEventId: 'evt-1',
  };
  const alert = await getPrisma().alert.create({
    data: {
      sourceEventId: 'evt-1',
      sourceFingerprint: 'fp-1',
      name: 'cpu high',
      environment: 'production',
      sourceSeverity: 'Critical',
      initialSeverity: 'P0',
      summary: 'CPU above 90%',
      description: 'long description',
      labels: ['host=a', 'tier=web'],
      additionalDetails: 'runbook',
      startedTimestamp: new Date('2026-10-14T10:00:00Z'),
      endedTimestamp: new Date('2026-10-14T10:30:00Z'),
      sourceUrl: 'https://monitor.example.com/alerts/1',
      originalPayload,
      sourceStatus: 'RESOLVED',
      alertSourceId: source.id,
      affectedServiceId: w.serviceA.id,
      incidentId: incident.id,
    },
  });
  return { w, source, incident, alert, originalPayload };
}

describe('I12 GET /incidents/:incidentId/alerts/:alertId', () => {
  it('returns the alert detail with the verbatim original payload, for every role of the team', async () => {
    const { w, source, incident, alert, originalPayload } = await setup();

    for (const token of [w.auth.engA, w.auth.leadA, w.auth.adminA]) {
      const res = await request(app).get(url(incident.id, alert.id)).set(token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          id: alert.id,
          name: 'cpu high',
          environment: 'production',
          sourceSeverity: 'Critical',
          initialSeverity: 'P0',
          sourceStatus: 'RESOLVED',
          startedAt: '2026-10-14T10:00:00.000Z',
          endedAt: '2026-10-14T10:30:00.000Z',
          sourceUrl: 'https://monitor.example.com/alerts/1',
          alertSource: { id: source.id, name: 'Datadog' },
          sourceEventId: 'evt-1',
          sourceFingerprint: 'fp-1',
          summary: 'CPU above 90%',
          description: 'long description',
          labels: ['host=a', 'tier=web'],
          additionalDetails: 'runbook',
          originalPayload,
        },
      });
    }
  });

  it('returns absent nullable fields as null, never omitted', async () => {
    const w = await incidentWorld(app);
    const source = await createAlertSource();
    const incident = await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });
    const bare = await getPrisma().alert.create({
      data: {
        environment: 'production',
        startedTimestamp: new Date('2026-10-14T10:00:00Z'),
        originalPayload: {},
        alertSourceId: source.id,
        affectedServiceId: w.serviceA.id,
        incidentId: incident.id,
      },
    });

    const res = await request(app).get(url(incident.id, bare.id)).set(w.auth.engA);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: null,
      sourceSeverity: null,
      initialSeverity: null,
      sourceStatus: 'FIRING',
      endedAt: null,
      sourceUrl: null,
      sourceEventId: null,
      sourceFingerprint: null,
      summary: null,
      description: null,
      labels: [],
      additionalDetails: null,
      originalPayload: {},
    });
  });

  it('exposes originalPayload only here: not in the incident detail', async () => {
    const { w, incident, alert } = await setup();
    const detail = await request(app).get(`/api/v1/incidents/${incident.id}`).set(w.auth.engA);
    expect(detail.status).toBe(200);
    expect(detail.body.data.alerts).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toContain('originalPayload');
    expect(detail.body.data.alerts[0].id).toBe(alert.id);
  });

  describe('errors', () => {
    it('401 UNAUTHENTICATED without a token', async () => {
      const { incident, alert } = await setup();
      const res = await request(app).get(url(incident.id, alert.id));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('422 VALIDATION_FAILED for malformed ids', async () => {
      const { w, incident, alert } = await setup();
      for (const path of [
        url('not-a-uuid', alert.id),
        url(incident.id, 'not-a-uuid'),
        url('1', '2'),
      ]) {
        const res = await request(app).get(path).set(w.auth.engA);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
        expect(res.body.error.details.length).toBeGreaterThan(0);
      }
    });

    it('validation runs before the team check', async () => {
      const { w } = await setup();
      const res = await request(app).get(url('bad', NIL)).set(w.auth.noTeam);
      expect(res.status).toBe(422);
    });

    it('403 INVALID_ACTION for a caller without a team, even an Admin, before any lookup', async () => {
      const { w, incident, alert } = await setup();
      for (const path of [url(incident.id, alert.id), url(randomUUID(), randomUUID())]) {
        const res = await request(app).get(path).set(w.auth.noTeam);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('INVALID_ACTION');
      }
    });

    it('403 TEAM_ACCESS_DENIED for another team, whether or not the alert exists', async () => {
      const { w, incident, alert } = await setup();
      for (const path of [url(incident.id, alert.id), url(incident.id, randomUUID())]) {
        const res = await request(app).get(path).set(w.auth.engB);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('TEAM_ACCESS_DENIED');
      }
    });

    it('404 INCIDENT_NOT_FOUND for an unknown incident', async () => {
      const { w, alert } = await setup();
      const res = await request(app).get(url(randomUUID(), alert.id)).set(w.auth.engA);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({
        code: 'INCIDENT_NOT_FOUND',
        details: [{ resource: 'incident' }],
      });
    });

    it('404 ALERT_NOT_FOUND for an unknown alert', async () => {
      const { w, incident } = await setup();
      const res = await request(app).get(url(incident.id, randomUUID())).set(w.auth.engA);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({
        code: 'ALERT_NOT_FOUND',
        details: [{ resource: 'alert' }],
      });
    });

    it('404 ALERT_NOT_FOUND when the alert belongs to another incident, even of the same team', async () => {
      const { w, alert } = await setup();
      const other = await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });
      const res = await request(app).get(url(other.id, alert.id)).set(w.auth.engA);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ALERT_NOT_FOUND');
    });

    it('never reveals another team’s alert through a wrong incident', async () => {
      const { w } = await setup();
      const source = await createAlertSource();
      const theirs = await createIncidentWith({ teamId: w.teamB.id, serviceId: w.serviceB.id });
      const theirAlert = await createAlert({
        incidentId: theirs.id,
        serviceId: w.serviceB.id,
        alertSourceId: source.id,
      });
      const mine = await createIncidentWith({ teamId: w.teamA.id, serviceId: w.serviceA.id });

      const wrongIncident = await request(app).get(url(mine.id, theirAlert.id)).set(w.auth.engA);
      expect(wrongIncident.status).toBe(404);
      const rightIncident = await request(app).get(url(theirs.id, theirAlert.id)).set(w.auth.engA);
      expect(rightIncident.status).toBe(403);
      expect(JSON.stringify(rightIncident.body)).not.toContain('payload');
    });
  });
});
