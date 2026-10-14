import { countAlerts, parseJsonBody, validateEnvelope } from './envelope.js';

const JSON_TYPE = 'application/json';
const body = (value: unknown) => parseJsonBody(Buffer.from(JSON.stringify(value)));
const alerts = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

function failure(contentType: string | undefined, parsed: ReturnType<typeof parseJsonBody>) {
  try {
    validateEnvelope(contentType, parsed);
  } catch (error) {
    return error as { statusCode: number; code: string; details: unknown[] };
  }
  throw new Error('expected a failure');
}

describe('countAlerts', () => {
  it('counts the elements of an alerts array', () => {
    expect(countAlerts(body({ alerts: alerts(7) }))).toBe(7);
  });

  it.each([
    ['malformed JSON', parseJsonBody(Buffer.from('{nope'))],
    ['empty body', parseJsonBody(Buffer.alloc(0))],
    ['non-object body', body([1, 2])],
    ['missing alerts', body({})],
    ['alerts not an array', body({ alerts: 'x' })],
  ])('is 0 for %s', (_name, parsed) => {
    expect(countAlerts(parsed)).toBe(0);
  });
});

describe('validateEnvelope', () => {
  it('returns the alerts in request order', () => {
    expect(validateEnvelope(JSON_TYPE, body({ alerts: alerts(3) }))).toEqual(alerts(3));
  });

  it('accepts a charset parameter and any case, and 100 alerts', () => {
    expect(
      validateEnvelope('Application/JSON; charset=utf-8', body({ alerts: alerts(100) })),
    ).toHaveLength(100);
  });

  it.each([undefined, '', 'text/plain', 'application/x-www-form-urlencoded'])(
    'Content-Type %p → 400 BAD_REQUEST',
    (contentType) => {
      expect(failure(contentType, body({ alerts: alerts(1) }))).toMatchObject({
        statusCode: 400,
        code: 'BAD_REQUEST',
      });
    },
  );

  it('checks Content-Type before the body', () => {
    expect(failure(undefined, parseJsonBody(Buffer.from('{nope')))).toMatchObject({
      statusCode: 400,
    });
  });

  it('101 alerts → 400 BAD_REQUEST', () => {
    expect(failure(JSON_TYPE, body({ alerts: alerts(101) }))).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      details: [{ field: 'alerts', issue: 'At most 100 alerts per request' }],
    });
  });

  it('an unknown top-level field → 400 BAD_REQUEST naming the field', () => {
    expect(failure(JSON_TYPE, body({ alerts: alerts(1), extra: 1 }))).toMatchObject({
      statusCode: 400,
      details: [{ field: 'extra', issue: 'Unknown field' }],
    });
  });

  it.each([
    ['malformed JSON', parseJsonBody(Buffer.from('{nope')), 'body'],
    ['a non-object body', body([]), 'body'],
    ['a missing alerts', body({}), 'alerts'],
    ['alerts that is not an array', body({ alerts: {} }), 'alerts'],
    ['an empty alerts', body({ alerts: [] }), 'alerts'],
  ])('%s → 422 VALIDATION_FAILED', (_name, parsed, field) => {
    expect(failure(JSON_TYPE, parsed)).toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_FAILED',
      details: [{ field }],
    });
  });
});
