import { NonRetryableJobError, RetryableJobError } from '../../infra/jobs/index.js';
import type { AiProviderError } from './ai-provider.js';

/** Maps a provider failure to the SLICE-08 job errors, so the wrapper retries or dead-letters. */
export function toJobError(error: AiProviderError): Error {
  if (!error.retryable) {
    return new NonRetryableJobError(
      'AUTHENTICATION_OR_CONFIGURATION',
      `AI provider failure: ${error.kind}`,
    );
  }
  const reason =
    error.kind === 'RATE_LIMITED'
      ? 'RATE_LIMITED'
      : error.kind === 'NETWORK'
        ? 'NETWORK'
        : 'SERVICE_UNAVAILABLE';
  return new RetryableJobError(reason, `AI provider failure: ${error.kind}`, error.retryAfterMs);
}
