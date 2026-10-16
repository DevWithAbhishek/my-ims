import type { NotificationEventType } from './catalog.js';

/** The ids that identify what a notification is about. */
export type NotificationEntityIds = {
  incidentId?: string;
  teamId?: string;
  serviceId?: string;
  alertSourceId?: string;
};

/** The entity of a key: the incident, or else the team, service or alert source. */
export function entityIdOf(ids: NotificationEntityIds): string | undefined {
  return ids.incidentId ?? ids.teamId ?? ids.serviceId ?? ids.alertSourceId;
}

/**
 * `<eventType>:<entityId>:<occurrenceId>`. `occurrenceId` is what makes one occurrence unique (the
 * audit event id, a milestone name, an outbox event id, a block-window identity), so the same
 * occurrence always yields the same key and a later one a different key.
 */
export function deriveIdempotencyKey(
  eventType: NotificationEventType,
  entityId: string,
  occurrenceId: string,
): string {
  return `${eventType}:${entityId}:${occurrenceId}`;
}
