import type { Role, currentStatus } from '../../../generated/prisma/client.js';
import type { Db } from '../transaction.js';
import { UNRESOLVED_INCIDENT_STATUSES } from '../teams/team.repository.js';
import type { ListUsersQuery } from './user.schema.js';

export function createUser(
  db: Db,
  data: {
    name: string;
    email: string;
    passwordHash: string;
    role: Role;
    teamId: string | null;
    leadId: string | null;
  },
) {
  return db.user.create({ data });
}

export function findUserById(db: Db, id: string) {
  return db.user.findUnique({ where: { id } });
}

/** Fetches `limit + 1` rows so the caller can compute `hasMore`. */
export function listUsersOfTeam(db: Db, teamId: string, query: ListUsersQuery) {
  return db.user.findMany({
    where: { teamId, role: query.role, status: query.status },
    orderBy: [{ [query.orderBy]: query.sort }, { id: query.sort }],
    skip: query.offset,
    take: query.limit + 1,
  });
}

export function updateUser(
  db: Db,
  id: string,
  data: {
    name?: string;
    passwordHash?: string;
    role?: Role;
    status?: currentStatus;
    teamId?: string;
    leadId?: string | null;
  },
) {
  return db.user.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
}

/** Read-only: whether the user is `acknowledgedBy` on an unresolved incident. */
export async function isAssignedToUnresolvedIncident(db: Db, userId: string): Promise<boolean> {
  const found = await db.incident.findFirst({
    where: { acknowledgedById: userId, status: { in: [...UNRESOLVED_INCIDENT_STATUSES] } },
    select: { id: true },
  });
  return found !== null;
}

/** Users (any status) whose `leadId` is this user. */
export function countReportingUsers(db: Db, leadId: string): Promise<number> {
  return db.user.count({ where: { leadId } });
}
