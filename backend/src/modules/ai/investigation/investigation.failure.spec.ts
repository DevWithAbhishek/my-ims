import { classifyError, RetryableJobError } from '../../../infra/jobs/errors';
import { failureReasonOf, OutputInvalidError, RetrievalFailedError } from './investigation.failure';

describe('failureReasonOf', () => {
  it('maps retrieval and output failures to their reasons', () => {
    expect(failureReasonOf(new RetrievalFailedError())).toBe('RETRIEVAL_FAILED');
    expect(failureReasonOf(new OutputInvalidError())).toBe('OUTPUT_INVALID');
  });

  it('treats everything else (provider, infrastructure) as AI_UNAVAILABLE', () => {
    expect(failureReasonOf(new RetryableJobError('NETWORK', 'x'))).toBe('AI_UNAVAILABLE');
    expect(failureReasonOf(new Error('boom'))).toBe('AI_UNAVAILABLE');
  });

  it('keeps both failures retryable', () => {
    expect(classifyError(new RetrievalFailedError()).retryable).toBe(true);
    expect(classifyError(new OutputInvalidError()).retryable).toBe(true);
  });
});
