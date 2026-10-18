import { z } from 'zod';
import { BadRequestError, ValidationError } from '../../../shared/errors/AppError.js';

const uuid = z.uuid();

export const incidentParamsSchema = z.strictObject({ incidentId: uuid });
export const investigationParamsSchema = z.strictObject({
  incidentId: uuid,
  investigationId: uuid,
});

export const listInvestigationsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  orderBy: z.literal('createdAt').default('createdAt'),
  sort: z.enum(['asc', 'desc']).default('asc'),
});
export type ListInvestigationsQuery = z.output<typeof listInvestigationsQuerySchema>;

/** N1 accepts no query parameter. */
export const requestQuerySchema = z.strictObject({});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** `Idempotency-Key` is required (`400` when absent) and must be 8–128 of `[A-Za-z0-9_-]` (`422`). */
export function readIdempotencyKey(header: string | undefined): string {
  if (header === undefined) {
    throw new BadRequestError('The Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!IDEMPOTENCY_KEY.test(header)) {
    throw new ValidationError('Request validation failed', 'VALIDATION_FAILED', [
      { field: 'Idempotency-Key', issue: 'Must be 8 to 128 characters of A-Z, a-z, 0-9, _ or -' },
    ]);
  }
  return header;
}
