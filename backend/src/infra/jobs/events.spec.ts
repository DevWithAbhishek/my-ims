import { randomUUID } from 'node:crypto';
import { RATE_LIMITED_QUEUES } from '../../config/env';
import {
  DEAD_LETTER_QUEUE,
  OUTBOX_EVENT_TYPES,
  QUEUE_NAMES,
  queueForEvent,
  validatePayload,
  type OutboxEventType,
} from './events';

describe('event catalog', () => {
  it('maps every event type to its queue', () => {
    expect(queueForEvent('ALERT_TRIAGE_REQUESTED')).toBe('ai-triage');
    expect(queueForEvent('SLA_EVALUATION_REQUESTED')).toBe('sla-escalation');
    expect(queueForEvent('NOTIFICATION_REQUESTED')).toBe('notifications');
    expect(queueForEvent('POSTMORTEM_GENERATION_REQUESTED')).toBe('postmortem');
    expect(queueForEvent('INVESTIGATION_REQUESTED')).toBe('investigation');
    expect(queueForEvent('SOMETHING_ELSE')).toBeUndefined();
    expect(queueForEvent('toString')).toBeUndefined();
  });

  it('keeps the five queues, the dead-letter queue and the configured rate limits in step', () => {
    expect([...QUEUE_NAMES].sort()).toEqual([...RATE_LIMITED_QUEUES].sort());
    expect(DEAD_LETTER_QUEUE).toBe('dead-letter');
  });
});

describe('validatePayload', () => {
  const id = () => randomUUID();
  const valid: Record<OutboxEventType, unknown> = {
    ALERT_TRIAGE_REQUESTED: { alertId: id(), incidentId: id(), requestId: 'req-1' },
    SLA_EVALUATION_REQUESTED: { incidentId: id() },
    NOTIFICATION_REQUESTED: { kind: 'INCIDENT_ASSIGNED', incidentId: id(), recipientIds: [id()] },
    POSTMORTEM_GENERATION_REQUESTED: { postmortemId: id(), incidentId: id() },
    INVESTIGATION_REQUESTED: { investigationId: id(), incidentId: id(), requestId: 'r_2' },
  };

  it.each(Object.keys(valid) as OutboxEventType[])('accepts a valid %s payload', (type) => {
    expect(validatePayload(type, valid[type]).ok).toBe(true);
  });

  it.each(Object.keys(valid) as OutboxEventType[])('rejects an empty %s payload', (type) => {
    expect(validatePayload(type, {}).ok).toBe(false);
  });

  it('rejects ids that are not UUIDs, unknown keys and bad request ids', () => {
    expect(validatePayload('SLA_EVALUATION_REQUESTED', { incidentId: 'nope' }).ok).toBe(false);
    expect(validatePayload('SLA_EVALUATION_REQUESTED', { incidentId: id(), body: 'x' }).ok).toBe(
      false,
    );
    expect(
      validatePayload('SLA_EVALUATION_REQUESTED', { incidentId: id(), requestId: 'bad id!' }).ok,
    ).toBe(false);
  });

  it('keeps notification extras to short scalars or id lists (no bodies or objects)', () => {
    const base = { kind: 'X', incidentId: id() };
    expect(validatePayload('NOTIFICATION_REQUESTED', { ...base, body: { text: 'hi' } }).ok).toBe(
      false,
    );
    expect(validatePayload('NOTIFICATION_REQUESTED', { ...base, text: 'x'.repeat(129) }).ok).toBe(
      false,
    );
  });

  it('exposes exactly the five catalog event types', () => {
    expect(Object.values(OUTBOX_EVENT_TYPES).sort()).toEqual(Object.keys(valid).sort());
  });
});
