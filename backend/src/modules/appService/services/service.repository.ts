import { Prisma } from '../../../generated/prisma/client.js';
import type { SlaValues } from '../sla.rules.js';
import type { Db } from '../transaction.js';
import type { ListServicesQuery } from './service.schema.js';

/** Statuses that make an incident "unresolved". */
export const UNRESOLVED_INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'MITIGATING'] as const;

export type NewService = SlaValues & {
  name: string;
  defaultSeverity?: 'P0' | 'P1' | 'P2' | 'P3';
  teamId: string;
  escalationPolicyId: string;
};

export function insertService(db: Db, data: NewService) {
  return db.appService.create({ data });
}

export function findServiceById(db: Db, id: string) {
  return db.appService.findUnique({ where: { id } });
}

/** Fetches `limit + 1` rows so the caller can compute `hasMore`. */
export function listServices(db: Db, query: ListServicesQuery & { teamId?: string }) {
  return db.appService.findMany({
    where: query.teamId === undefined ? {} : { teamId: query.teamId },
    orderBy: [{ [query.orderBy]: query.sort }, { id: query.sort }],
    skip: query.offset,
    take: query.limit + 1,
  });
}

export function updateService(db: Db, id: string, data: Prisma.AppServiceUncheckedUpdateInput) {
  return db.appService.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
}

/** Read-only: any incident of the service, whatever its status. */
export async function hasAnyIncident(db: Db, serviceId: string): Promise<boolean> {
  const found = await db.incident.findFirst({
    where: { affectedServiceId: serviceId },
    select: { id: true },
  });
  return found !== null;
}

/** Read-only: incidents of the service that are `OPEN`, `ACKNOWLEDGED` or `MITIGATING`. */
export async function hasUnresolvedIncidents(db: Db, serviceId: string): Promise<boolean> {
  const found = await db.incident.findFirst({
    where: { affectedServiceId: serviceId, status: { in: [...UNRESOLVED_INCIDENT_STATUSES] } },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Takes a `FOR SHARE` lock on the team row, so a concurrent team deactivation (which checks the
 * attached services under `FOR UPDATE`) waits for this transaction. `null` when the team is absent.
 */
export async function lockTeamForShare(
  db: Db,
  teamId: string,
): Promise<{ status: 'ACTIVE' | 'DEACTIVATED' } | null> {
  const rows = await db.$queryRaw<{ status: 'ACTIVE' | 'DEACTIVATED' }[]>(
    Prisma.sql`SELECT "status"::text AS "status" FROM "Team" WHERE "id" = ${teamId}::uuid FOR SHARE`,
  );
  return rows[0] ?? null;
}
