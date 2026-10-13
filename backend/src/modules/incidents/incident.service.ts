import { getPrisma } from '../../infra/db/prisma.js';
import { requireTeam } from '../identity/index.js';
import type { AuthContext } from '../../shared/types/auth-context.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { toIncidentDetail, toListItem, sortValueOf } from './incident.mapper.js';
import type { ListIncidentsQuery } from './incident.schema.js';
import {
  findFeedIncidentIds,
  findIncidentDetail,
  findListRows,
  findTriageByAlertId,
} from './incident.repository.js';
import { assertIncidentAccess } from './incidents.common.js';
import type { IncidentDetailResponse, IncidentListItem } from './incidents.types.js';

export type IncidentFeedPage = {
  items: IncidentListItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** I1: the caller's own team only; the team always comes from the token, never from the request. */
export async function listIncidents(
  auth: AuthContext,
  query: ListIncidentsQuery,
): Promise<IncidentFeedPage> {
  const teamId = requireTeam(auth);
  const cursor =
    query.cursor !== undefined
      ? decodeCursor(query.cursor, { orderBy: query.orderBy, sort: query.sort })
      : null;

  const db = getPrisma();
  const ids = await findFeedIncidentIds(db, {
    teamId,
    statuses: query.status,
    severities: query.severity,
    serviceId: query.serviceId,
    assigneeId: query.assigneeId,
    orderBy: query.orderBy,
    sort: query.sort,
    cursor,
    take: query.limit + 1,
  });
  const hasMore = ids.length > query.limit;
  const rows = await findListRows(db, ids.slice(0, query.limit));

  const last = rows.at(-1);
  const now = new Date();
  return {
    items: rows.map((row) => toListItem(row, now)),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            orderBy: query.orderBy,
            sort: query.sort,
            value: sortValueOf(last, query.orderBy),
            id: last.id,
          })
        : null,
  };
}

/** I2: the incident, its alerts and the advisory triage of its latest accepted alert. */
export async function getIncident(
  auth: AuthContext,
  incidentId: string,
): Promise<IncidentDetailResponse> {
  requireTeam(auth);
  const db = getPrisma();

  const row = await findIncidentDetail(db, incidentId);
  assertIncidentAccess(auth, row);

  const latestAlert = row.alert.at(-1);
  const triage = latestAlert ? await findTriageByAlertId(db, latestAlert.id) : null;
  return toIncidentDetail(row, triage, new Date());
}
