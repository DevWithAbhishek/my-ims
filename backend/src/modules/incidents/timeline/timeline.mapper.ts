import {
  INCIDENT_EVENT_TYPES,
  type IncidentEventType,
  type TimelineItem,
  type UserSummary,
} from '../incidents.types.js';

/**
 * Stored-metadata contract for producers of incident audit events: `metadata` carries the public
 * `details` keys of the event type, except that every `UserSummary` field holds the user's uuid
 * (resolved to `{ id, name }` here, at read time). `COMMENT_ADDED` stores a snapshot
 * `{ id, title, body, authorId, createdAt }` under `comment`. Keys outside the whitelist below are
 * never exposed, and raw `metadata` is never returned.
 */
export type StoredAuditEvent = {
  id: string;
  eventType: IncidentEventType;
  actor: string | null;
  metadata: unknown;
  createdAt: Date;
};

type Metadata = Record<string, unknown>;
type ResolveUser = (id: string) => UserSummary;
type DetailsBuilder = (metadata: Metadata, user: ResolveUser) => Record<string, unknown>;

const asMetadata = (value: unknown): Metadata =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Metadata) : {};

const text = (metadata: Metadata, key: string): string | null => {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
};

const flag = (metadata: Metadata, key: string): boolean => metadata[key] === true;

const userRef = (metadata: Metadata, key: string, user: ResolveUser): UserSummary | null => {
  const id = text(metadata, key);
  return id === null ? null : user(id);
};

const userList = (metadata: Metadata, key: string, user: ResolveUser): UserSummary[] => {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((id): id is string => typeof id === 'string').map(user);
};

const texts =
  (...keys: string[]): DetailsBuilder =>
  (metadata) =>
    Object.fromEntries(keys.map((key) => [key, text(metadata, key)]));

const escalated: DetailsBuilder = (metadata, user) => ({
  notifiedUser: userRef(metadata, 'notifiedUser', user),
});

const DETAILS: Record<IncidentEventType, DetailsBuilder> = {
  ALERT_RECEIVED: texts('alertId'),
  ALERT_DUPLICATE: texts('alertSourceId'),
  AI_TRIAGE_COMPLETED: texts('createdAt'),
  INCIDENT_CREATED: texts('incidentId'),
  ASSIGNED: (metadata, user) => ({
    from: userRef(metadata, 'from', user),
    to: userRef(metadata, 'to', user),
    auto: flag(metadata, 'auto'),
  }),
  REASSIGNED: (metadata, user) => ({
    from: userRef(metadata, 'from', user),
    to: userRef(metadata, 'to', user),
  }),
  OPEN: texts('statusFrom'),
  ACKNOWLEDGED: (metadata) => ({
    acknowledgedBy: text(metadata, 'acknowledgedBy'),
    autoAssigned: flag(metadata, 'autoAssigned'),
  }),
  SEVERITY_CONFIRMED: texts('from', 'to', 'statusFrom', 'statusTo'),
  COMMENT_ADDED: (metadata, user) => {
    const comment = asMetadata(metadata.comment);
    return {
      comment:
        text(comment, 'id') === null
          ? null
          : {
              id: text(comment, 'id'),
              title: text(comment, 'title'),
              body: text(comment, 'body'),
              author: userRef(comment, 'authorId', user),
              createdAt: text(comment, 'createdAt'),
            },
    };
  },
  SLA_WARNING: texts('kind'),
  ESCALATED_L1: escalated,
  ESCALATED_L2: escalated,
  ESCALATED_L3: escalated,
  ESCALATED_L4: escalated,
  SOURCE_ALERT_RESOLVED: texts('alertId'),
  RESOLVED: (metadata) => ({
    resolutionSummary: text(metadata, 'resolutionSummary'),
    serviceConfirmedWorking: flag(metadata, 'serviceConfirmedWorking'),
  }),
  NOTIFIED: (metadata, user) => ({ recipients: userList(metadata, 'recipients', user) }),
  POSTMORTEM_GENERATED: texts('postmortemId'),
  POSTMORTEM_REVIEWED: (metadata, user) => ({
    postmortemId: text(metadata, 'postmortemId'),
    reviewedBy: userRef(metadata, 'reviewedBy', user),
  }),
  AI_INVESTIGATION_COMPLETED: texts('investigationId'),
  CLOSED: texts('closedAt'),
};

export function isIncidentEventType(value: string): value is IncidentEventType {
  return (INCIDENT_EVENT_TYPES as readonly string[]).includes(value);
}

/** Every user id the events refer to (actor and metadata), so they can be loaded in one query. */
export function collectUserIds(events: StoredAuditEvent[]): string[] {
  const found = new Set<string>();
  const collect: ResolveUser = (id) => {
    found.add(id);
    return { id, name: '' };
  };
  for (const event of events) {
    if (event.actor !== null) found.add(event.actor);
    DETAILS[event.eventType](asMetadata(event.metadata), collect);
  }
  return [...found];
}

/** Whitelists the details of each event and resolves user ids to `UserSummary`. */
export function toTimelineItems(
  events: StoredAuditEvent[],
  users: ReadonlyMap<string, UserSummary>,
): TimelineItem[] {
  const resolve: ResolveUser = (id) => users.get(id) ?? { id, name: '' };
  return events.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    actor: event.actor === null ? null : resolve(event.actor),
    details: DETAILS[event.eventType](asMetadata(event.metadata), resolve),
    createdAt: event.createdAt.toISOString(),
  }));
}
