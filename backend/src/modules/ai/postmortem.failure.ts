import { NonRetryableJobError, RetryableJobError } from '../../infra/jobs/index.js';

/** The values stored in `Postmortem.failureReason`: never provider text. */
export type PostmortemFailureReason = 'AI_UNAVAILABLE' | 'OUTPUT_INVALID' | 'INSUFFICIENT_CONTEXT';

/** No incident description and no comments: final, and no provider call was made. */
export class InsufficientContextError extends NonRetryableJobError {
  constructor() {
    super('BUSINESS_RULE_VIOLATION', 'No incident description or comments to generate from');
    this.name = 'InsufficientContextError';
  }
}

/** The model answered, but not with a valid postmortem: retried like any transient failure. */
export class OutputInvalidError extends RetryableJobError {
  constructor() {
    super('UNKNOWN_INTERNAL', 'The model output failed validation');
    this.name = 'OutputInvalidError';
  }
}

/** Why a generation ended in `FAILED`; provider and infrastructure failures are `AI_UNAVAILABLE`. */
export function failureReasonOf(error: unknown): PostmortemFailureReason {
  if (error instanceof InsufficientContextError) return 'INSUFFICIENT_CONTEXT';
  if (error instanceof OutputInvalidError) return 'OUTPUT_INVALID';
  return 'AI_UNAVAILABLE';
}
