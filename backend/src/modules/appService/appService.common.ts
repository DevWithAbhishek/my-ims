import { z } from 'zod';
import { ForbiddenError, NotFoundError, type ErrorDetail } from '../../shared/errors/AppError.js';

export const uuidSchema = z.uuid();

export const sortSchema = z.enum(['asc', 'desc']).default('asc');
export const limitSchema = z.coerce.number().int().min(1).max(50).default(10);
export const offsetSchema = z.coerce.number().int().min(0).default(0);

export type Page<T> = { items: T[]; limit: number; offset: number; hasMore: boolean };

/** Splits a `limit + 1` fetch into the page and its `hasMore` flag. */
export function toPage<T>(rows: T[], limit: number, offset: number): Page<T> {
  return { items: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit };
}

export function pageResponse<T>(page: Page<T>) {
  return {
    data: page.items,
    pagination: { limit: page.limit, offset: page.offset, hasMore: page.hasMore },
  };
}

export function invalidAction(message: string, details: ErrorDetail[] = []): ForbiddenError {
  return new ForbiddenError(message, 'INVALID_ACTION', details);
}

export function serviceNotFound(): NotFoundError {
  return new NotFoundError('Service not found', 'SERVICE_NOT_FOUND', [{ resource: 'service' }]);
}

export function policyNotFound(): NotFoundError {
  return new NotFoundError('Escalation policy not found', 'ESCALATION_POLICY_NOT_FOUND', [
    { resource: 'escalationPolicy' },
  ]);
}
