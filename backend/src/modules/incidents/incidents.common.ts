import { z } from 'zod';
import { isConcurrencyFailure, isDatabaseUnavailable } from '../../infra/db/errors.js';
import { runInTransaction, type TransactionClient } from '../../infra/db/prisma.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../shared/errors/AppError.js';
import type { AuthContext } from '../../shared/types/auth-context.js';
import { assertSameTeam } from '../identity/index.js';

export type Db = TransactionClient;

export const uuidSchema = z.uuid();
export const sortSchema = z.enum(['asc', 'desc']);
export const limitSchema = z.coerce.number().int().min(1).max(50).default(10);
export const offsetSchema = z.coerce.number().int().min(0).default(0);

/** Seconds a client is told to wait after a database outage (same as `/ready`). */
const OUTAGE_RETRY_AFTER_SECONDS = 5;

export function incidentNotFound(): NotFoundError {
  return new NotFoundError('Incident not found', 'INCIDENT_NOT_FOUND', [{ resource: 'incident' }]);
}

export function invalidCursor(): ValidationError {
  return new ValidationError('Cursor is invalid', 'INVALID_CURSOR', [
    { field: 'cursor', issue: 'Cursor is invalid' },
  ]);
}

/**
 * Gate 2 for every incident-scoped endpoint, after the caller's team was required: an unknown
 * incident is `404 INCIDENT_NOT_FOUND`, another team's `403 TEAM_ACCESS_DENIED`.
 */
export function assertIncidentAccess<T extends { teamId: string }>(
  auth: AuthContext,
  incident: T | null,
): asserts incident is T {
  if (incident === null) throw incidentNotFound();
  assertSameTeam(auth, incident.teamId);
}

/** A database outage becomes `503 DEPENDENCY_UNAVAILABLE`; every other error passes through. */
export async function withDatabaseOutageMapping<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      throw new ServiceUnavailableError(
        'The database is temporarily unavailable',
        'DEPENDENCY_UNAVAILABLE',
        OUTAGE_RETRY_AFTER_SECONDS,
      );
    }
    throw error;
  }
}

/**
 * Runs `work` in one transaction. Lock timeouts and deadlocks become `409 CONCURRENCY_CONFLICT`,
 * a database outage `503 DEPENDENCY_UNAVAILABLE`.
 */
export function runIncidentTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return withDatabaseOutageMapping(async () => {
    try {
      return await runInTransaction(work);
    } catch (error) {
      if (isConcurrencyFailure(error)) {
        throw new ConflictError(
          'The request conflicted with a concurrent change; retry',
          'CONCURRENCY_CONFLICT',
        );
      }
      throw error;
    }
  });
}
