import { Prisma } from '../../../generated/prisma/client.js';
import type { Db } from '../incidents.common.js';
import type {
  LockedPostmortem,
  PostmortemContentUpdate,
  PostmortemGenerationStatus,
  PostmortemReviewStatus,
} from './postmortem.types.js';
import type { CreatePostmortemBody } from './postmortem.schema.js';

/** The columns exposed by `PostmortemResponse`; `prompt` and `inputData` are never selected. */
const RESPONSE_SELECT = {
  id: true,
  incidentId: true,
  generationStatus: true,
  reviewStatus: true,
  summary: true,
  impact: true,
  detection: true,
  timeline: true,
  rootCause: true,
  factors: true,
  resolution: true,
  correctiveActions: true,
  preventiveActions: true,
  unknowns: true,
  MTTR: true,
  riskLevel: true,
  model: true,
  modelVersion: true,
  generatedAt: true,
  reviewedAt: true,
  failureReason: true,
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.PostmortemSelect;

export type PostmortemRow = Prisma.PostmortemGetPayload<{ select: typeof RESPONSE_SELECT }>;

/** The incident's postmortem (at most one: `incidentId` is unique), or `null`. */
export function findPostmortemRow(db: Db, incidentId: string): Promise<PostmortemRow | null> {
  return db.postmortem.findUnique({ where: { incidentId }, select: RESPONSE_SELECT });
}

/**
 * `SELECT … FOR UPDATE` on the incident's postmortem row. Always taken after the incident row
 * lock, so every writer locks in the same order. `null` when the incident has no postmortem.
 */
export async function lockPostmortemForUpdate(
  db: Db,
  incidentId: string,
): Promise<LockedPostmortem | null> {
  const rows = await db.$queryRaw<
    {
      id: string;
      generationStatus: PostmortemGenerationStatus;
      reviewStatus: PostmortemReviewStatus;
    }[]
  >(Prisma.sql`
    SELECT "id", "generationStatus"::text AS "generationStatus", "reviewStatus"::text AS "reviewStatus"
    FROM "Postmortem" WHERE "incidentId" = ${incidentId}::uuid FOR UPDATE`);
  return rows[0] ?? null;
}

/** What the MTTR needs, read under the incident lock. `resolvedAt` is set once `RESOLVED`. */
export async function findIncidentTimes(
  db: Db,
  incidentId: string,
): Promise<{ createdAt: Date; resolvedAt: Date }> {
  const row = await db.incident.findUniqueOrThrow({
    where: { id: incidentId },
    select: { createdAt: true, resolvedTimestamp: true },
  });
  if (row.resolvedTimestamp === null) {
    throw new Error('A resolved incident has no resolvedTimestamp');
  }
  return { createdAt: row.createdAt, resolvedAt: row.resolvedTimestamp };
}

/** P2: only the sent fields change (`contributingFactors` is the column `factors`). */
export async function updatePostmortemContent(
  db: Db,
  postmortemId: string,
  fields: PostmortemContentUpdate,
): Promise<void> {
  const { contributingFactors, ...rest } = fields;
  await db.postmortem.update({
    where: { id: postmortemId },
    data: { ...rest, factors: contributingFactors, updatedAt: new Date() },
  });
}

/** P3: the review. The closure of the incident is written by the transition kernel. */
export async function markPostmortemReviewed(
  db: Db,
  postmortemId: string,
  reviewerId: string,
  now: Date,
): Promise<void> {
  await db.postmortem.update({
    where: { id: postmortemId },
    data: { reviewStatus: 'REVIEWED', reviewedById: reviewerId, reviewedAt: now, updatedAt: now },
  });
}

/** P4: back to `GENERATING` with the failure reason cleared. */
export async function markPostmortemGenerating(db: Db, postmortemId: string): Promise<void> {
  await db.postmortem.update({
    where: { id: postmortemId },
    data: { generationStatus: 'GENERATING', failureReason: null, updatedAt: new Date() },
  });
}

/**
 * P5: the `FAILED` row is reused and populated; the failure reason and every provenance column
 * are cleared, and the postmortem is a reviewed draft.
 */
export async function populateManualPostmortem(
  db: Db,
  postmortemId: string,
  content: CreatePostmortemBody,
  mttrMinutes: number,
  reviewerId: string,
  now: Date,
): Promise<void> {
  await db.postmortem.update({
    where: { id: postmortemId },
    data: {
      summary: content.summary,
      impact: content.impact,
      detection: content.detection,
      timeline: content.timeline,
      rootCause: content.rootCause,
      factors: content.contributingFactors,
      resolution: content.resolution,
      correctiveActions: content.correctiveActions,
      preventiveActions: content.preventiveActions,
      unknowns: content.unknowns ?? null,
      riskLevel: content.riskLevel,
      MTTR: mttrMinutes,
      failureReason: null,
      model: null,
      modelVersion: null,
      prompt: null,
      inputData: null,
      generatedAt: null,
      generationStatus: 'DRAFT',
      reviewStatus: 'REVIEWED',
      reviewedById: reviewerId,
      reviewedAt: now,
      updatedAt: now,
    },
  });
}
