import { z } from 'zod';
import { AppError, BadRequestError, ValidationError } from './AppError.js';

/**
 * Maps a Zod failure to the API error: any unknown (strict) key → `400 BAD_REQUEST`,
 * every other validation failure → `422 VALIDATION_FAILED` with `details: [{ field, issue }]`.
 */
export function zodErrorToAppError(error: z.ZodError): AppError {
  const unknownFields: string[] = [];
  const failures: { field: string; issue: string }[] = [];

  for (const issue of error.issues) {
    const parent = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        unknownFields.push([...parent, key].join('.'));
      }
    } else {
      failures.push({ field: parent.join('.'), issue: issue.message });
    }
  }

  if (unknownFields.length > 0) {
    return new BadRequestError(
      'Request contains unknown fields',
      'BAD_REQUEST',
      unknownFields.map((field) => ({ field, issue: 'Unknown field' })),
    );
  }

  return new ValidationError('Request validation failed', 'VALIDATION_FAILED', failures);
}

/** Parses `data` with `schema`, throwing the mapped `AppError` on failure. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw zodErrorToAppError(result.error);
  }
  return result.data;
}
