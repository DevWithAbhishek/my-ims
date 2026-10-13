import { ZodError } from 'zod';
import { classifyError, NonRetryableJobError, RetryableJobError, sanitizeError } from './errors';

describe('classifyError', () => {
  it.each([
    'INVALID_PAYLOAD',
    'UNSUPPORTED_EVENT_TYPE',
    'BUSINESS_RULE_VIOLATION',
    'AUTHENTICATION_OR_CONFIGURATION',
    'RESOURCE_NOT_FOUND',
    'AUTHORIZATION_FAILURE',
  ] as const)('treats %s as non-retryable', (reason) => {
    expect(classifyError(new NonRetryableJobError(reason, 'x'))).toEqual({
      retryable: false,
      errorClass: reason,
    });
  });

  it('treats typed retryable errors as retryable and keeps the provider delay', () => {
    expect(classifyError(new RetryableJobError('RATE_LIMITED', 'x', 1500))).toEqual({
      retryable: true,
      errorClass: 'RATE_LIMITED',
      retryAfterMs: 1500,
    });
  });

  it('treats schema failures as an invalid payload', () => {
    const issue = new ZodError([{ code: 'custom', path: ['a'], message: 'bad' }]);
    expect(classifyError(issue)).toEqual({ retryable: false, errorClass: 'INVALID_PAYLOAD' });
  });

  it.each([
    [{ code: '40P01' }, 'TRANSIENT_DATABASE'],
    [{ code: '55P03' }, 'TRANSIENT_DATABASE'],
    [{ code: 'ECONNREFUSED' }, 'NETWORK'],
    [{ code: 'ETIMEDOUT' }, 'NETWORK'],
  ])('maps %j to a retryable %s failure', (shape, errorClass) => {
    expect(classifyError(Object.assign(new Error('x'), shape))).toEqual({
      retryable: true,
      errorClass,
    });
  });

  it('maps a Redis request-limit error to REDIS_UNAVAILABLE', () => {
    const error = new Error('x');
    error.name = 'MaxRetriesPerRequestError';
    expect(classifyError(error)).toEqual({ retryable: true, errorClass: 'REDIS_UNAVAILABLE' });
  });

  it('maps ioredis connectivity and BullMQ stalled-job errors', () => {
    expect(classifyError(new Error('Connection is closed.')).errorClass).toBe('REDIS_UNAVAILABLE');
    expect(classifyError(new Error('job stalled more than allowable limit')).errorClass).toBe(
      'WORKER_INTERRUPTED',
    );
  });

  it('treats unknown errors as retryable (limited by the attempt count)', () => {
    expect(classifyError(new Error('boom'))).toEqual({
      retryable: true,
      errorClass: 'UNKNOWN_INTERNAL',
    });
    expect(classifyError('a string')).toEqual({ retryable: true, errorClass: 'UNKNOWN_INTERNAL' });
  });
});

describe('sanitizeError', () => {
  it('redacts URLs and tokens from deliberate consumer messages', () => {
    const text = sanitizeError(
      new RetryableJobError(
        'NETWORK',
        'GET https://user:pw@mail.example/send failed with Bearer abc.def.ghi',
      ),
    );
    expect(text).not.toMatch(/user:pw|abc\.def/);
    expect(text).toContain('[redacted-url]');
  });

  it('truncates long messages', () => {
    expect(
      sanitizeError(new NonRetryableJobError('INVALID_PAYLOAD', 'x'.repeat(2000))),
    ).toHaveLength(500);
  });

  it('reduces library errors to type and code, never message or stack', () => {
    const error = Object.assign(new Error('INSERT ... VALUES (secret-token, "body")'), {
      code: 'P2002',
    });
    const text = sanitizeError(error);
    expect(text).toBe('Error (P2002)');
    expect(text).not.toMatch(/secret|INSERT|\n\s+at /);
  });
});
