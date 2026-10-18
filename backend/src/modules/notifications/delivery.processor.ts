import { z } from 'zod';
import { getPrisma, runInTransaction } from '../../infra/db/prisma.js';
import { appendAuditEvent } from '../../infra/audit/append-audit-event.js';
import { classifyError } from '../../infra/jobs/errors.js';
import {
  NonRetryableJobError,
  RetryableJobError,
  type OutboxProcessor,
  type ProcessorInput,
} from '../../infra/jobs/index.js';
import { logger } from '../../shared/observability/logger.js';
import { isNotificationEventType, writesNotifiedEvent } from './catalog.js';
import { EmailProviderError, type EmailProvider, type EmailReceipt } from './email-provider.js';
import {
  claimNotification,
  findNotification,
  findNotificationIdByKey,
  findRecipientEmails,
  findTemplateFacts,
  finishAttempt,
  type StoredNotification,
} from './notification.repository.js';
import { detailsFromPayload } from './details.js';
import { recordNotification } from './record-notification.js';
import { renderMessage } from './templates.js';

export type DeliveryDeps = {
  provider: EmailProvider;
  /** Outbox processing window (SLICE-08): a `RUNNING` row older than this is a crashed attempt. */
  processingWindowMs: number;
  /** Total execution attempts per job (SLICE-08); the last failed attempt ends in `FAILED`. */
  maxAttempts: number;
  now?: () => Date;
};

const uuid = z.uuid();
const ALERT_SOURCE_BLOCKED = 'ALERT_SOURCE_BLOCKED';

const idOf = (payload: ProcessorInput['payload'], key: string): string | undefined => {
  const value = payload[key];
  return typeof value === 'string' && uuid.safeParse(value).success ? value : undefined;
};

/**
 * The admin notice written by SLICE-03 before this slice existed carries no `notificationId`:
 * `{ kind: 'ALERT_SOURCE_BLOCKED', alertSourceId, attemptCount, requestId }`. The consumer stores
 * the `Notification` itself, keyed on the outbox event id, so a redelivery of the same event finds
 * the same row. Returns `null` when no active Admin exists (the row is stored as `FAILED`).
 */
async function materializeLegacyBlockedNotice(input: ProcessorInput): Promise<string | null> {
  const alertSourceId = idOf(input.payload, 'alertSourceId');
  if (input.payload.kind !== ALERT_SOURCE_BLOCKED || alertSourceId === undefined) {
    throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: notificationId');
  }
  return runInTransaction(async (tx) => {
    const recorded = await recordNotification(tx, {
      eventType: ALERT_SOURCE_BLOCKED,
      occurrenceId: input.outboxEventId,
      alertSourceId,
      ...(typeof input.payload.requestId === 'string'
        ? { requestId: input.payload.requestId }
        : {}),
    });
    if (recorded.created) return recorded.hasRecipients ? recorded.notificationId : null;
    return findNotificationIdByKey(tx, recorded.idempotencyKey);
  });
}

function isNoRecipientsFailure(row: StoredNotification): boolean {
  const response = row.providerResponse;
  return (
    typeof response === 'object' &&
    response !== null &&
    !Array.isArray(response) &&
    response.reason === 'NO_RECIPIENTS'
  );
}

/** The error to throw (so the SLICE-08 wrapper retries or dead-letters), and its receipt. */
function describeFailure(error: unknown): {
  thrown: Error;
  retryable: boolean;
  receipt: EmailReceipt;
} {
  if (error instanceof EmailProviderError) {
    const thrown = error.retryable
      ? new RetryableJobError(
          error.kind === 'RATE_LIMITED'
            ? 'RATE_LIMITED'
            : error.kind === 'NETWORK'
              ? 'NETWORK'
              : 'SERVICE_UNAVAILABLE',
          error.message,
          error.retryAfterMs,
        )
      : new NonRetryableJobError(
          error.kind === 'CONFIGURATION'
            ? 'AUTHENTICATION_OR_CONFIGURATION'
            : 'BUSINESS_RULE_VIOLATION',
          error.message,
        );
    return { thrown, retryable: error.retryable, receipt: error.receipt };
  }
  const { retryable, errorClass } = classifyError(error);
  return {
    thrown: error instanceof Error ? error : new Error('Unknown notification failure'),
    retryable,
    receipt: { error: errorClass },
  };
}

/**
 * The consumer of `NOTIFICATION_REQUESTED` (SLICE-09 §4.4): claim the row, send one email to all
 * recipients, then record the outcome. Delivery is at-least-once; a crash after the provider
 * accepted the message can send it twice.
 */
export function createNotificationProcessor(deps: DeliveryDeps): OutboxProcessor {
  const clock = deps.now ?? (() => new Date());

  return async (input) => {
    const db = getPrisma();
    const requestId =
      typeof input.payload.requestId === 'string' ? input.payload.requestId : undefined;

    const rawId = input.payload.notificationId;
    let notificationId: string | null;
    if (rawId === undefined) {
      notificationId = await materializeLegacyBlockedNotice(input);
    } else if (typeof rawId === 'string' && uuid.safeParse(rawId).success) {
      notificationId = rawId;
    } else {
      throw new NonRetryableJobError('INVALID_PAYLOAD', 'Invalid payload fields: notificationId');
    }
    if (notificationId === null) return;

    const log = logger.child({ notificationId, outboxEventId: input.outboxEventId, requestId });

    /** Terminal rows end the job quietly (`true`) or loudly; `false` means it may be claimed. */
    const settled = (row: StoredNotification | null): boolean => {
      if (row === null)
        throw new NonRetryableJobError('RESOURCE_NOT_FOUND', 'Notification not found');
      if (row.deliveryStatus === 'COMPLETED') {
        log.info({ outcome: 'already_completed' }, 'Notification already delivered');
        return true;
      }
      if (row.deliveryStatus === 'FAILED') {
        if (isNoRecipientsFailure(row)) {
          log.info({ outcome: 'no_recipients' }, 'Notification has no recipients; nothing to send');
          return true;
        }
        throw new NonRetryableJobError('BUSINESS_RULE_VIOLATION', 'Notification already failed');
      }
      return false;
    };

    if (settled(await findNotification(db, notificationId))) return;

    const startedAt = clock();
    const staleBefore = new Date(startedAt.getTime() - deps.processingWindowMs);
    if (!(await claimNotification(db, notificationId, startedAt, staleBefore))) {
      if (settled(await findNotification(db, notificationId))) return;
      throw new RetryableJobError(
        'WORKER_INTERRUPTED',
        'Notification is being delivered by another attempt',
      );
    }

    const row = (await findNotification(db, notificationId))!;
    try {
      const emails = await findRecipientEmails(db, row.recipients);
      if (emails.length === 0) {
        await finishAttempt(db, notificationId, clock(), {
          to: 'FAILED',
          providerResponse: { reason: 'NO_RECIPIENTS' },
          countAttempt: false,
        });
        log.warn({ outcome: 'no_recipients' }, 'No recipient can be reached; stored as FAILED');
        return;
      }
      const eventType = row.eventType;
      if (!isNotificationEventType(eventType)) {
        throw new NonRetryableJobError('INVALID_PAYLOAD', 'Unknown notification event type');
      }

      const facts = await findTemplateFacts(db, {
        incidentId: idOf(input.payload, 'incidentId') ?? row.incidentId ?? undefined,
        teamId: idOf(input.payload, 'teamId'),
        serviceId: idOf(input.payload, 'serviceId'),
        alertSourceId: idOf(input.payload, 'alertSourceId'),
      });
      const { subject, text } = renderMessage(eventType, facts, detailsFromPayload(input.payload));
      const receipt = await deps.provider.send({
        idempotencyKey: row.idempotencyKey,
        to: emails,
        subject,
        text,
      });

      await runInTransaction(async (tx) => {
        const changed = await finishAttempt(tx, notificationId, clock(), {
          to: 'COMPLETED',
          providerResponse: receipt,
          countAttempt: true,
        });
        if (changed && row.incidentId !== null && writesNotifiedEvent(eventType)) {
          await appendAuditEvent(tx, {
            incidentId: row.incidentId,
            eventType: 'NOTIFIED',
            actorId: null,
            metadata: { recipients: row.recipients },
          });
        }
      });
      log.info(
        { eventType: row.eventType, attempt: input.attempt, outcome: 'completed' },
        'Notification delivered',
      );
    } catch (error) {
      const { thrown, retryable, receipt } = describeFailure(error);
      const willRetry = retryable && input.attempt < deps.maxAttempts;
      try {
        await finishAttempt(db, notificationId, clock(), {
          to: willRetry ? 'REQUESTED' : 'FAILED',
          providerResponse: receipt,
          countAttempt: true,
        });
      } catch (recordError) {
        log.warn({ err: recordError }, 'Could not record the failed attempt');
      }
      log.warn(
        {
          eventType: row.eventType,
          attempt: input.attempt,
          retryable,
          outcome: willRetry ? 'retry_scheduled' : 'failed',
        },
        'Notification delivery attempt failed',
      );
      throw thrown;
    }
  };
}
