import { RetryableJobError } from '../../../infra/jobs/index.js';

/** The values stored in `Investigation.failureReason`: never provider text. */
export type InvestigationFailureReason = 'AI_UNAVAILABLE' | 'RETRIEVAL_FAILED' | 'OUTPUT_INVALID';

/** Retrieval of the allowed records failed: retried like a transient database failure. */
export class RetrievalFailedError extends RetryableJobError {
  constructor() {
    super('TRANSIENT_DATABASE', 'Retrieval of the investigation sources failed');
    this.name = 'RetrievalFailedError';
  }
}

/** The model answered, but not with a valid brief: retried like any transient failure. */
export class OutputInvalidError extends RetryableJobError {
  constructor() {
    super('UNKNOWN_INTERNAL', 'The model output failed validation');
    this.name = 'OutputInvalidError';
  }
}

/** Why an investigation ended in `FAILED`; provider and infrastructure failures are `AI_UNAVAILABLE`. */
export function failureReasonOf(error: unknown): InvestigationFailureReason {
  if (error instanceof RetrievalFailedError) return 'RETRIEVAL_FAILED';
  if (error instanceof OutputInvalidError) return 'OUTPUT_INVALID';
  return 'AI_UNAVAILABLE';
}
