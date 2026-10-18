import { AppError } from '../../../shared/errors/AppError';
import { parseOrThrow } from '../../../shared/errors/zod';
import {
  incidentParamsSchema,
  listInvestigationsQuerySchema,
  readIdempotencyKey,
  requestQuerySchema,
} from './investigation.schema';

const caught = (work: () => unknown): AppError => {
  try {
    work();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('did not throw');
};

describe('readIdempotencyKey', () => {
  it('accepts 8 to 128 characters of [A-Za-z0-9_-]', () => {
    expect(readIdempotencyKey('abcdefgh')).toBe('abcdefgh');
    expect(readIdempotencyKey('A-b_9'.repeat(25) + 'abc')).toHaveLength(128);
  });

  it('answers 400 IDEMPOTENCY_KEY_REQUIRED when the header is absent', () => {
    const error = caught(() => readIdempotencyKey(undefined));
    expect([error.statusCode, error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
  });

  it.each(['short', 'a'.repeat(129), 'has space 123', 'bad/slash1', '', 'ünïcode123'])(
    'answers 422 VALIDATION_FAILED for %j',
    (value) => {
      const error = caught(() => readIdempotencyKey(value));
      expect([error.statusCode, error.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(error.details).toEqual([expect.objectContaining({ field: 'Idempotency-Key' })]);
    },
  );
});

describe('N1 and list inputs', () => {
  it('rejects a malformed incident id with 422', () => {
    expect(
      caught(() => parseOrThrow(incidentParamsSchema, { incidentId: 'nope' })).statusCode,
    ).toBe(422);
  });

  it('rejects any query parameter on N1 with 400', () => {
    expect(caught(() => parseOrThrow(requestQuerySchema, { x: '1' })).statusCode).toBe(400);
    expect(parseOrThrow(requestQuerySchema, {})).toEqual({});
  });

  it('defaults the list query to limit 10, offset 0, createdAt asc and caps limit at 50', () => {
    expect(parseOrThrow(listInvestigationsQuerySchema, {})).toEqual({
      limit: 10,
      offset: 0,
      orderBy: 'createdAt',
      sort: 'asc',
    });
    expect(
      caught(() => parseOrThrow(listInvestigationsQuerySchema, { limit: '51' })).statusCode,
    ).toBe(422);
    expect(
      caught(() => parseOrThrow(listInvestigationsQuerySchema, { orderBy: 'id' })).statusCode,
    ).toBe(422);
    expect(caught(() => parseOrThrow(listInvestigationsQuerySchema, { foo: 1 })).statusCode).toBe(
      400,
    );
  });
});
