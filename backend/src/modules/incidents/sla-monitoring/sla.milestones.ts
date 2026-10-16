import { deriveIdempotencyKey, type NotificationEventType } from '../../notifications/index.js';

export type SlaClockName = 'RESPONSE' | 'RESOLUTION';

export const ESCALATION_LEVELS = [1, 2, 3, 4] as const;
export type EscalationLevel = (typeof ESCALATION_LEVELS)[number];

/** The once-only identities of SLICE-07 §4 (the `<milestone>` part of the notification key). */
export type Milestone =
  | 'RESPONSE_WARNING'
  | 'RESOLUTION_WARNING'
  | 'RESPONSE_BREACH'
  | 'RESOLUTION_BREACH'
  | `ESCALATION_LEVEL_${EscalationLevel}`
  | `ESCALATION_FAILURE_${EscalationLevel}`;

export const warningMilestone = (clock: SlaClockName): Milestone => `${clock}_WARNING`;
export const breachMilestone = (clock: SlaClockName): Milestone => `${clock}_BREACH`;
export const levelMilestone = (level: EscalationLevel): Milestone => `ESCALATION_LEVEL_${level}`;
export const failureMilestone = (level: EscalationLevel): Milestone =>
  `ESCALATION_FAILURE_${level}`;

export const ALL_MILESTONES: readonly Milestone[] = [
  'RESPONSE_WARNING',
  'RESOLUTION_WARNING',
  'RESPONSE_BREACH',
  'RESOLUTION_BREACH',
  ...ESCALATION_LEVELS.map(levelMilestone),
  ...ESCALATION_LEVELS.map(failureMilestone),
];

export function isMilestone(value: string): value is Milestone {
  return (ALL_MILESTONES as readonly string[]).includes(value);
}

/** The notification event a milestone produces (SLICE-07 §4 matrix). */
export function notificationEventOf(milestone: Milestone): NotificationEventType {
  switch (milestone) {
    case 'RESPONSE_WARNING':
    case 'RESOLUTION_WARNING':
      return 'SLA_WARNING';
    case 'RESPONSE_BREACH':
      return 'RESPONSE_BREACH';
    case 'RESOLUTION_BREACH':
      return 'RESOLUTION_BREACH';
    case 'ESCALATION_LEVEL_1':
      return 'ESCALATED_L1';
    case 'ESCALATION_LEVEL_2':
      return 'ESCALATED_L2';
    case 'ESCALATION_LEVEL_3':
      return 'ESCALATED_L3';
    case 'ESCALATION_LEVEL_4':
      return 'ESCALATED_L4';
    default:
      return 'ESCALATION_FAILED';
  }
}

/** `Notification.idempotencyKey` of a milestone: the database-level once-only key. */
export function milestoneKey(incidentId: string, milestone: Milestone): string {
  return deriveIdempotencyKey(notificationEventOf(milestone), incidentId, milestone);
}

/** The audit event of an escalation level (`ESCALATED_L1` … `ESCALATED_L4`). */
export function escalationAuditEvent(
  level: EscalationLevel,
): 'ESCALATED_L1' | 'ESCALATED_L2' | 'ESCALATED_L3' | 'ESCALATED_L4' {
  return `ESCALATED_L${level}`;
}
