import type { AuditEventType } from '../../../generated/prisma/enums.js';
import type { Sort } from '../cursor.js';
import type { Db } from '../incidents.common.js';
import { INCIDENT_EVENT_TYPES, type UserSummary } from '../incidents.types.js';
import { isIncidentEventType, type StoredAuditEvent } from './timeline.mapper.js';

/**
 * One page of an incident's audit events, read only. Fetches `limit + 1` rows so the caller can
 * compute `hasMore`; only the 22 incident event types are ever read.
 */
export async function findTimelineEvents(
  db: Db,
  incidentId: string,
  page: { sort: Sort; offset: number; take: number },
): Promise<StoredAuditEvent[]> {
  const rows = await db.auditEvent.findMany({
    where: { incidentId, eventType: { in: [...INCIDENT_EVENT_TYPES] as AuditEventType[] } },
    orderBy: [{ createdAt: page.sort }, { id: page.sort }],
    skip: page.offset,
    take: page.take,
    select: { id: true, eventType: true, actor: true, metadata: true, createdAt: true },
  });
  return rows.flatMap((row) =>
    isIncidentEventType(row.eventType) ? [{ ...row, eventType: row.eventType }] : [],
  );
}

export async function findUserSummaries(db: Db, ids: string[]): Promise<Map<string, UserSummary>> {
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user]));
}
