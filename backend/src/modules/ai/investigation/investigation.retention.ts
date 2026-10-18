import { runInTransaction } from '../../../infra/db/prisma.js';
import { logger } from '../../../shared/observability/logger.js';
import { INVESTIGATION_RETENTION_MS } from './investigation.config.js';
import { deleteExpiredInvestigations } from './investigation.repository.js';

export type RetentionDeps = { batchSize: number; now?: () => Date };

/**
 * One pass of the retention job (SLICE-12 §4.4): deletes at most `batchSize` investigations older
 * than 14 days (by `createdAt`, any status) together with their evidence, in one transaction.
 * Returns `true` when a full batch was deleted, so the loop runs again at once.
 */
export async function runInvestigationRetention(deps: RetentionDeps): Promise<boolean> {
  const cutoff = new Date(
    (deps.now ?? (() => new Date()))().getTime() - INVESTIGATION_RETENTION_MS,
  );
  const deleted = await runInTransaction((tx) =>
    deleteExpiredInvestigations(tx, cutoff, deps.batchSize),
  );
  if (deleted > 0) {
    logger.info({ deleted, outcome: 'investigations_deleted' }, 'Expired investigations deleted');
  }
  return deleted === deps.batchSize;
}
