import { ConflictError, ForbiddenError, NotFoundError } from '../../../shared/errors/AppError.js';
import type { IncidentStatus } from '../incidents.types.js';
import type { LockedPostmortem, PostmortemGenerationStatus } from './postmortem.types.js';

export function postmortemNotFound(): NotFoundError {
  return new NotFoundError('Postmortem not found', 'POSTMORTEM_NOT_FOUND', [
    { resource: 'postmortem' },
  ]);
}

/** Gate 3: the incident or postmortem is not in a state that allows the action (`403`). */
export function invalidAction(): ForbiddenError {
  return new ForbiddenError(
    'The action is not allowed in the current state of the incident or postmortem',
    'INVALID_ACTION',
  );
}

function postmortemStateInvalid(postmortem: LockedPostmortem): ConflictError {
  return new ConflictError(
    'The postmortem is not in a state that allows this action',
    'POSTMORTEM_STATE_INVALID',
    [
      {
        currentGenerationStatus: postmortem.generationStatus,
        currentReviewStatus: postmortem.reviewStatus,
      },
    ],
  );
}

/**
 * P2 and P3, under the locks. No postmortem row → `404`; a postmortem that is not an unreviewed
 * draft (still generating, failed, or already reviewed, which includes every closed incident) →
 * `409 POSTMORTEM_STATE_INVALID`; an incident that is not `RESOLVED` → `403 INVALID_ACTION`.
 */
export function assertReviewable(
  postmortem: LockedPostmortem | null,
  incidentStatus: IncidentStatus,
): asserts postmortem is LockedPostmortem {
  if (postmortem === null) throw postmortemNotFound();
  if (postmortem.generationStatus !== 'DRAFT' || postmortem.reviewStatus !== 'PENDING') {
    throw postmortemStateInvalid(postmortem);
  }
  if (incidentStatus !== 'RESOLVED') throw invalidAction();
}

/** P4, under the locks: no row → `404`; not (`RESOLVED` incident, `FAILED` generation) → `403`. */
export function assertRetryable(
  postmortem: LockedPostmortem | null,
  incidentStatus: IncidentStatus,
): asserts postmortem is LockedPostmortem {
  if (postmortem === null) throw postmortemNotFound();
  if (incidentStatus !== 'RESOLVED' || postmortem.generationStatus !== 'FAILED') {
    throw invalidAction();
  }
}

/** P5, under the locks: only a `RESOLVED` incident whose generation `FAILED`, otherwise `403`. */
export function assertManuallyCreatable(
  postmortem: LockedPostmortem | null,
  incidentStatus: IncidentStatus,
): asserts postmortem is LockedPostmortem {
  if (
    postmortem === null ||
    incidentStatus !== 'RESOLVED' ||
    postmortem.generationStatus !== 'FAILED'
  ) {
    throw invalidAction();
  }
}

const MS_PER_MINUTE = 60_000;

/** `mttrMinutes = ceil((resolvedAt − createdAt) in minutes)`. */
export function computeMttrMinutes(createdAt: Date, resolvedAt: Date): number {
  return Math.ceil((resolvedAt.getTime() - createdAt.getTime()) / MS_PER_MINUTE);
}

/**
 * `true` while the postmortem is `GENERATING` or `FAILED` and for an AI draft (`generatedAt` set,
 * including one that has been approved); `false` for a manual postmortem.
 */
export function deriveAiGenerated(row: {
  generationStatus: PostmortemGenerationStatus;
  generatedAt: Date | null;
}): boolean {
  return row.generationStatus !== 'DRAFT' || row.generatedAt !== null;
}
