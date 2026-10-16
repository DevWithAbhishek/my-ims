import { logger } from '../../shared/observability/logger.js';
import type { TransactionClient } from '../../infra/db/prisma.js';
import {
  catalogEntry,
  SUBJECT_REQUIRED,
  type NotificationEventType,
  type NotificationScope,
} from './catalog.js';
import { deriveIdempotencyKey, entityIdOf } from './idempotency-key.js';
import {
  findActiveUserIds,
  findIncidentFacts,
  findServiceFacts,
  insertNotificationOnce,
  type IncidentFacts,
} from './notification.repository.js';
import { planRecipientQuery } from './recipients.js';

/** Producer contract of SLICE-09: what happened, what makes this occurrence unique, its context. */
export type EnqueueNotificationInput = {
  eventType: NotificationEventType;
  /** The audit event id, milestone name, outbox event id or block-window identity (see the key rule). */
  occurrenceId: string;
  incidentId?: string;
  serviceId?: string;
  teamId?: string;
  alertSourceId?: string;
  /** The specific user some rules name (assignee, investigation requester). */
  subjectUserId?: string;
  requestId?: string;
};

export type EnqueueNotificationResult = {
  /** `null` when the occurrence was already recorded. */
  notificationId: string | null;
  created: boolean;
};

/** The producer passed an event or context that the contract cannot accept. */
export class NotificationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationContractError';
  }
}

export type RecordedNotification = EnqueueNotificationResult & {
  /** Whether at least one active recipient was resolved (always `false` for a duplicate). */
  hasRecipients: boolean;
  idempotencyKey: string;
};

async function factsFor(
  tx: TransactionClient,
  scope: NotificationScope,
  input: EnqueueNotificationInput,
): Promise<Pick<IncidentFacts, 'teamId' | 'resolvedById' | 'level3Id' | 'fallbackAdminId'>> {
  const none = { teamId: null, resolvedById: null, level3Id: null, fallbackAdminId: null };
  switch (scope) {
    case 'INCIDENT': {
      if (!input.incidentId) throw new NotificationContractError('incidentId is required');
      const facts = await findIncidentFacts(tx, input.incidentId);
      if (!facts) throw new NotificationContractError('The incident does not exist');
      return facts;
    }
    case 'SERVICE': {
      if (!input.serviceId) throw new NotificationContractError('serviceId is required');
      const facts = await findServiceFacts(tx, input.serviceId);
      if (!facts) throw new NotificationContractError('The service does not exist');
      return facts;
    }
    case 'TEAM':
      if (!input.teamId) throw new NotificationContractError('teamId is required');
      return { ...none, teamId: input.teamId };
    case 'ADMIN':
      return none;
  }
}

/**
 * Resolves the recipients now and inserts the `Notification` once per occurrence, on the caller's
 * transaction. A duplicate occurrence changes nothing. With no active recipient the row is stored
 * as `FAILED` (`NO_RECIPIENTS`). It never writes the outbox event: callers decide that.
 */
export async function recordNotification(
  tx: TransactionClient,
  input: EnqueueNotificationInput,
): Promise<RecordedNotification> {
  const entry = catalogEntry(input.eventType);
  const entityId = entityIdOf(input);
  if (entityId === undefined) {
    throw new NotificationContractError(
      'One of incidentId, teamId, serviceId, alertSourceId is required',
    );
  }
  if (input.occurrenceId.length === 0) {
    throw new NotificationContractError('occurrenceId is required');
  }
  if (SUBJECT_REQUIRED.has(input.eventType) && !input.subjectUserId) {
    throw new NotificationContractError('subjectUserId is required for this event type');
  }

  const idempotencyKey = deriveIdempotencyKey(input.eventType, entityId, input.occurrenceId);
  const facts = await factsFor(tx, entry.scope, input);
  const recipients = await findActiveUserIds(
    tx,
    planRecipientQuery(input.eventType, { ...facts, subjectUserId: input.subjectUserId ?? null }),
  );
  const hasRecipients = recipients.length > 0;

  const notificationId = await insertNotificationOnce(tx, {
    deliveryStatus: hasRecipients ? 'REQUESTED' : 'FAILED',
    notificationType: entry.type,
    eventType: input.eventType,
    idempotencyKey,
    recipients,
    incidentId: input.incidentId ?? null,
    ...(hasRecipients ? {} : { providerResponse: { reason: 'NO_RECIPIENTS' } }),
  });

  if (notificationId === null) {
    return { notificationId: null, created: false, hasRecipients: false, idempotencyKey };
  }
  if (!hasRecipients) {
    logger.warn(
      {
        notificationId,
        eventType: input.eventType,
        incidentId: input.incidentId,
        requestId: input.requestId,
        outcome: 'no_recipients',
      },
      'Notification has no active recipient; stored as FAILED',
    );
  }
  return { notificationId, created: true, hasRecipients, idempotencyKey };
}
