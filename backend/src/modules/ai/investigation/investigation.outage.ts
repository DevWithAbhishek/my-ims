import { isDatabaseUnavailable } from '../../../infra/db/errors.js';
import { ServiceUnavailableError } from '../../../shared/errors/AppError.js';
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from './investigation.config.js';

export function dependencyUnavailable(message: string): ServiceUnavailableError {
  return new ServiceUnavailableError(
    message,
    'DEPENDENCY_UNAVAILABLE',
    UNAVAILABLE_RETRY_AFTER_SECONDS,
  );
}

/** A database outage is `503 DEPENDENCY_UNAVAILABLE`; every other error passes through. */
export async function withDatabaseOutageMapping<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      throw dependencyUnavailable('The database is temporarily unavailable');
    }
    throw error;
  }
}
