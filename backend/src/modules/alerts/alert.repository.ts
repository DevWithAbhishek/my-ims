import { Prisma } from '../../generated/prisma/client.js';
import { lockRowForUpdate, type TransactionClient } from '../../infra/db/prisma.js';
import type { NormalizedAlert } from './alert-input.js';
import type { AlertIdentity } from './identity.js';
import type { Severity } from './severity.js';

type Db = TransactionClient;

export type AlertRef = { id: string; incidentId: string | null };

/** The unresolved alert that carries this active identity key, if any. */
export function findAlertByActiveKey(
  db: Db,
  alertSourceId: string,
  activeIdentityKey: string,
): Promise<AlertRef | null> {
  return db.alert.findUnique({
    where: { alertSourceId_activeIdentityKey: { alertSourceId, activeIdentityKey } },
    select: { id: true, incidentId: true },
  });
}

/**
 * The most recent alert of this source with the same identity, by `sourceEventId` or
 * `sourceFingerprint` (not the active key, which may already be cleared).
 */
export function findLatestAlertByIdentity(
  db: Db,
  alertSourceId: string,
  identity: AlertIdentity,
): Promise<(AlertRef & { sourceStatus: 'FIRING' | 'RESOLVED' }) | null> {
  const match =
    identity.kind === 'EVENT_ID'
      ? { sourceEventId: identity.value }
      : { sourceFingerprint: identity.value };
  return db.alert.findFirst({
    where: { alertSourceId, ...match },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, incidentId: true, sourceStatus: true },
  });
}

export type NewAlert = {
  alert: NormalizedAlert;
  identity: AlertIdentity;
  initialSeverity: Severity;
  originalPayload: unknown;
  alertSourceId: string;
  incidentId: string;
};

/** Inserts the alert of a new incident, carrying its active identity key. */
export function insertAlert(db: Db, input: NewAlert): Promise<{ id: string }> {
  const { alert, identity } = input;
  return db.alert.create({
    data: {
      sourceEventId: alert.sourceEventId,
      sourceFingerprint: identity.sourceFingerprint,
      name: alert.name,
      environment: alert.environment,
      sourceSeverity: alert.sourceSeverity,
      initialSeverity: input.initialSeverity,
      summary: alert.summary,
      description: alert.description,
      labels: alert.labels,
      additionalDetails: alert.additionalDetails,
      startedTimestamp: alert.startedAt,
      endedTimestamp: alert.endedAt,
      sourceUrl: alert.sourceUrl,
      originalPayload: input.originalPayload as Prisma.InputJsonValue,
      activeIdentityKey: identity.activeIdentityKey,
      sourceStatus: 'FIRING',
      alertSourceId: input.alertSourceId,
      affectedServiceId: alert.serviceId,
      incidentId: input.incidentId,
    },
    select: { id: true },
  });
}

/**
 * Records the source's own "resolved" on an alert. The row is locked first and its state re-checked,
 * so two simultaneous deliveries write one change (and one audit event). Returns whether this call
 * made the change.
 */
export async function markSourceResolved(
  db: Db,
  alertId: string,
  endedTimestamp: Date,
): Promise<boolean> {
  await lockRowForUpdate(db, 'Alert', alertId);
  const current = await db.alert.findUnique({
    where: { id: alertId },
    select: { sourceStatus: true },
  });
  if (current === null || current.sourceStatus === 'RESOLVED') return false;
  await db.alert.update({
    where: { id: alertId },
    data: { sourceStatus: 'RESOLVED', endedTimestamp, updatedAt: new Date() },
  });
  return true;
}

const DETAIL_SELECT = {
  id: true,
  incidentId: true,
  name: true,
  environment: true,
  sourceSeverity: true,
  initialSeverity: true,
  sourceStatus: true,
  startedTimestamp: true,
  endedTimestamp: true,
  sourceUrl: true,
  sourceEventId: true,
  sourceFingerprint: true,
  summary: true,
  description: true,
  labels: true,
  additionalDetails: true,
  originalPayload: true,
  alertSource: { select: { id: true, name: true } },
} satisfies Prisma.AlertSelect;

export type AlertDetailRow = Prisma.AlertGetPayload<{ select: typeof DETAIL_SELECT }>;

/** One alert of one incident (`null` when it does not exist or belongs to another incident). */
export function findAlertOfIncident(
  db: Db,
  incidentId: string,
  alertId: string,
): Promise<AlertDetailRow | null> {
  return db.alert.findFirst({ where: { id: alertId, incidentId }, select: DETAIL_SELECT });
}
