import type { Db } from '../transaction.js';
import type { ListTeamsQuery } from './team.schema.js';

/** Statuses that make an incident "unresolved". */
export const UNRESOLVED_INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] as const;

export function createTeam(db: Db, name: string) {
  return db.team.create({ data: { name } });
}

export function findTeamById(db: Db, id: string) {
  return db.team.findUnique({ where: { id } });
}

/** Fetches `limit + 1` rows so the caller can compute `hasMore`. */
export function listTeams(db: Db, query: ListTeamsQuery) {
  return db.team.findMany({
    orderBy: [{ [query.orderBy]: query.sort }, { id: query.sort }],
    skip: query.offset,
    take: query.limit + 1,
  });
}

export function updateTeam(
  db: Db,
  id: string,
  data: { name?: string; status?: 'ACTIVE' | 'DEACTIVATED' },
) {
  return db.team.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
}

/** Read-only: unresolved incidents of the team (the `Incident` table belongs to another slice). */
export async function hasUnresolvedIncidents(db: Db, teamId: string): Promise<boolean> {
  const found = await db.incident.findFirst({
    where: { teamId, status: { in: [...UNRESOLVED_INCIDENT_STATUSES] } },
    select: { id: true },
  });
  return found !== null;
}

/** Read-only: services still attached to the team, whatever their status. */
export async function hasAttachedServices(db: Db, teamId: string): Promise<boolean> {
  const found = await db.appService.findFirst({ where: { teamId }, select: { id: true } });
  return found !== null;
}

/** Removes every user from the team (`teamId` and `leadId` to null); returns the affected ids. */
export async function detachUsersFromTeam(db: Db, teamId: string): Promise<string[]> {
  const members = await db.user.findMany({ where: { teamId }, select: { id: true } });
  const ids = members.map((member) => member.id);
  if (ids.length > 0) {
    await db.user.updateMany({
      where: { id: { in: ids } },
      data: { teamId: null, leadId: null, updatedAt: new Date() },
    });
  }
  return ids;
}
