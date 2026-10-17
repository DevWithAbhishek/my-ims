import { NonRetryableJobError, RetryableJobError } from '../../infra/jobs/index.js';
import { classifyError } from '../../infra/jobs/errors.js';
import { AiProviderError } from './ai-provider.js';
import {
  failureReasonOf,
  InsufficientContextError,
  OutputInvalidError,
} from './postmortem.failure.js';
import { computeMttrMinutes } from './postmortem.mttr.js';
import { toJobError } from './provider-job-error.js';

describe('failureReasonOf', () => {
  it('maps the three failure reasons', () => {
    expect(failureReasonOf(new InsufficientContextError())).toBe('INSUFFICIENT_CONTEXT');
    expect(failureReasonOf(new OutputInvalidError())).toBe('OUTPUT_INVALID');
  });

  it.each([
    toJobError(new AiProviderError('UNAVAILABLE', 503)),
    toJobError(new AiProviderError('TIMEOUT')),
    toJobError(new AiProviderError('RATE_LIMITED', 429)),
    toJobError(new AiProviderError('CONFIGURATION', 401)),
    new RetryableJobError('TRANSIENT_DATABASE', 'db'),
    new Error('anything else'),
  ])('provider and infrastructure failures are AI_UNAVAILABLE (%s)', (error) => {
    expect(failureReasonOf(error)).toBe('AI_UNAVAILABLE');
  });
});

describe('failure classification for the SLICE-08 policy', () => {
  it('insufficient context is final, invalid output is retried', () => {
    expect(new InsufficientContextError()).toBeInstanceOf(NonRetryableJobError);
    expect(classifyError(new InsufficientContextError()).retryable).toBe(false);
    expect(classifyError(new OutputInvalidError()).retryable).toBe(true);
  });

  it('the messages carry no provider text', () => {
    expect(new OutputInvalidError().message).toBe('The model output failed validation');
    expect(new InsufficientContextError().message).not.toMatch(/provider/i);
  });
});

describe('computeMttrMinutes (AI module)', () => {
  it('is the ceiling of the elapsed minutes', () => {
    const start = new Date('2026-10-17T10:00:00.000Z');
    expect(computeMttrMinutes(start, new Date(start.getTime() + 61_000))).toBe(2);
    expect(computeMttrMinutes(start, start)).toBe(0);
  });
});
