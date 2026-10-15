import { Prisma } from '../../../generated/prisma/client.js';
import type { Db } from '../incidents.common.js';
import type { IncidentStatus, Severity } from '../incidents.types.js';
import type { IncidentChanges, LockedIncident, TransitionScope } from './lifecycle.types.js';
import type { AssigneeCandidate } from './lifecycle.rules.js';

/** Read before the transaction opens: the team gate and the pre-lock gates use it. */
export function findTransitionScope(db: Db, id: string): Promise<TransitionScope | null> {
  return db.incident.findUnique({
    where: { id },
    select: { teamId: true, affectedServiceId: true, status: true },
  });
}

/** Bounds the wait for any lock taken in this transaction (`SET LOCAL`, gone at commit). */
export async function setLockTimeout(db: Db, milliseconds: number): Promise<void> {
  await db.$queryRaw(Prisma.sql`SELECT set_config('lock_timeout', ${`${milliseconds}ms`}, true)`);
}

/** `SELECT … FOR UPDATE` on the incident: the state is read under the lock. `null` if missing. */
export async function lockIncidentForUpdate(db: Db, id: string): Promise<LockedIncident | null> {
  const rows = await db.$queryRaw<
    {
      id: string;
      teamId: string;
      affectedServiceId: string;
      status: IncidentStatus;
      severity: Severity;
      currentAssigneeId: string | null;
      acknowledgedById: string | null;
    }[]
  >(Prisma.sql`
    SELECT "id", "teamId", "affectedServiceId", "status"::text AS "status",
           "severity"::text AS "severity", "currentAssigneeId", "acknowledgedById"
    FROM "Incident" WHERE "id" = ${id}::uuid FOR UPDATE`);
  return rows[0] ?? null;
}

/**
 * `FOR SHARE` on a user row, returning what assignment eligibility needs (`null` if missing). A
 * concurrent U4 (which locks the user `FOR UPDATE` before checking `acknowledgedBy`) waits for
 * this transaction, so a user cannot be deactivated or moved between this check and the commit.
 */
export async function lockUserForShare(db: Db, id: string): Promise<AssigneeCandidate | null> {
  const rows = await db.$queryRaw<AssigneeCandidate[]>(Prisma.sql`
    SELECT "role"::text AS "role", "status"::text AS "status", "teamId"
    FROM "User" WHERE "id" = ${id}::uuid FOR SHARE`);
  return rows[0] ?? null;
}

export async function updateIncident(db: Db, id: string, changes: IncidentChanges): Promise<void> {
  await db.incident.update({ where: { id }, data: { ...changes, updatedAt: new Date() } });
}

/** Resolve frees the identity of every alert of the incident, so a new firing opens a new incident. */
export async function clearActiveIdentityKeys(db: Db, incidentId: string): Promise<void> {
  await db.alert.updateMany({
    where: { incidentId, activeIdentityKey: { not: null } },
    data: { activeIdentityKey: null, updatedAt: new Date() },
  });
}

/** `Postmortem.incidentId` is unique: a second postmortem for the incident cannot exist. */
export function insertGeneratingPostmortem(db: Db, incidentId: string): Promise<{ id: string }> {
  return db.postmortem.create({
    data: { incidentId, generationStatus: 'GENERATING', reviewStatus: 'PENDING' },
    select: { id: true },
  });
}
