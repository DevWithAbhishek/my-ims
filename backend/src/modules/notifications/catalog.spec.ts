import {
  catalogEntry,
  isNotificationEventType,
  NOTIFICATION_CATALOG,
  writesNotifiedEvent,
  type NotificationEventType,
} from './catalog';
import { TEMPLATES } from './templates';

const INFO = [
  'AI_TRIAGE_COMPLETED',
  'POSTMORTEM_GENERATED',
  'POSTMORTEM_REVIEWED',
  'AI_INVESTIGATION_COMPLETED',
  'TEAM_UPDATED',
  'TEAM_DEACTIVATED',
  'SERVICE_UPDATED',
  'SERVICE_DEACTIVATED',
];
const WARNING = [
  'SLA_WARNING',
  'ESCALATED_L1',
  'ESCALATED_L2',
  'ESCALATED_L3',
  'ESCALATED_L4',
  'POSTMORTEM_GENERATION_FAILED',
];
const ALERT = [
  'INCIDENT_CREATED',
  'ASSIGNED',
  'REASSIGNED',
  'OPEN',
  'ACKNOWLEDGED',
  'SEVERITY_CONFIRMED',
  'SOURCE_ALERT_RESOLVED',
  'RESOLVED',
  'CLOSED',
  'ESCALATION_POLICY_UPDATED',
  'RESPONSE_BREACH',
  'RESOLUTION_BREACH',
  'ESCALATION_FAILED',
  'ALERT_SOURCE_BLOCKED',
  'INVESTIGATION_REQUEST_BLOCKED',
];

describe('notification catalog', () => {
  it('holds exactly the events of SLICE-09 §4.2', () => {
    expect(Object.keys(NOTIFICATION_CATALOG).sort()).toEqual(
      [...INFO, ...WARNING, ...ALERT].sort(),
    );
  });

  it.each([
    ['INFO', INFO],
    ['WARNING', WARNING],
    ['ALERT', ALERT],
  ])('maps the %s events to that notification type', (type, events) => {
    for (const event of events) {
      expect(catalogEntry(event as NotificationEventType).type).toBe(type);
    }
  });

  it('knows its own event types', () => {
    expect(isNotificationEventType('ASSIGNED')).toBe(true);
    expect(isNotificationEventType('COMMENT_ADDED')).toBe(false);
    expect(isNotificationEventType('NOTIFIED')).toBe(false);
    expect(isNotificationEventType('toString')).toBe(false);
  });

  it('writes NOTIFIED only for incident-scoped events', () => {
    expect(writesNotifiedEvent('ASSIGNED')).toBe(true);
    expect(writesNotifiedEvent('POSTMORTEM_GENERATION_FAILED')).toBe(true);
    for (const event of [
      'TEAM_UPDATED',
      'TEAM_DEACTIVATED',
      'SERVICE_UPDATED',
      'SERVICE_DEACTIVATED',
      'ESCALATION_POLICY_UPDATED',
      'ALERT_SOURCE_BLOCKED',
      'INVESTIGATION_REQUEST_BLOCKED',
    ] as const) {
      expect(writesNotifiedEvent(event)).toBe(false);
    }
  });

  it('has a template for every event type', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(Object.keys(NOTIFICATION_CATALOG).sort());
  });
});
