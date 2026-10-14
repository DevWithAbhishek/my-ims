import {
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../shared/errors/AppError.js';
import { WEBHOOK } from './webhook.config.js';

/** One error for every authentication failure, so nothing reveals whether a source exists. */
export function sourceAuthFailed(): UnauthorizedError {
  return new UnauthorizedError('Source authentication failed', 'SOURCE_AUTH_FAILED');
}

export function requestStale(): UnauthorizedError {
  return new UnauthorizedError(
    'The request timestamp is outside the accepted window; sign the request again',
    'REQUEST_STALE',
  );
}

export function replayDetected(): ConflictError {
  return new ConflictError('This signed request was already received', 'REPLAY_DETECTED');
}

export function dependencyUnavailable(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    'Service temporarily unavailable',
    'DEPENDENCY_UNAVAILABLE',
    WEBHOOK.unavailableRetryAfterSeconds,
  );
}
