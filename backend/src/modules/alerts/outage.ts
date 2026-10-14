import { isDatabaseUnavailable } from '../../infra/db/errors.js';
import { ServiceUnavailableError } from '../../shared/errors/AppError.js';

/** Seconds a client is told to wait after a database outage (same as the incident endpoints). */
const OUTAGE_RETRY_AFTER_SECONDS = 5;

/** A database outage is `503 DEPENDENCY_UNAVAILABLE`; every other error is returned unchanged. */
export function mapDatabaseOutage(error: unknown): unknown {
  if (!isDatabaseUnavailable(error)) return error;
  return new ServiceUnavailableError(
    'The database is temporarily unavailable',
    'DEPENDENCY_UNAVAILABLE',
    OUTAGE_RETRY_AFTER_SECONDS,
  );
}

export async function withDatabaseOutageMapping<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw mapDatabaseOutage(error);
  }
}
