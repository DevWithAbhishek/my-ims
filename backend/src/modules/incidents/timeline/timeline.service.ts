import { getPrisma } from '../../../infra/db/prisma.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { requireTeam } from '../../identity/index.js';
import { findIncidentScope } from '../incident.repository.js';
import type { TimelineQuery } from '../incident.schema.js';
import { assertIncidentAccess } from '../incidents.common.js';
import type { TimelineItem } from '../incidents.types.js';
import { collectUserIds, toTimelineItems } from './timeline.mapper.js';
import { findTimelineEvents, findUserSummaries } from './timeline.repository.js';

export type TimelinePage = {
  items: TimelineItem[];
  limit: number;
  offset: number;
  hasMore: boolean;
};

/** I11: the incident's append-only history, read only, for every role of the incident's team. */
export async function getTimeline(
  auth: AuthContext,
  incidentId: string,
  query: TimelineQuery,
): Promise<TimelinePage> {
  requireTeam(auth);
  const db = getPrisma();

  const scope = await findIncidentScope(db, incidentId);
  assertIncidentAccess(auth, scope);

  const events = await findTimelineEvents(db, incidentId, {
    sort: query.sort,
    offset: query.offset,
    take: query.limit + 1,
  });
  const page = events.slice(0, query.limit);
  const users = await findUserSummaries(db, collectUserIds(page));

  return {
    items: toTimelineItems(page, users),
    limit: query.limit,
    offset: query.offset,
    hasMore: events.length > query.limit,
  };
}
