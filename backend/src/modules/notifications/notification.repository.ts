import { Prisma } from '../../generated/prisma/client.js';
import type { NotificationDeliveryStatus, NotificationType } from '../../generated/prisma/enums.js';
import type { TransactionClient } from '../../infra/db/prisma.js';
import type { RecipientContext, RecipientQuery } from './recipients.js';

type Db = TransactionClient;

/** Team, service and escalation-policy users an incident's recipient rules refer to. */
export type IncidentFacts = Omit<RecipientContext, 'subjectUserId'>;

export async function findIncidentFacts(db: Db, incidentId: string): Promise<IncidentFacts | null> {
  const incident = await db.incident.findUnique({
    where: { id: incidentId },
    select: {
      teamId: true,
      resolvedById: true,
      affectedService: {
        select: { escalationPolicy: { select: { level3Id: true, fallbackAdminId: true } } },
      },
    },
  });
  if (!incident) return null;
  const policy = incident.affectedService.escalationPolicy;
  return {
    teamId: incident.teamId,
    resolvedById: incident.resolvedById,
    level3Id: policy.level3Id,
    fallbackAdminId: policy.fallbackAdminId,
  };
}

export async function findServiceFacts(db: Db, serviceId: string): Promise<IncidentFacts | null> {
  const service = await db.appService.findUnique({
    where: { id: serviceId },
    select: {
      teamId: true,
      escalationPolicy: { select: { level3Id: true, fallbackAdminId: true } },
    },
  });
  if (!service) return null;
  return {
    teamId: service.teamId,
    resolvedById: null,
    level3Id: service.escalationPolicy.level3Id,
    fallbackAdminId: service.escalationPolicy.fallbackAdminId,
  };
}

/** Ids of the ACTIVE users the query names, ascending and without duplicates. */
export async function findActiveUserIds(db: Db, query: RecipientQuery): Promise<string[]> {
  const matches: Prisma.UserWhereInput[] = [];
  if (query.teamId !== null) matches.push({ teamId: query.teamId });
  if (query.userIds.length > 0) matches.push({ id: { in: query.userIds } });
  if (query.allAdmins) matches.push({ role: 'ADMIN' });
  if (matches.length === 0) return [];

  const users = await db.user.findMany({
    where: { status: 'ACTIVE', OR: matches },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return users.map((user) => user.id);
}

export type NewNotification = {
  deliveryStatus: NotificationDeliveryStatus;
  notificationType: NotificationType;
  eventType: string;
  idempotencyKey: string;
  recipients: string[];
  incidentId: string | null;
  providerResponse?: Prisma.InputJsonObject;
};

/**
 * Inserts the row unless its idempotency key exists (`ON CONFLICT DO NOTHING`, so a duplicate
 * does not abort the caller's transaction). Returns the new id, or `null` for a duplicate.
 */
export async function insertNotificationOnce(
  db: Db,
  data: NewNotification,
): Promise<string | null> {
  const rows = await db.notification.createManyAndReturn({
    data: [
      {
        deliveryStatus: data.deliveryStatus,
        notificationType: data.notificationType,
        eventType: data.eventType,
        idempotencyKey: data.idempotencyKey,
        recipients: data.recipients,
        incidentId: data.incidentId,
        ...(data.providerResponse === undefined ? {} : { providerResponse: data.providerResponse }),
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  return rows[0]?.id ?? null;
}

export async function findNotificationIdByKey(db: Db, key: string): Promise<string | null> {
  const row = await db.notification.findUnique({
    where: { idempotencyKey: key },
    select: { id: true },
  });
  return row?.id ?? null;
}

export type StoredNotification = {
  id: string;
  deliveryStatus: NotificationDeliveryStatus;
  eventType: string;
  idempotencyKey: string;
  recipients: string[];
  incidentId: string | null;
  providerResponse: Prisma.JsonValue | null;
};

const STORED_SELECT = {
  id: true,
  deliveryStatus: true,
  eventType: true,
  idempotencyKey: true,
  recipients: true,
  incidentId: true,
  providerResponse: true,
} as const;

export function findNotification(db: Db, id: string): Promise<StoredNotification | null> {
  return db.notification.findUnique({ where: { id }, select: STORED_SELECT });
}

/**
 * Conditional claim `REQUESTED → RUNNING`; a `RUNNING` row is also claimable when its last attempt
 * is older than `staleBefore` (a crashed attempt). Returns whether this caller won the claim.
 */
export async function claimNotification(
  db: Db,
  id: string,
  now: Date,
  staleBefore: Date,
): Promise<boolean> {
  const claimed = await db.notification.updateMany({
    where: {
      id,
      OR: [
        { deliveryStatus: 'REQUESTED' },
        { deliveryStatus: 'RUNNING', lastAttemptTimestamp: { lt: staleBefore } },
      ],
    },
    data: { deliveryStatus: 'RUNNING', lastAttemptTimestamp: now },
  });
  return claimed.count === 1;
}

type Outcome = {
  to: NotificationDeliveryStatus;
  providerResponse: Prisma.InputJsonObject;
  /** Whether a send was attempted (the attempt counter then goes up by one). */
  countAttempt: boolean;
};

/** Moves a `RUNNING` row to its outcome. Returns whether this call changed the row. */
export async function finishAttempt(
  db: Db,
  id: string,
  now: Date,
  outcome: Outcome,
): Promise<boolean> {
  const changed = await db.$executeRaw`
    UPDATE "Notification"
    SET "deliveryStatus" = ${outcome.to}::"NotificationDeliveryStatus",
        "attemptCount" = COALESCE("attemptCount", 0) + ${outcome.countAttempt ? 1 : 0},
        "lastAttemptTimestamp" = ${now},
        "providerResponse" = ${JSON.stringify(outcome.providerResponse)}::jsonb
    WHERE "id" = ${id}::uuid AND "deliveryStatus" = 'RUNNING'::"NotificationDeliveryStatus"`;
  return changed === 1;
}

export async function findRecipientEmails(db: Db, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { email: true },
    orderBy: { id: 'asc' },
  });
  return users.map((user) => user.email);
}

/** What a message may say about its subject. Everything is optional: a row may be gone. */
export type TemplateFacts = {
  incidentTitle?: string;
  severity?: string;
  status?: string;
  serviceName?: string;
  teamName?: string;
  alertSourceName?: string;
};

export type TemplateIds = {
  incidentId?: string;
  teamId?: string;
  serviceId?: string;
  alertSourceId?: string;
};

export async function findTemplateFacts(db: Db, ids: TemplateIds): Promise<TemplateFacts> {
  const facts: TemplateFacts = {};
  if (ids.incidentId) {
    const incident = await db.incident.findUnique({
      where: { id: ids.incidentId },
      select: {
        title: true,
        severity: true,
        status: true,
        affectedService: { select: { name: true } },
      },
    });
    if (incident) {
      facts.incidentTitle = incident.title;
      facts.severity = incident.severity;
      facts.status = incident.status;
      facts.serviceName = incident.affectedService.name;
    }
  }
  if (ids.serviceId && facts.serviceName === undefined) {
    const service = await db.appService.findUnique({
      where: { id: ids.serviceId },
      select: { name: true },
    });
    if (service) facts.serviceName = service.name;
  }
  if (ids.teamId) {
    const team = await db.team.findUnique({ where: { id: ids.teamId }, select: { name: true } });
    if (team) facts.teamName = team.name;
  }
  if (ids.alertSourceId) {
    const source = await db.alertSource.findUnique({
      where: { id: ids.alertSourceId },
      select: { name: true },
    });
    if (source) facts.alertSourceName = source.name;
  }
  return facts;
}
