import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { getPrisma } from '../../src/infra/db/prisma';
import { bearer, createService, createTeam, createUser, login } from './identity';

type Severity = 'P0' | 'P1' | 'P2' | 'P3';
type Status = 'OPEN' | 'ACKNOWLEDGED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';

export async function createAlertSource(name = `source-${randomUUID().slice(0, 8)}`) {
  return getPrisma().alertSource.create({
    data: { name, sourceType: 'GENERIC', configuration: {} },
  });
}

export async function createAlert(opts: {
  incidentId: string;
  serviceId: string;
  alertSourceId: string;
  createdAt?: Date;
  name?: string;
  originalPayload?: object;
}) {
  return getPrisma().alert.create({
    data: {
      name: opts.name ?? 'cpu high',
      environment: 'production',
      startedTimestamp: new Date('2026-01-01T00:00:00.000Z'),
      originalPayload: opts.originalPayload ?? { note: 'payload' },
      alertSourceId: opts.alertSourceId,
      affectedServiceId: opts.serviceId,
      incidentId: opts.incidentId,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

export async function createTriage(
  alertId: string,
  data: {
    failureStatus: 'PENDING' | 'FAILED' | 'SUCCESS';
    summary?: string;
    rawOutput?: object;
    reasoning?: string;
    category?: string;
    suggestedSeverity?: Severity;
    confidence?: number;
    evidence?: object;
  },
) {
  return getPrisma().aITriage.create({
    data: { alertId, model: 'test-model', modelVersion: '1', ...data },
  });
}

export async function createIncidentWith(opts: {
  teamId: string;
  serviceId: string;
  status?: Status;
  severity?: Severity;
  title?: string;
  createdAt?: Date;
  currentAssigneeId?: string | null;
  acknowledgedById?: string | null;
  acknowledgedAt?: Date | null;
}) {
  return getPrisma().incident.create({
    data: {
      title: opts.title ?? 'incident',
      description: 'description',
      severity: opts.severity ?? 'P1',
      status: opts.status ?? 'OPEN',
      teamId: opts.teamId,
      affectedServiceId: opts.serviceId,
      currentAssigneeId: opts.currentAssigneeId ?? null,
      acknowledgedById: opts.acknowledgedById ?? null,
      acknowledgedTimestamp: opts.acknowledgedAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

/** Two teams, their users (all roles for A, an engineer for B), a service each, all logged in. */
export async function incidentWorld(app: Express) {
  const teamA = await createTeam();
  const teamB = await createTeam();
  const adminA = await createUser({ role: 'ADMIN', teamId: teamA.id, name: 'Ada Admin' });
  const leadA = await createUser({ role: 'TEAM_LEAD', teamId: teamA.id, name: 'Lena Lead' });
  const engA = await createUser({ role: 'ENGINEER', teamId: teamA.id, name: 'Eli Engineer' });
  const adminB = await createUser({ role: 'ADMIN', teamId: teamB.id, name: 'Bea Admin' });
  const engB = await createUser({ role: 'ENGINEER', teamId: teamB.id, name: 'Ben Engineer' });
  const noTeamAdmin = await createUser({ role: 'ADMIN', teamId: null });
  const serviceA = await createService(teamA.id, adminA.id);
  const serviceA2 = await createService(teamA.id, adminA.id);
  const serviceB = await createService(teamB.id, adminB.id);

  const tokenOf = async (user: { email: string }) => bearer((await login(app, user.email)).token);
  return {
    teamA,
    teamB,
    adminA,
    leadA,
    engA,
    engB,
    noTeamAdmin,
    serviceA,
    serviceA2,
    serviceB,
    auth: {
      adminA: await tokenOf(adminA),
      leadA: await tokenOf(leadA),
      engA: await tokenOf(engA),
      engB: await tokenOf(engB),
      noTeam: await tokenOf(noTeamAdmin),
    },
  };
}
