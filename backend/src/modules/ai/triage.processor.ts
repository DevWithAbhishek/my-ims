import { z } from 'zod';
import { appendAuditEvent } from '../../infra/audit/append-audit-event.js';
import { getPrisma, runInTransaction } from '../../infra/db/prisma.js';
import {
  NonRetryableJobError,
  RetryableJobError,
  type OutboxProcessor,
  type ProcessorInput,
} from '../../infra/jobs/index.js';
import { classifyError } from '../../infra/jobs/errors.js';
import { logger } from '../../shared/observability/logger.js';
import { enqueueNotification } from '../notifications/index.js';
import { AiProviderError, type AiProvider } from './ai-provider.js';
import { projectAllowedFields } from './triage.allowlist.js';
import { parseTriageOutput } from './triage.output.js';
import { TRIAGE_INSTRUCTIONS } from './triage.prompt.js';
import {
  ensurePendingTriage,
  findAlertForTriage,
  lockTriageStatus,
  markTriageFailed,
  storeRawOutput,
  storeTriageSuccess,
} from './triage.repository.js';

export type TriageDeps = {
  provider: AiProvider;
  /** Total execution attempts per job (SLICE-08); the last failed attempt ends in `FAILED`. */
  maxAttempts: number;
  now?: () => Date;
};

const payloadSchema = z.object({
  alertId: z.uuid(),
  incidentId: z.uuid(),
  requestId: z.string().optional(),
});

/** The model answered, but not with a valid triage: retried like any other transient failure. */
class InvalidModelOutputError extends Error {
  constructor() {
    super('The model output failed validation');
    this.name = 'InvalidModelOutputError';
  }
}

/** Maps a provider failure to the SLICE-08 job errors, so the wrapper retries or dead-letters. */
function toJobError(error: AiProviderError): Error {
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

/**
 * The consumer of `ALERT_TRIAGE_REQUESTED` (SLICE-10 §4). The provider is called here, in the
 * worker, never inside a database transaction. A failure is classified for the SLICE-08 wrapper;
 * on a non-retryable error or the last attempt the triage is marked `FAILED` first, and the error
 * is rethrown so the wrapper dead-letters the outbox event. No state of the incident is written.
 */
export function createAlertTriageProcessor(deps: TriageDeps): OutboxProcessor {
  const clock = deps.now ?? (() => new Date());

  return async (input: ProcessorInput) => {
    const parsed = payloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: alertId');
    }
    const { alertId, incidentId, requestId } = parsed.data;
    const db = getPrisma();
    const started = Date.now();

    const alert = await findAlertForTriage(db, alertId);
    if (alert === null) throw new NonRetryableJobError('RESOURCE_NOT_FOUND', 'Alert not found');

    try {
      if ((await ensurePendingTriage(db, alertId)) === 'SUCCESS') {
        logger.info(
          { alertId, incidentId, requestId, outcome: 'already_triaged' },
          'Alert already triaged',
        );
        return;
      }
      if (alert.incidentId !== incidentId) {
        throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: incidentId');
      }

      let generated;
      try {
        generated = await deps.provider.generate({
          instructions: TRIAGE_INSTRUCTIONS,
          input: projectAllowedFields(alert),
        });
      } catch (error) {
        throw error instanceof AiProviderError ? toJobError(error) : error;
      }

      const output = parseTriageOutput(generated.text);
      if (!output.ok) {
        await storeRawOutput(db, alertId, output.raw);
        logger.warn(
          { alertId, incidentId, requestId, fields: output.fields, outcome: 'invalid_output' },
          'Model output failed validation',
        );
        throw new InvalidModelOutputError();
      }

      const storedAt = clock();
      const stored = await runInTransaction(async (tx) => {
        if ((await lockTriageStatus(tx, alertId)) === 'SUCCESS') return false;
        await storeTriageSuccess(tx, alertId, {
          output: output.value,
          rawOutput: output.raw,
          model: generated.model,
          modelVersion: generated.modelVersion,
          storedAt,
        });
        const auditEventId = await appendAuditEvent(tx, {
          incidentId,
          eventType: 'AI_TRIAGE_COMPLETED',
          actorId: null,
          metadata: { createdAt: storedAt.toISOString() },
        });
        await enqueueNotification(tx, {
          eventType: 'AI_TRIAGE_COMPLETED',
          occurrenceId: auditEventId,
          incidentId,
          ...(requestId === undefined ? {} : { requestId }),
        });
        return true;
      });

      logger.info(
        {
          alertId,
          incidentId,
          requestId,
          model: generated.model,
          outcome: stored ? 'triaged' : 'lost_race',
          durationMs: Date.now() - started,
        },
        stored ? 'Alert triaged' : 'Alert triaged by a parallel job',
      );
    } catch (error) {
      const { retryable } = classifyError(error);
      if (!retryable || input.attempt >= deps.maxAttempts) {
        try {
          await markTriageFailed(db, alertId);
        } catch (markError) {
          logger.error(
            { alertId, incidentId, requestId, err: markError },
            'Could not mark the triage as failed',
          );
        }
        logger.warn({ alertId, incidentId, requestId, outcome: 'triage_failed' }, 'Triage failed');
      }
      throw error;
    }
  };
}
