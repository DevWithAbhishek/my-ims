import { z } from 'zod';
import { appendAuditEvent } from '../../infra/audit/append-audit-event.js';
import { getPrisma, runInTransaction } from '../../infra/db/prisma.js';
import {
  NonRetryableJobError,
  type OutboxProcessor,
  type ProcessorInput,
} from '../../infra/jobs/index.js';
import { classifyError } from '../../infra/jobs/errors.js';
import { logger } from '../../shared/observability/logger.js';
import { enqueueNotification } from '../notifications/index.js';
import { AiProviderError, type AiProvider } from './ai-provider.js';
import {
  hasNoAllowedContext,
  projectPostmortemInput,
  type PostmortemSource,
} from './postmortem.allowlist.js';
import {
  failureReasonOf,
  InsufficientContextError,
  OutputInvalidError,
} from './postmortem.failure.js';
import { computeMttrMinutes } from './postmortem.mttr.js';
import { parsePostmortemOutput } from './postmortem.output.js';
import { POSTMORTEM_INSTRUCTIONS } from './postmortem.prompt.js';
import {
  findPostmortemForGeneration,
  lockPostmortemForResult,
  markPostmortemFailed,
  storeGeneratedPostmortem,
} from './postmortem.repository.js';
import { toJobError } from './provider-job-error.js';

export type PostmortemDeps = {
  provider: AiProvider;
  /** Total execution attempts per job (SLICE-08); the last failed attempt ends in `FAILED`. */
  maxAttempts: number;
  now?: () => Date;
};

const payloadSchema = z.object({
  postmortemId: z.uuid(),
  incidentId: z.uuid(),
  requestId: z.string().optional(),
});

/**
 * The consumer of `POSTMORTEM_GENERATION_REQUESTED` (SLICE-11 §4.2). The provider is called here,
 * in the worker, never inside a database transaction. A late or duplicate job is a no-op. On a
 * non-retryable error or the last attempt the postmortem becomes `FAILED` (with the warning
 * notification) in one transaction and the error is rethrown, so SLICE-08 dead-letters the event.
 * The incident is never changed.
 */
export function createPostmortemProcessor(deps: PostmortemDeps): OutboxProcessor {
  const clock = deps.now ?? (() => new Date());

  return async (input: ProcessorInput) => {
    const parsed = payloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: postmortemId');
    }
    const { postmortemId, incidentId, requestId } = parsed.data;
    const db = getPrisma();
    const started = Date.now();

    const postmortem = await findPostmortemForGeneration(db, postmortemId);
    if (postmortem === null) {
      throw new NonRetryableJobError('RESOURCE_NOT_FOUND', 'Postmortem not found');
    }
    if (postmortem.incidentId !== incidentId) {
      throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: incidentId');
    }
    const { incident } = postmortem;
    if (postmortem.generationStatus !== 'GENERATING' || incident.status !== 'RESOLVED') {
      logger.info(
        { postmortemId, incidentId, requestId, outcome: 'noop' },
        'Postmortem generation is not due',
      );
      return;
    }
    if (incident.resolvedTimestamp === null) {
      throw new NonRetryableJobError('BUSINESS_RULE_VIOLATION', 'Resolved incident has no time');
    }
    const resolvedAt = incident.resolvedTimestamp;

    try {
      const source: PostmortemSource = {
        description: incident.description,
        severity: incident.severity,
        comments: incident.comments,
      };
      if (hasNoAllowedContext(source)) throw new InsufficientContextError();

      const providerInput = projectPostmortemInput(source);
      let generated;
      try {
        generated = await deps.provider.generate({
          instructions: POSTMORTEM_INSTRUCTIONS,
          input: providerInput,
        });
      } catch (error) {
        throw error instanceof AiProviderError ? toJobError(error) : error;
      }

      const output = parsePostmortemOutput(generated.text);
      if (!output.ok) {
        logger.warn(
          { postmortemId, incidentId, requestId, fields: output.fields, outcome: 'invalid_output' },
          'Model output failed validation',
        );
        throw new OutputInvalidError();
      }

      const generatedAt = clock();
      const stored = await runInTransaction(async (tx) => {
        if ((await lockPostmortemForResult(tx, incidentId, postmortemId)) !== 'GENERATING') {
          return false;
        }
        const written = await storeGeneratedPostmortem(tx, postmortemId, {
          output: output.value,
          mttrMinutes: computeMttrMinutes(incident.createdAt, resolvedAt),
          model: generated.model,
          modelVersion: generated.modelVersion,
          prompt: POSTMORTEM_INSTRUCTIONS,
          inputData: JSON.stringify(providerInput),
          generatedAt,
        });
        if (!written) return false;
        const auditEventId = await appendAuditEvent(tx, {
          incidentId,
          eventType: 'POSTMORTEM_GENERATED',
          actorId: null,
          metadata: { postmortemId },
        });
        await enqueueNotification(tx, {
          eventType: 'POSTMORTEM_GENERATED',
          occurrenceId: auditEventId,
          incidentId,
          ...(requestId === undefined ? {} : { requestId }),
        });
        return true;
      });

      logger.info(
        {
          postmortemId,
          incidentId,
          requestId,
          model: generated.model,
          outcome: stored ? 'generated' : 'lost_race',
          durationMs: Date.now() - started,
        },
        stored ? 'Postmortem generated' : 'Postmortem generated by a parallel job',
      );
    } catch (error) {
      const { retryable } = classifyError(error);
      if (!retryable || input.attempt >= deps.maxAttempts) {
        await failGeneration(input, { postmortemId, incidentId, requestId }, error);
      }
      throw error;
    }
  };
}

/**
 * Terminal failure, in one transaction: `FAILED` with the reason and the `WARNING` notification
 * (`occurrenceId` = the outbox event of the request). No audit event; the incident stays
 * `RESOLVED`. If this write itself fails it is logged and the original error is still rethrown.
 */
async function failGeneration(
  input: ProcessorInput,
  ids: { postmortemId: string; incidentId: string; requestId: string | undefined },
  error: unknown,
): Promise<void> {
  const { postmortemId, incidentId, requestId } = ids;
  const reason = failureReasonOf(error);
  try {
    const failed = await runInTransaction(async (tx) => {
      if ((await lockPostmortemForResult(tx, incidentId, postmortemId)) !== 'GENERATING') {
        return false;
      }
      if (!(await markPostmortemFailed(tx, postmortemId, reason))) return false;
      await enqueueNotification(tx, {
        eventType: 'POSTMORTEM_GENERATION_FAILED',
        occurrenceId: input.outboxEventId,
        incidentId,
        ...(requestId === undefined ? {} : { requestId }),
      });
      return true;
    });
    logger.warn(
      { postmortemId, incidentId, requestId, reason, outcome: failed ? 'failed' : 'not_due' },
      'Postmortem generation failed',
    );
  } catch (markError) {
    logger.error(
      { postmortemId, incidentId, requestId, err: markError },
      'Could not mark the postmortem as failed',
    );
  }
}
