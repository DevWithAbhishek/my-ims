import { z } from 'zod';
import { appendAuditEvent } from '../../../infra/audit/append-audit-event.js';
import { getPrisma, runInTransaction } from '../../../infra/db/prisma.js';
import { classifyError } from '../../../infra/jobs/errors.js';
import {
  NonRetryableJobError,
  type OutboxProcessor,
  type ProcessorInput,
} from '../../../infra/jobs/index.js';
import { logger } from '../../../shared/observability/logger.js';
import { enqueueNotification } from '../../notifications/index.js';
import { AiProviderError, type AiProvider } from '../ai-provider.js';
import { toJobError } from '../provider-job-error.js';
import {
  buildCandidates,
  projectInvestigationInput,
  type EvidenceCandidate,
} from './investigation.candidates.js';
import {
  failureReasonOf,
  OutputInvalidError,
  RetrievalFailedError,
} from './investigation.failure.js';
import { parseInvestigationOutput } from './investigation.output.js';
import { INVESTIGATION_INSTRUCTIONS } from './investigation.prompt.js';
import {
  claimInvestigation,
  findIncidentForInvestigation,
  findInvestigationForWork,
  findReviewedPostmortems,
  lockInvestigationStatus,
  markInvestigationFailed,
  resetToRequested,
  storeInvestigationSuccess,
} from './investigation.repository.js';

export type InvestigationDeps = {
  provider: AiProvider;
  /** Total execution attempts per job (SLICE-08); the last failed attempt ends in `FAILED`. */
  maxAttempts: number;
  now?: () => Date;
};

const payloadSchema = z.object({
  investigationId: z.uuid(),
  incidentId: z.uuid(),
  requestId: z.string().optional(),
});

/** The retrieval parameters stored with the request (`Investigation.input`). */
const inputSchema = z.object({ postmortemLimit: z.number().int().min(1) });

/**
 * The consumer of `INVESTIGATION_REQUESTED` (SLICE-12 §4.3). Retrieval and the provider call run
 * here, never inside a transaction. A retryable failure with attempts left puts the investigation
 * back to `REQUESTED` and rethrows; on a non-retryable error or the last attempt it ends `FAILED`
 * with a fixed reason and the error is rethrown so SLICE-08 dead-letters the event. No incident
 * state is written, and a failure writes no audit event and no notification.
 */
export function createInvestigationProcessor(deps: InvestigationDeps): OutboxProcessor {
  const clock = deps.now ?? (() => new Date());

  return async (input: ProcessorInput) => {
    const parsed = payloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: investigationId');
    }
    const { investigationId, incidentId, requestId } = parsed.data;
    const db = getPrisma();
    const started = Date.now();

    const investigation = await findInvestigationForWork(db, investigationId);
    if (investigation === null) {
      throw new NonRetryableJobError('RESOURCE_NOT_FOUND', 'Investigation not found');
    }
    if (investigation.incidentId !== incidentId) {
      throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: incidentId');
    }
    if (investigation.status === 'COMPLETED' || investigation.status === 'FAILED') {
      logger.info(
        { investigationId, incidentId, requestId, outcome: 'already_terminal' },
        'Investigation already finished',
      );
      return;
    }
    const retrievalInput = inputSchema.safeParse(investigation.input);

    try {
      if (!retrievalInput.success) {
        throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid investigation input');
      }
      if ((await claimInvestigation(db, investigationId)) === 0) return;

      let candidates: EvidenceCandidate[];
      try {
        const incident = await findIncidentForInvestigation(db, incidentId);
        if (incident === null) throw new Error('Incident not found');
        const postmortems = await findReviewedPostmortems(db, {
          teamId: incident.teamId,
          serviceId: incident.serviceId,
          excludeIncidentId: incidentId,
          limit: retrievalInput.data.postmortemLimit,
        });
        candidates = buildCandidates(incident, postmortems);
      } catch {
        throw new RetrievalFailedError();
      }

      let generated;
      try {
        generated = await deps.provider.generate({
          instructions: INVESTIGATION_INSTRUCTIONS,
          input: projectInvestigationInput(candidates),
        });
      } catch (error) {
        throw error instanceof AiProviderError ? toJobError(error) : error;
      }

      const output = parseInvestigationOutput(generated.text, candidates);
      if (!output.ok) {
        logger.warn(
          {
            investigationId,
            incidentId,
            requestId,
            fields: output.fields,
            outcome: 'invalid_output',
          },
          'Model output failed validation',
        );
        throw new OutputInvalidError();
      }

      const completedAt = clock();
      const completed = await runInTransaction(async (tx) => {
        if ((await lockInvestigationStatus(tx, investigationId)) !== 'RUNNING') return false;
        await storeInvestigationSuccess(tx, investigationId, {
          evidence: output.evidence,
          brief: output.brief,
          model: generated.model,
          modelVersion: generated.modelVersion,
          completedAt,
        });
        const auditEventId = await appendAuditEvent(tx, {
          incidentId,
          eventType: 'AI_INVESTIGATION_COMPLETED',
          actorId: null,
          metadata: { investigationId },
        });
        await enqueueNotification(tx, {
          eventType: 'AI_INVESTIGATION_COMPLETED',
          occurrenceId: auditEventId,
          incidentId,
          subjectUserId: investigation.requestedById,
          ...(requestId === undefined ? {} : { requestId }),
        });
        return true;
      });

      logger.info(
        {
          investigationId,
          incidentId,
          requestId,
          model: generated.model,
          outcome: completed ? 'completed' : 'lost_race',
          durationMs: Date.now() - started,
        },
        completed ? 'Investigation completed' : 'Investigation finished by a parallel job',
      );
    } catch (error) {
      await recordFailure(error, input, { investigationId, incidentId, requestId }, deps);
      throw error;
    }
  };
}

type FailureContext = {
  investigationId: string;
  incidentId: string;
  requestId: string | undefined;
};

/** Retry with attempts left: back to `REQUESTED`. Otherwise the terminal `FAILED` with its reason. */
async function recordFailure(
  error: unknown,
  input: ProcessorInput,
  context: FailureContext,
  deps: InvestigationDeps,
): Promise<void> {
  const db = getPrisma();
  const { retryable } = classifyError(error);
  const final = !retryable || input.attempt >= deps.maxAttempts;
  try {
    if (final) {
      await markInvestigationFailed(db, context.investigationId, failureReasonOf(error));
      logger.warn({ ...context, outcome: 'investigation_failed' }, 'Investigation failed');
    } else {
      await resetToRequested(db, context.investigationId);
    }
  } catch (recordError) {
    logger.error({ ...context, err: recordError }, 'Could not record the investigation failure');
  }
}
