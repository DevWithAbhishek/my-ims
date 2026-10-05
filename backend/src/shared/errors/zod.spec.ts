import { z } from 'zod';
import { BadRequestError, ValidationError } from './AppError.js';
import { parseOrThrow, zodErrorToAppError } from './zod.js';

const schema = z.strictObject({
  name: z.string(),
  nested: z.strictObject({ count: z.number().int() }),
});

function failureOf(input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected validation to fail');
  return zodErrorToAppError(result.error);
}

describe('zodErrorToAppError', () => {
  it('maps missing and invalid fields to 422 VALIDATION_FAILED with field details', () => {
    const error = failureOf({ nested: { count: 'x' } });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual([
      { field: 'name', issue: expect.any(String) },
      { field: 'nested.count', issue: expect.any(String) },
    ]);
  });

  it('maps an unknown key to 400 BAD_REQUEST', () => {
    const error = failureOf({ name: 'a', nested: { count: 1 }, extra: true });
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.details).toEqual([{ field: 'extra', issue: 'Unknown field' }]);
  });

  it('reports a nested unknown key with its full path', () => {
    const error = failureOf({ name: 'a', nested: { count: 1, other: 1 } });
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual([{ field: 'nested.other', issue: 'Unknown field' }]);
  });

  it('prefers 400 when unknown keys and validation failures occur together', () => {
    expect(failureOf({ nested: { count: 1 }, extra: 1 }).statusCode).toBe(400);
  });
});

describe('parseOrThrow', () => {
  it('returns parsed data on success', () => {
    expect(parseOrThrow(schema, { name: 'a', nested: { count: 2 } })).toEqual({
      name: 'a',
      nested: { count: 2 },
    });
  });

  it('throws the mapped AppError on failure', () => {
    expect(() => parseOrThrow(schema, {})).toThrow(ValidationError);
  });
});
