import { isConcurrencyFailure } from '../../infra/db/errors.js';
import { runInTransaction, type TransactionClient } from '../../infra/db/prisma.js';
import { ConflictError } from '../../shared/errors/AppError.js';

export type Db = TransactionClient;

/** Runs `work` in one transaction; lock timeouts and deadlocks become `409 CONCURRENCY_CONFLICT`. */
export async function runIdentityTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await runInTransaction(work);
  } catch (error) {
    if (isConcurrencyFailure(error)) throw concurrencyConflict();
    throw error;
  }
}

export function concurrencyConflict(): ConflictError {
  return new ConflictError(
    'The request conflicted with a concurrent change; retry',
    'CONCURRENCY_CONFLICT',
  );
}
