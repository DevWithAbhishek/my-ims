import { Prisma } from '../../generated/prisma/client.js';
import type { LifecycleStates } from '../../generated/prisma/enums.js';
import type { TransactionClient } from '../../infra/db/prisma.js';
import type { TriageAllowedFields } from './triage.allowlist.js';
import type { TriageOutput } from './triage.output.js';

type Db = TransactionClient;

/** What triage reads of an alert: the four allow-listed fields and the incident it belongs to. */
export type AlertForTriage = TriageAllowedFields & { incidentId: string | null };

export function findAlertForTriage(db: Db, alertId: string): Promise<AlertForTriage | null> {
  return db.alert.findUnique({
    where: { id: alertId },
    select: {
      incidentId: true,
      summary: true,
      description: true,
      labels: true,
      additionalDetails: true,
    },
  });
}

/**
 * Step 2 of the job: makes sure the alert's one `AITriage` row exists and is `PENDING` unless it
 * is already `SUCCESS`, and returns its status. `alertId` is unique, so a duplicate job inserts
 * nothing; a `FAILED` row (a re-driven job) goes back to `PENDING`; a `SUCCESS` row is untouched.
 */
export async function ensurePendingTriage(db: Db, alertId: string): Promise<LifecycleStates> {
  await db.aITriage.createMany({ data: [{ alertId }], skipDuplicates: true });
  await db.aITriage.updateMany({
    where: { alertId, failureStatus: 'FAILED' },
    data: { failureStatus: 'PENDING', updatedAt: new Date() },
  });
  const row = await db.aITriage.findUniqueOrThrow({
    where: { alertId },
    select: { failureStatus: true },
  });
  return row.failureStatus;
}

/** Keeps the model's invalid answer for diagnosis; never exposed. A `SUCCESS` row is untouched. */
export async function storeRawOutput(db: Db, alertId: string, rawOutput: unknown): Promise<void> {
  await db.aITriage.updateMany({
    where: { alertId, failureStatus: { not: 'SUCCESS' } },
    data: { rawOutput: rawOutput as Prisma.InputJsonValue, updatedAt: new Date() },
  });
}

/** Terminal failure: the incident stays fully usable. A `SUCCESS` row is never overwritten. */
export async function markTriageFailed(db: Db, alertId: string): Promise<void> {
  await db.aITriage.updateMany({
    where: { alertId, failureStatus: { not: 'SUCCESS' } },
    data: { failureStatus: 'FAILED', updatedAt: new Date() },
  });
}

/**
 * Locks the alert's triage row (`FOR UPDATE`) and returns its status, so that of two parallel
 * jobs the second waits and then sees the first one's result. `null` when there is no row.
 */
export async function lockTriageStatus(
  tx: TransactionClient,
  alertId: string,
): Promise<LifecycleStates | null> {
  const rows = await tx.$queryRaw<{ status: LifecycleStates }[]>(
    Prisma.sql`SELECT "failureStatus"::text AS status FROM "AITriage" WHERE "alertId" = ${alertId}::uuid FOR UPDATE`,
  );
  return rows[0]?.status ?? null;
}

export type TriageSuccess = {
  output: TriageOutput;
  rawOutput: unknown;
  model: string;
  modelVersion: string;
  /** The instant the result is stored: the API's `generatedAt` and the audit event's `createdAt`. */
  storedAt: Date;
};

/**
 * Stores the validated suggestion. `createdAt` is set to the store instant (owner decision, so the
 * API's `generatedAt`, which reads it, equals the audit event's `createdAt`).
 */
export async function storeTriageSuccess(
  tx: TransactionClient,
  alertId: string,
  success: TriageSuccess,
): Promise<void> {
  await tx.aITriage.update({
    where: { alertId },
    data: {
      suggestedSeverity: success.output.suggestedSeverity,
      category: success.output.category,
      summary: success.output.summary,
      reasoning: success.output.reasoning,
      confidence: success.output.confidence,
      evidence: success.output.evidence,
      rawOutput: success.rawOutput as Prisma.InputJsonValue,
      model: success.model,
      modelVersion: success.modelVersion,
      failureStatus: 'SUCCESS',
      createdAt: success.storedAt,
      updatedAt: success.storedAt,
    },
  });
}
