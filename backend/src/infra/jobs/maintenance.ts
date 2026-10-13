import { logger } from '../../shared/observability/logger.js';
import { getPrisma } from '../db/prisma.js';
import { deleteExpiredSuccess, recoverStaleProcessing } from './outbox.repository.js';

/** Returns `PROCESSING` rows past their deadline to `PENDING` so the relay republishes them. */
export async function recoverStaleOutbox(): Promise<number> {
  const started = Date.now();
  const recovered = await getPrisma().$transaction((tx) => recoverStaleProcessing(tx));
  if (recovered > 0) {
    logger.warn(
      { recovered, outcome: 'stale_recovered', durationMs: Date.now() - started },
      'Stale PROCESSING outbox rows returned to PENDING',
    );
  }
  return recovered;
}

/** Deletes `SUCCESS` rows older than the retention window. `DEAD_LETTER` rows are never deleted. */
export async function purgeFinishedOutbox(retentionMs: number): Promise<number> {
  const started = Date.now();
  const deleted = await getPrisma().$transaction((tx) => deleteExpiredSuccess(tx, retentionMs));
  if (deleted > 0) {
    logger.info(
      { deleted, outcome: 'retention_deleted', durationMs: Date.now() - started },
      'Finished outbox rows deleted by retention',
    );
  }
  return deleted;
}
