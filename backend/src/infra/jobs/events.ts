import { z } from 'zod';

/** BullMQ queues fed by the outbox relay. */
export const QUEUES = {
  AI_TRIAGE: 'ai-triage',
  SLA_ESCALATION: 'sla-escalation',
  NOTIFICATIONS: 'notifications',
  POSTMORTEM: 'postmortem',
  INVESTIGATION: 'investigation',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUES);

/** The single queue that receives a job describing every dead-lettered outbox event. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

export const OUTBOX_EVENT_TYPES = {
  ALERT_TRIAGE_REQUESTED: 'ALERT_TRIAGE_REQUESTED',
  SLA_EVALUATION_REQUESTED: 'SLA_EVALUATION_REQUESTED',
  NOTIFICATION_REQUESTED: 'NOTIFICATION_REQUESTED',
  POSTMORTEM_GENERATION_REQUESTED: 'POSTMORTEM_GENERATION_REQUESTED',
  INVESTIGATION_REQUESTED: 'INVESTIGATION_REQUESTED',
} as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];

const uuid = z.uuid();
/** Same character set and limit as the `X-Request-Id` header. */
const requestId = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional();

/**
 * Payloads carry ids and the minimum facts only. Notification payloads are open-ended (SLICE-09
 * owns the kinds), so extra keys are allowed but only as short scalars or short id lists, which
 * keeps bodies, prompts and secrets out of the outbox.
 */
const notificationExtra = z.union([
  z.string().max(128),
  z.number(),
  z.boolean(),
  z.array(z.string().max(128)).max(50),
]);

const payloadSchemas = {
  ALERT_TRIAGE_REQUESTED: z.strictObject({ alertId: uuid, incidentId: uuid, requestId }),
  SLA_EVALUATION_REQUESTED: z.strictObject({ incidentId: uuid, requestId }),
  NOTIFICATION_REQUESTED: z
    .object({
      kind: z.string().min(1).max(64),
      incidentId: uuid.optional(),
      actorId: uuid.optional(),
      requestId,
    })
    .catchall(notificationExtra),
  POSTMORTEM_GENERATION_REQUESTED: z.strictObject({
    postmortemId: uuid,
    incidentId: uuid,
    requestId,
  }),
  INVESTIGATION_REQUESTED: z.strictObject({ investigationId: uuid, incidentId: uuid, requestId }),
} as const satisfies Record<OutboxEventType, z.ZodType>;

const EVENT_QUEUE: Record<OutboxEventType, QueueName> = {
  ALERT_TRIAGE_REQUESTED: QUEUES.AI_TRIAGE,
  SLA_EVALUATION_REQUESTED: QUEUES.SLA_ESCALATION,
  NOTIFICATION_REQUESTED: QUEUES.NOTIFICATIONS,
  POSTMORTEM_GENERATION_REQUESTED: QUEUES.POSTMORTEM,
  INVESTIGATION_REQUESTED: QUEUES.INVESTIGATION,
};

export type OutboxPayload = Record<string, unknown> & { requestId?: string };

export function isOutboxEventType(value: string): value is OutboxEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_QUEUE, value);
}

/** The queue that consumes `eventType`, or `undefined` when the event type is not in the catalog. */
export function queueForEvent(eventType: string): QueueName | undefined {
  return isOutboxEventType(eventType) ? EVENT_QUEUE[eventType] : undefined;
}

/** Validates a payload against its event type's schema; returns the issue paths on failure. */
export function validatePayload(
  eventType: OutboxEventType,
  payload: unknown,
): { ok: true; payload: OutboxPayload } | { ok: false; fields: string[] } {
  const result = payloadSchemas[eventType].safeParse(payload);
  if (result.success) return { ok: true, payload: result.data as OutboxPayload };
  return {
    ok: false,
    fields: [...new Set(result.error.issues.map((i) => i.path.join('.') || '*'))],
  };
}
