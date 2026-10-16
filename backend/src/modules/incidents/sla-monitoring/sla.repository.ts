import { Prisma } from '../../../generated/prisma/client.js';
import type { Db } from '../incidents.common.js';
import type { IncidentStatus, Severity } from '../incidents.types.js';
import type { SlaThresholds } from '../sla.js';
import type { PolicyUserFacts } from '../../appService/index.js';
import {
  ALL_MILESTONES,
  ESCALATION_LEVELS,
  failureMilestone,
  levelMilestone,
  milestoneKey,
  type EscalationLevel,
  type Milestone,
} from './sla.milestones.js';
import type { SlaSnapshot } from './sla.calculator.js';

export type SlaIncident = SlaSnapshot & {
  id: string;
  teamId: string;
  affectedServiceId: string;
};

type IncidentRow = {
  id: string;
  status: IncidentStatus;
  severity: Severity;
  createdAt: Date;
  teamId: string;
  affectedServiceId: string;
  p0r: number;
  p0s: number;
  p1r: number;
  p1s: number;
  p2r: number;
  p2s: number;
  p3r: number;
  p3s: number;
};

function toIncident(row: IncidentRow): SlaIncident {
  const thresholds: SlaThresholds = {
    P0: { responseMinutes: row.p0r, resolutionMinutes: row.p0s },
    P1: { responseMinutes: row.p1r, resolutionMinutes: row.p1s },
    P2: { responseMinutes: row.p2r, resolutionMinutes: row.p2s },
    P3: { responseMinutes: row.p3r, resolutionMinutes: row.p3s },
  };
  return {
    id: row.id,
    status: row.status,
    severity: row.severity,
    createdAt: row.createdAt,
    teamId: row.teamId,
    affectedServiceId: row.affectedServiceId,
    thresholds,
  };
}

/**
 * The incident with the service's eight SLA minute columns. With `lock` the incident row is taken
 * `FOR UPDATE` (the same lock the transition kernel takes), so status, severity and
 * acknowledgement are read under the lock; the service row is not locked.
 */
export async function findSlaIncident(
  db: Db,
  id: string,
  options: { lock: boolean },
): Promise<SlaIncident | null> {
  const rows = await db.$queryRaw<IncidentRow[]>(Prisma.sql`
    SELECT i."id", i."status"::text AS "status", i."severity"::text AS "severity", i."createdAt",
           i."teamId", i."affectedServiceId",
           s."P0ResponseSlaMinutes" AS "p0r", s."P0ResolutionSlaMinutes" AS "p0s",
           s."P1ResponseSlaMinutes" AS "p1r", s."P1ResolutionSlaMinutes" AS "p1s",
           s."P2ResponseSlaMinutes" AS "p2r", s."P2ResolutionSlaMinutes" AS "p2s",
           s."P3ResponseSlaMinutes" AS "p3r", s."P3ResolutionSlaMinutes" AS "p3s"
    FROM "Incident" i
    JOIN "AppService" s ON s."id" = i."affectedServiceId"
    WHERE i."id" = ${id}::uuid
    ${options.lock ? Prisma.sql`FOR UPDATE OF i` : Prisma.empty}`);
  return rows[0] ? toIncident(rows[0]) : null;
}

/** Milestones already recorded: the incident's `Notification` rows with a milestone key. */
export async function findRecordedMilestones(db: Db, incidentId: string): Promise<Set<Milestone>> {
  const byKey = new Map(ALL_MILESTONES.map((m) => [milestoneKey(incidentId, m), m]));
  const rows = await db.notification.findMany({
    where: { incidentId, idempotencyKey: { in: [...byKey.keys()] } },
    select: { idempotencyKey: true },
  });
  const recorded = new Set<Milestone>();
  for (const row of rows) {
    const milestone = byKey.get(row.idempotencyKey);
    if (milestone) recorded.add(milestone);
  }
  return recorded;
}

export type Responder = { userId: string; facts: PolicyUserFacts };

/** The user of an escalation level (`level1`, `level2`, `level3`, `fallbackAdmin` for level 4). */
export async function findResponder(
  db: Db,
  serviceId: string,
  level: EscalationLevel,
): Promise<Responder | null> {
  const select = { id: true, role: true, status: true, teamId: true } as const;
  const policy = await db.escalationPolicy.findFirst({
    where: { appService: { id: serviceId } },
    select: {
      level1: { select },
      level2: { select },
      level3: { select },
      fallbackAdmin: { select },
    },
  });
  if (!policy) return null;
  const user = [policy.level1, policy.level2, policy.level3, policy.fallbackAdmin][level - 1];
  return {
    userId: user.id,
    facts: { role: user.role, status: user.status, teamId: user.teamId },
  };
}

/**
 * The key format is owned by the notification contract; its pieces around the incident id are read
 * off a key built for a placeholder id, so SQL and TypeScript cannot drift apart.
 */
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

function recordedInSql(milestone: Milestone): Prisma.Sql {
  const [prefix, suffix] = milestoneKey(PLACEHOLDER_ID, milestone).split(PLACEHOLDER_ID);
  return Prisma.sql`EXISTS (SELECT 1 FROM "Notification" n
    WHERE n."idempotencyKey" = ${prefix}::text || t."id"::text || ${suffix}::text)`;
}

const notRecorded = (milestone: Milestone): Prisma.Sql =>
  Prisma.sql`NOT ${recordedInSql(milestone)}`;

const levelPending = (level: EscalationLevel): Prisma.Sql =>
  Prisma.sql`(${notRecorded(levelMilestone(level))} AND ${notRecorded(failureMilestone(level))})`;

/**
 * The scanner's safety net: unresolved incidents with a due milestone that is not recorded (the
 * same rules as `nextStep`, expressed in SQL against the same clock reading `now`). Only ids are
 * returned; each incident is then evaluated under its lock.
 */
export async function findScanCandidates(db: Db, now: Date): Promise<string[]> {
  const nowTs = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const due = (column: string, perMinuteMs: number, strict: boolean): Prisma.Sql =>
    strict
      ? Prisma.sql`${nowTs} > t."createdAt" + (${Prisma.raw(column)}::double precision * ${perMinuteMs}) * interval '1 millisecond'`
      : Prisma.sql`${nowTs} >= t."createdAt" + (${Prisma.raw(column)}::double precision * ${perMinuteMs}) * interval '1 millisecond'`;

  const anyLevelPending = Prisma.join(ESCALATION_LEVELS.map(levelPending), ' OR ');

  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH t AS (
      SELECT i."id", i."status"::text AS "status", i."createdAt",
        CASE i."severity"::text WHEN 'P0' THEN s."P0ResponseSlaMinutes"
          WHEN 'P1' THEN s."P1ResponseSlaMinutes" WHEN 'P2' THEN s."P2ResponseSlaMinutes"
          ELSE s."P3ResponseSlaMinutes" END AS "resp",
        CASE i."severity"::text WHEN 'P0' THEN s."P0ResolutionSlaMinutes"
          WHEN 'P1' THEN s."P1ResolutionSlaMinutes" WHEN 'P2' THEN s."P2ResolutionSlaMinutes"
          ELSE s."P3ResolutionSlaMinutes" END AS "resol"
      FROM "Incident" i
      JOIN "AppService" s ON s."id" = i."affectedServiceId"
      WHERE i."status" IN ('OPEN', 'ACKNOWLEDGED', 'MITIGATING')
    )
    SELECT t."id" FROM t
    WHERE (
      t."status" = 'OPEN' AND (
        (${due('t."resp"', 48_000, false)} AND ${notRecorded('RESPONSE_WARNING')})
        OR (${due('t."resp"', 60_000, true)} AND ${notRecorded('RESPONSE_BREACH')})
        OR (${recordedInSql('RESPONSE_BREACH')} AND (${anyLevelPending}))
      )
    ) OR (
      (${due('t."resol"', 48_000, false)} AND ${notRecorded('RESOLUTION_WARNING')})
      OR (${due('t."resol"', 60_000, true)} AND ${notRecorded('RESOLUTION_BREACH')})
    )
    ORDER BY t."createdAt", t."id"`);
  return rows.map((row) => row.id);
}
