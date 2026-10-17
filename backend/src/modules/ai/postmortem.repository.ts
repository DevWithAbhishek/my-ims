import { Prisma } from '../../generated/prisma/client.js';
import type {
  IncidentSeverity,
  IncidentStates,
  PostmortemGenerationStatus,
} from '../../generated/prisma/enums.js';
import type { TransactionClient } from '../../infra/db/prisma.js';
import type { PostmortemFailureReason } from './postmortem.failure.js';
import type { PostmortemOutput } from './postmortem.output.js';

type Db = TransactionClient;

/**
 * What generation reads: the postmortem's state, the incident's status and times, and exactly the
 * allow-listed data (incident description and severity, every comment's title and description).
 */
export type PostmortemForGeneration = {
  id: string;
  incidentId: string;
  generationStatus: PostmortemGenerationStatus;
  incident: {
    status: IncidentStates;
    severity: IncidentSeverity;
    description: string;
    createdAt: Date;
    resolvedTimestamp: Date | null;
    comments: { title: string | null; description: string }[];
  };
};

export function findPostmortemForGeneration(
  db: Db,
  postmortemId: string,
): Promise<PostmortemForGeneration | null> {
  return db.postmortem.findUnique({
    where: { id: postmortemId },
    select: {
      id: true,
      incidentId: true,
      generationStatus: true,
      incident: {
        select: {
          status: true,
          severity: true,
          description: true,
          createdAt: true,
          resolvedTimestamp: true,
          comments: {
            select: { title: true, description: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      },
    },
  });
}

/**
 * Locks the incident `FOR SHARE` and then the postmortem `FOR UPDATE`, the same order as every
 * other writer (incident first), and returns the postmortem's generation status. Of two parallel
 * jobs the second waits and then sees the first one's result.
 */
export async function lockPostmortemForResult(
  tx: Db,
  incidentId: string,
  postmortemId: string,
): Promise<PostmortemGenerationStatus | null> {
  await tx.$queryRaw(
    Prisma.sql`SELECT 1 FROM "Incident" WHERE "id" = ${incidentId}::uuid FOR SHARE`,
  );
  const rows = await tx.$queryRaw<{ status: PostmortemGenerationStatus }[]>(
    Prisma.sql`SELECT "generationStatus"::text AS status FROM "Postmortem" WHERE "id" = ${postmortemId}::uuid FOR UPDATE`,
  );
  return rows[0]?.status ?? null;
}

export type GeneratedPostmortem = {
  output: PostmortemOutput;
  mttrMinutes: number;
  model: string;
  modelVersion: string;
  /** The instructions sent to the provider (stored, never exposed). */
  prompt: string;
  /** The JSON of the exact input sent to the provider (stored, never exposed). */
  inputData: string;
  generatedAt: Date;
};

/** Stores the validated draft; guarded by `generationStatus = GENERATING`. `false`: not stored. */
export async function storeGeneratedPostmortem(
  tx: Db,
  postmortemId: string,
  generated: GeneratedPostmortem,
): Promise<boolean> {
  const { output } = generated;
  const result = await tx.postmortem.updateMany({
    where: { id: postmortemId, generationStatus: 'GENERATING' },
    data: {
      summary: output.summary,
      impact: output.impact,
      detection: output.detection,
      timeline: output.timeline,
      rootCause: output.rootCause,
      factors: output.contributingFactors,
      resolution: output.resolution,
      correctiveActions: output.correctiveActions,
      preventiveActions: output.preventiveActions,
      unknowns: output.unknowns,
      riskLevel: output.riskLevel,
      MTTR: generated.mttrMinutes,
      model: generated.model,
      modelVersion: generated.modelVersion,
      prompt: generated.prompt,
      inputData: generated.inputData,
      generatedAt: generated.generatedAt,
      generationStatus: 'DRAFT',
      failureReason: null,
      updatedAt: generated.generatedAt,
    },
  });
  return result.count === 1;
}

/** Terminal failure; guarded by `generationStatus = GENERATING`. `false`: nothing was changed. */
export async function markPostmortemFailed(
  tx: Db,
  postmortemId: string,
  reason: PostmortemFailureReason,
): Promise<boolean> {
  const result = await tx.postmortem.updateMany({
    where: { id: postmortemId, generationStatus: 'GENERATING' },
    data: { generationStatus: 'FAILED', failureReason: reason, updatedAt: new Date() },
  });
  return result.count === 1;
}
