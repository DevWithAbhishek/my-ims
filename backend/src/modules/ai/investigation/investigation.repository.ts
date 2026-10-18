import { Prisma } from '../../../generated/prisma/client.js';
import type {
  EvidenceType,
  IncidentSeverity,
  InvestigationStatus,
} from '../../../generated/prisma/enums.js';
import type { TransactionClient } from '../../../infra/db/prisma.js';
import type { IncidentSource, PostmortemSource } from './investigation.candidates.js';
import type { InvestigationFailureReason } from './investigation.failure.js';
import type { InvestigationBrief, ValidatedEvidence } from './investigation.output.js';

type Db = TransactionClient;

/** What an endpoint needs of the incident: its team (the gate) and nothing else. */
export function findIncidentScope(db: Db, incidentId: string): Promise<{ teamId: string } | null> {
  return db.incident.findUnique({ where: { id: incidentId }, select: { teamId: true } });
}

const userSummarySelect = { id: true, name: true } as const;

const listSelect = {
  id: true,
  incidentId: true,
  status: true,
  createdAt: true,
  completedAt: true,
  failureReason: true,
  model: true,
  modelVersion: true,
  requestedBy: { select: userSummarySelect },
} as const;

const detailSelect = {
  ...listSelect,
  result: true,
  evidences: {
    select: {
      id: true,
      evidenceType: true,
      sourceType: true,
      sourceReference: true,
      relevanceInfo: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.InvestigationSelect;

export type InvestigationListRow = Prisma.InvestigationGetPayload<{ select: typeof listSelect }>;
export type InvestigationDetailRow = Prisma.InvestigationGetPayload<{
  select: typeof detailSelect;
}>;

export type StoredInvestigationKey = {
  id: string;
  incidentId: string;
  requestedById: string;
};

export type NewInvestigation = {
  idempotencyKey: string;
  requestedById: string;
  incidentId: string;
  input: Prisma.InputJsonObject;
};

export function insertInvestigation(db: Db, data: NewInvestigation): Promise<{ id: string }> {
  return db.investigation.create({ data, select: { id: true } });
}

export function findInvestigationByKey(
  db: Db,
  idempotencyKey: string,
): Promise<StoredInvestigationKey | null> {
  return db.investigation.findUnique({
    where: { idempotencyKey },
    select: { id: true, incidentId: true, requestedById: true },
  });
}

export function findInvestigationDetail(
  db: Db,
  incidentId: string,
  investigationId: string,
): Promise<InvestigationDetailRow | null> {
  return db.investigation.findFirst({
    where: { id: investigationId, incidentId },
    select: detailSelect,
  });
}

/** Offset page of one incident's investigations; the tie-breaker is `id` in the same direction. */
export function findInvestigationPage(
  db: Db,
  incidentId: string,
  page: { sort: 'asc' | 'desc'; offset: number; take: number },
): Promise<InvestigationListRow[]> {
  return db.investigation.findMany({
    where: { incidentId },
    select: listSelect,
    orderBy: [{ createdAt: page.sort }, { id: page.sort }],
    skip: page.offset,
    take: page.take,
  });
}

// --- worker --------------------------------------------------------------------------------

export type InvestigationForWork = {
  id: string;
  status: InvestigationStatus;
  incidentId: string;
  requestedById: string;
  input: Prisma.JsonValue;
};

export function findInvestigationForWork(
  db: Db,
  investigationId: string,
): Promise<InvestigationForWork | null> {
  return db.investigation.findUnique({
    where: { id: investigationId },
    select: { id: true, status: true, incidentId: true, requestedById: true, input: true },
  });
}

/** `REQUESTED` or an interrupted `RUNNING` becomes `RUNNING`; a terminal row is untouched (0). */
export async function claimInvestigation(db: Db, investigationId: string): Promise<number> {
  const claimed = await db.investigation.updateMany({
    where: { id: investigationId, status: { in: ['REQUESTED', 'RUNNING'] } },
    data: { status: 'RUNNING' },
  });
  return claimed.count;
}

/** A retryable failure with attempts left: back to `REQUESTED` so the next attempt claims it. */
export async function resetToRequested(db: Db, investigationId: string): Promise<void> {
  await db.investigation.updateMany({
    where: { id: investigationId, status: 'RUNNING' },
    data: { status: 'REQUESTED' },
  });
}

/** Terminal failure: a completed investigation is never overwritten. */
export async function markInvestigationFailed(
  db: Db,
  investigationId: string,
  reason: InvestigationFailureReason,
): Promise<void> {
  await db.investigation.updateMany({
    where: { id: investigationId, status: { in: ['REQUESTED', 'RUNNING'] } },
    data: { status: 'FAILED', failureReason: reason },
  });
}

export type IncidentForInvestigation = IncidentSource & { teamId: string; serviceId: string };

export async function findIncidentForInvestigation(
  db: Db,
  incidentId: string,
): Promise<IncidentForInvestigation | null> {
  const row = await db.incident.findUnique({
    where: { id: incidentId },
    select: { description: true, severity: true, teamId: true, affectedServiceId: true },
  });
  if (row === null) return null;
  return {
    incidentId,
    description: row.description,
    severity: row.severity as IncidentSeverity,
    teamId: row.teamId,
    serviceId: row.affectedServiceId,
  };
}

/**
 * The past reviewed postmortems of the same service, in the incident's own team, excluding the
 * incident itself: most recent review first, at most `limit`. Only reviewed postmortems qualify,
 * and only the allow-listed columns are selected.
 */
export async function findReviewedPostmortems(
  db: Db,
  scope: { teamId: string; serviceId: string; excludeIncidentId: string; limit: number },
): Promise<PostmortemSource[]> {
  return db.postmortem.findMany({
    where: {
      reviewStatus: 'REVIEWED',
      incidentId: { not: scope.excludeIncidentId },
      incident: { affectedServiceId: scope.serviceId, teamId: scope.teamId },
    },
    select: {
      incidentId: true,
      summary: true,
      impact: true,
      rootCause: true,
      factors: true,
      resolution: true,
    },
    orderBy: [{ reviewedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: scope.limit,
  });
}

/** Locks the investigation row `FOR UPDATE` and returns its status (`null` when it is gone). */
export async function lockInvestigationStatus(
  tx: Db,
  investigationId: string,
): Promise<InvestigationStatus | null> {
  const rows = await tx.$queryRaw<{ status: InvestigationStatus }[]>(
    Prisma.sql`SELECT "status"::text AS status FROM "Investigation" WHERE "id" = ${investigationId}::uuid FOR UPDATE`,
  );
  return rows[0]?.status ?? null;
}

export type InvestigationSuccess = {
  evidence: readonly ValidatedEvidence[];
  brief: InvestigationBrief;
  model: string;
  modelVersion: string;
  completedAt: Date;
};

/** Evidence rows carry the generated candidate id, so the brief's citations resolve to them. */
export async function storeInvestigationSuccess(
  tx: Db,
  investigationId: string,
  success: InvestigationSuccess,
): Promise<void> {
  await tx.evidence.createMany({
    data: success.evidence.map((item) => ({
      id: item.id,
      sourceType: item.sourceType,
      sourceReference: item.sourceReference,
      relevanceInfo: item.relevance,
      evidenceType: item.evidenceType as EvidenceType,
      investigationId,
      incidentId: item.incidentId,
    })),
  });
  await tx.investigation.update({
    where: { id: investigationId },
    data: {
      status: 'COMPLETED',
      result: success.brief as Prisma.InputJsonObject,
      completedAt: success.completedAt,
      model: success.model,
      modelVersion: success.modelVersion,
    },
  });
}

// --- retention -----------------------------------------------------------------------------

/**
 * One retention batch in one transaction: the oldest investigations created before `cutoff` (any
 * status) and their evidence, evidence first. Returns how many investigations were deleted.
 */
export async function deleteExpiredInvestigations(
  tx: Db,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const expired = await tx.investigation.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
  });
  if (expired.length === 0) return 0;
  const ids = expired.map((row) => row.id);
  await tx.evidence.deleteMany({ where: { investigationId: { in: ids } } });
  const removed = await tx.investigation.deleteMany({ where: { id: { in: ids } } });
  return removed.count;
}
