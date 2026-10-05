import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { getPrisma } from '../../src/infra/db/prisma';
import { getRedis } from '../../src/infra/redis/redis';
import { hashPassword } from '../../src/modules/identity/auth/password';
import { resetDatabase } from './db';

export const PASSWORD = 'Passw0rd!';

let passwordHash: Promise<string> | undefined;

/** Empties PostgreSQL and the test Redis database. */
export async function resetState(): Promise<void> {
  await resetDatabase();
  await getRedis().flushdb();
}

type Role = 'ENGINEER' | 'TEAM_LEAD' | 'ADMIN';

export async function createTeam(name = `team-${randomUUID().slice(0, 8)}`, status = 'ACTIVE') {
  return getPrisma().team.create({ data: { name, status: status as 'ACTIVE' | 'DEACTIVATED' } });
}

export async function createUser(
  overrides: {
    email?: string;
    name?: string;
    role?: Role;
    status?: 'ACTIVE' | 'DEACTIVATED';
    teamId?: string | null;
    leadId?: string | null;
  } = {},
) {
  passwordHash ??= hashPassword(PASSWORD);
  return getPrisma().user.create({
    data: {
      name: overrides.name ?? 'Test User',
      email: overrides.email ?? `u-${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: await passwordHash,
      role: overrides.role ?? 'ENGINEER',
      status: overrides.status ?? 'ACTIVE',
      teamId: overrides.teamId ?? null,
      leadId: overrides.leadId ?? null,
    },
  });
}

export function cookieValue(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? '');
  return header.split(';')[0].split('=').slice(1).join('=');
}

export async function login(app: Express, email: string, password = PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = (res.headers['authorization'] as string).replace('Bearer ', '');
  return { token, refresh: cookieValue(res.headers['set-cookie']), res };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** An Admin of a fresh team, already logged in. */
export async function adminSession(app: Express, teamId: string | null = null) {
  const admin = await createUser({ role: 'ADMIN', teamId });
  return { admin, ...(await login(app, admin.email)) };
}

export async function sessionFor(
  app: Express,
  role: Role,
  teamId: string | null,
  extra: { leadId?: string | null } = {},
) {
  const user = await createUser({ role, teamId, ...extra });
  return { user, ...(await login(app, user.email)) };
}

/** A service (with its escalation policy) owned by `teamId`. */
export async function createService(teamId: string, adminForPolicy: string) {
  const db = getPrisma();
  const policy = await db.escalationPolicy.create({
    data: {
      level1Id: adminForPolicy,
      level2Id: adminForPolicy,
      level3Id: adminForPolicy,
      fallbackAdminId: adminForPolicy,
    },
  });
  return db.appService.create({
    data: {
      name: `svc-${randomUUID().slice(0, 8)}`,
      teamId,
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
}

export async function createIncident(
  teamId: string,
  serviceId: string,
  status: 'OPEN' | 'ACKNOWLEDGED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED',
  acknowledgedById: string | null = null,
) {
  return getPrisma().incident.create({
    data: {
      title: 'incident',
      description: 'incident',
      severity: 'P1',
      status,
      teamId,
      affectedServiceId: serviceId,
      acknowledgedById,
    },
  });
}
