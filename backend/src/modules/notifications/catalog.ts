import type { NotificationType } from '../../generated/prisma/enums.js';

/** Where a recipient comes from (SLICE-09 §4.3). All sources are filtered to ACTIVE users. */
export type RecipientSource =
  'TEAM_MEMBERS' | 'SUBJECT_USER' | 'RESOLVED_BY' | 'LEVEL3' | 'FALLBACK_ADMIN' | 'ALL_ADMINS';

/**
 * What the event is about, which decides where its team, service and escalation policy are read
 * from: the incident, the team itself, the service itself, or no entity at all (Admin notices).
 */
export type NotificationScope = 'INCIDENT' | 'TEAM' | 'SERVICE' | 'ADMIN';

type CatalogEntry = {
  type: NotificationType;
  scope: NotificationScope;
  recipients: readonly RecipientSource[];
};

const entry = (
  type: NotificationType,
  scope: NotificationScope,
  recipients: readonly RecipientSource[],
): CatalogEntry => ({ type, scope, recipients });

const TEAM_AND_FALLBACK = ['TEAM_MEMBERS', 'FALLBACK_ADMIN'] as const;
const LEVEL3_AND_FALLBACK = ['LEVEL3', 'FALLBACK_ADMIN'] as const;
const SUBJECT_LEVEL3_FALLBACK = ['SUBJECT_USER', 'LEVEL3', 'FALLBACK_ADMIN'] as const;
const RESOLVER_LEVEL3_FALLBACK = ['RESOLVED_BY', 'LEVEL3', 'FALLBACK_ADMIN'] as const;

/** The notification event catalog: event type → notification type, scope and recipient rule. */
export const NOTIFICATION_CATALOG = {
  // INFO
  AI_TRIAGE_COMPLETED: entry('INFO', 'INCIDENT', LEVEL3_AND_FALLBACK),
  POSTMORTEM_GENERATED: entry('INFO', 'INCIDENT', RESOLVER_LEVEL3_FALLBACK),
  POSTMORTEM_REVIEWED: entry('INFO', 'INCIDENT', RESOLVER_LEVEL3_FALLBACK),
  AI_INVESTIGATION_COMPLETED: entry('INFO', 'INCIDENT', SUBJECT_LEVEL3_FALLBACK),
  TEAM_UPDATED: entry('INFO', 'TEAM', ['TEAM_MEMBERS']),
  TEAM_DEACTIVATED: entry('INFO', 'TEAM', ['TEAM_MEMBERS']),
  SERVICE_UPDATED: entry('INFO', 'SERVICE', TEAM_AND_FALLBACK),
  SERVICE_DEACTIVATED: entry('INFO', 'SERVICE', TEAM_AND_FALLBACK),
  // WARNING
  SLA_WARNING: entry('WARNING', 'INCIDENT', TEAM_AND_FALLBACK),
  ESCALATED_L1: entry('WARNING', 'INCIDENT', TEAM_AND_FALLBACK),
  ESCALATED_L2: entry('WARNING', 'INCIDENT', TEAM_AND_FALLBACK),
  ESCALATED_L3: entry('WARNING', 'INCIDENT', TEAM_AND_FALLBACK),
  ESCALATED_L4: entry('WARNING', 'INCIDENT', TEAM_AND_FALLBACK),
  POSTMORTEM_GENERATION_FAILED: entry('WARNING', 'INCIDENT', ['RESOLVED_BY', 'LEVEL3']),
  // ALERT
  INCIDENT_CREATED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  ASSIGNED: entry('ALERT', 'INCIDENT', SUBJECT_LEVEL3_FALLBACK),
  REASSIGNED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  OPEN: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  ACKNOWLEDGED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  SEVERITY_CONFIRMED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  SOURCE_ALERT_RESOLVED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  RESOLVED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  CLOSED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  ESCALATION_POLICY_UPDATED: entry('ALERT', 'SERVICE', TEAM_AND_FALLBACK),
  RESPONSE_BREACH: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  RESOLUTION_BREACH: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  ESCALATION_FAILED: entry('ALERT', 'INCIDENT', TEAM_AND_FALLBACK),
  ALERT_SOURCE_BLOCKED: entry('ALERT', 'ADMIN', ['ALL_ADMINS']),
  INVESTIGATION_REQUEST_BLOCKED: entry('ALERT', 'ADMIN', ['ALL_ADMINS']),
} as const satisfies Record<string, CatalogEntry>;

export type NotificationEventType = keyof typeof NOTIFICATION_CATALOG;

export function isNotificationEventType(value: string): value is NotificationEventType {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOG, value);
}

export function catalogEntry(eventType: NotificationEventType): CatalogEntry {
  return NOTIFICATION_CATALOG[eventType];
}

/** Sources that need a specific user named by the producer. */
export const SUBJECT_REQUIRED: ReadonlySet<NotificationEventType> = new Set(
  (Object.keys(NOTIFICATION_CATALOG) as NotificationEventType[]).filter((eventType) =>
    (NOTIFICATION_CATALOG[eventType].recipients as readonly RecipientSource[]).includes(
      'SUBJECT_USER',
    ),
  ),
);

/**
 * `NOTIFIED` is appended only for notifications about an incident; Admin, team, service and
 * alert-source notices write none.
 */
export function writesNotifiedEvent(eventType: NotificationEventType): boolean {
  return NOTIFICATION_CATALOG[eventType].scope === 'INCIDENT';
}
