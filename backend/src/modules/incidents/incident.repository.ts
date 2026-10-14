import { Prisma } from '../../generated/prisma/client.js';
import type { Cursor, OrderBy, Sort } from './cursor.js';
import type { Db } from './incidents.common.js';
import type { IncidentStatus, Severity } from './incidents.types.js';

const USER = { select: { id: true, name: true } } as const;

/** The service columns the SLA thresholds are computed from. */
const SERVICE = {
  select: {
    id: true,
    name: true,
    P0ResponseSlaMinutes: true,
    P0ResolutionSlaMinutes: true,
    P1ResponseSlaMinutes: true,
    P1ResolutionSlaMinutes: true,
    P2ResponseSlaMinutes: true,
    P2ResolutionSlaMinutes: true,
    P3ResponseSlaMinutes: true,
    P3ResolutionSlaMinutes: true,
  },
} as const;

const LIST_SELECT = {
  id: true,
  title: true,
  status: true,
  severity: true,
  createdAt: true,
  acknowledgedTimestamp: true,
  resolvedTimestamp: true,
  affectedServiceId: true,
  teamId: true,
  affectedService: SERVICE,
  currentAssignee: USER,
} satisfies Prisma.IncidentSelect;

/** Explicit selection: nothing outside the response shapes is ever read. */
const DETAIL_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  severity: true,
  teamId: true,
  resolutionSummary: true,
  createdAt: true,
  acknowledgedTimestamp: true,
  severityConfirmTimestamp: true,
  resolvedTimestamp: true,
  closedTimestamp: true,
  affectedService: SERVICE,
  currentAssignee: USER,
  acknowledgedBy: USER,
  severityConfirmedBy: USER,
  resolvedBy: USER,
  closedBy: USER,
  alert: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      environment: true,
      sourceSeverity: true,
      initialSeverity: true,
      sourceStatus: true,
      startedTimestamp: true,
      endedTimestamp: true,
      sourceUrl: true,
      alertSource: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.IncidentSelect;

export type IncidentListRow = Prisma.IncidentGetPayload<{ select: typeof LIST_SELECT }>;
export type IncidentDetailRow = Prisma.IncidentGetPayload<{ select: typeof DETAIL_SELECT }>;

export type IncidentScope = { teamId: string; status: IncidentStatus };

export function findIncidentDetail(db: Db, id: string): Promise<IncidentDetailRow | null> {
  return db.incident.findUnique({ where: { id }, select: DETAIL_SELECT });
}

/** The stored triage of one alert, limited to the fields the API may expose. */
export function findTriageByAlertId(db: Db, alertId: string) {
  return db.aITriage.findUnique({
    where: { alertId },
    select: {
      failureStatus: true,
      category: true,
      suggestedSeverity: true,
      confidence: true,
      evidence: true,
      reasoning: true,
      model: true,
      modelVersion: true,
      createdAt: true,
    },
  });
}

export type NewIncident = {
  title: string;
  description: string;
  severity: Severity;
  teamId: string;
  affectedServiceId: string;
};

/**
 * Takes a `FOR SHARE` lock on the team row, so a concurrent team deactivation (which checks for
 * unresolved incidents under `FOR UPDATE`) waits for the transaction that creates the incident.
 */
export async function lockTeamForShare(db: Db, teamId: string): Promise<void> {
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Team" WHERE "id" = ${teamId}::uuid FOR SHARE`);
}

/** Inserts an `OPEN` incident; assignee, acknowledgement, resolution and closure stay `NULL`. */
export async function insertIncident(db: Db, data: NewIncident): Promise<{ id: string }> {
  return db.incident.create({
    data: { ...data, status: 'OPEN' },
    select: { id: true },
  });
}

export function findIncidentScope(db: Db, id: string): Promise<IncidentScope | null> {
  return db.incident.findUnique({ where: { id }, select: { teamId: true, status: true } });
}

/**
 * Takes a `FOR SHARE` lock on the incident row and returns its team and status. Comments do not
 * serialize against each other, but a concurrent change that needs `FOR UPDATE` (such as closing
 * the incident) waits for this transaction. `null` when the incident does not exist.
 */
export async function lockIncidentForShare(db: Db, id: string): Promise<IncidentScope | null> {
  const rows = await db.$queryRaw<IncidentScope[]>(
    Prisma.sql`SELECT "teamId", "status"::text AS "status" FROM "Incident" WHERE "id" = ${id}::uuid FOR SHARE`,
  );
  return rows[0] ?? null;
}

type OrderColumn = { column: Prisma.Sql; cast: (value: string) => Prisma.Sql };

/** Whitelist of sortable columns; the only place identifiers enter the raw SQL. */
const ORDER_COLUMNS: Record<OrderBy, OrderColumn> = {
  createdAt: { column: Prisma.sql`"createdAt"`, cast: (v) => Prisma.sql`${v}::timestamp` },
  severity: { column: Prisma.sql`"severity"`, cast: (v) => Prisma.sql`${v}::"IncidentSeverity"` },
  status: { column: Prisma.sql`"status"`, cast: (v) => Prisma.sql`${v}::"IncidentStates"` },
  title: { column: Prisma.sql`"title"`, cast: (v) => Prisma.sql`${v}::text` },
  affectedServiceId: {
    column: Prisma.sql`"affectedServiceId"`,
    cast: (v) => Prisma.sql`${v}::uuid`,
  },
  teamId: { column: Prisma.sql`"teamId"`, cast: (v) => Prisma.sql`${v}::uuid` },
};

export type IncidentFeedQuery = {
  teamId: string;
  statuses?: IncidentStatus[];
  severities?: Severity[];
  serviceId?: string;
  assigneeId?: string;
  orderBy: OrderBy;
  sort: Sort;
  cursor: Cursor | null;
  /** Rows to fetch: the page size plus one, to learn `hasMore`. */
  take: number;
};

/**
 * Ids of one page of the team's incidents, in feed order. Keyset pagination on
 * `(sort column, id)`, both in the direction of `sort`. Raw SQL because Prisma cannot compare
 * enum columns with `>` / `<`.
 */
export async function findFeedIncidentIds(db: Db, query: IncidentFeedQuery): Promise<string[]> {
  const { column, cast } = ORDER_COLUMNS[query.orderBy];
  const direction = query.sort === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const comparison = query.sort === 'asc' ? Prisma.sql`>` : Prisma.sql`<`;

  const conditions: Prisma.Sql[] = [Prisma.sql`"teamId" = ${query.teamId}::uuid`];
  if (query.statuses) {
    const values = query.statuses.map((value) => Prisma.sql`${value}::"IncidentStates"`);
    conditions.push(Prisma.sql`"status" IN (${Prisma.join(values)})`);
  }
  if (query.severities) {
    const values = query.severities.map((value) => Prisma.sql`${value}::"IncidentSeverity"`);
    conditions.push(Prisma.sql`"severity" IN (${Prisma.join(values)})`);
  }
  if (query.serviceId) conditions.push(Prisma.sql`"affectedServiceId" = ${query.serviceId}::uuid`);
  if (query.assigneeId)
    conditions.push(Prisma.sql`"currentAssigneeId" = ${query.assigneeId}::uuid`);
  if (query.cursor) {
    conditions.push(
      Prisma.sql`(${column}, "id") ${comparison} (${cast(query.cursor.value)}, ${query.cursor.id}::uuid)`,
    );
  }

  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "Incident"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${column} ${direction}, "id" ${direction}
    LIMIT ${query.take}`);
  return rows.map((row) => row.id);
}

/** The rows for `ids`, returned in the order of `ids`. */
export async function findListRows(db: Db, ids: string[]): Promise<IncidentListRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.incident.findMany({ where: { id: { in: ids } }, select: LIST_SELECT });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}
