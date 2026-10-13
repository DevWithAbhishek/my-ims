import { executionRetryDelayMs, exponentialBackoffMs } from './backoff';
import { RetryableJobError } from './errors';

describe('exponentialBackoffMs', () => {
  it('doubles from the base and stops at the cap', () => {
    const schedule = [1, 2, 3, 4, 5, 6].map((attempt) => exponentialBackoffMs(attempt, 1000, 8000));
    expect(schedule).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('never overflows for very large attempt numbers', () => {
    expect(exponentialBackoffMs(10_000, 1000, 60_000)).toBe(60_000);
  });
});

describe('executionRetryDelayMs', () => {
  const config = { executionBackoffBaseMs: 100, executionBackoffCapMs: 400 };

  it('follows the capped exponential schedule for ordinary errors', () => {
    expect([1, 2, 3, 4].map((n) => executionRetryDelayMs(n, new Error('x'), config))).toEqual([
      100, 200, 400, 400,
    ]);
  });

  it('honors a longer provider-supplied delay and never shortens the schedule', () => {
    const slow = new RetryableJobError('RATE_LIMITED', 'slow down', 5000);
    const quick = new RetryableJobError('RATE_LIMITED', 'slow down', 10);
    expect(executionRetryDelayMs(1, slow, config)).toBe(5000);
    expect(executionRetryDelayMs(3, quick, config)).toBe(400);
  });
});
