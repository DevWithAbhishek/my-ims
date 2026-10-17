import type { Prisma } from '../../../generated/prisma/client.js';
import type { AuditEventType } from '../../../generated/prisma/enums.js';
import type { NotificationEventType } from '../../notifications/index.js';
import type { IncidentStatus, Severity } from '../incidents.types.js';

/** The incident row as read under `FOR UPDATE`. */
export type LockedIncident = {
  id: string;
  teamId: string;
  affectedServiceId: string;
  status: IncidentStatus;
  severity: Severity;
  currentAssigneeId: string | null;
  acknowledgedById: string | null;
};

/** What the team gate and the pre-lock gates need to know; read before the transaction opens. */
export type TransitionScope = { teamId: string; affectedServiceId: string; status: IncidentStatus };

/** The scalar columns a lifecycle action may change (API names are mapped in the repository). */
export type IncidentChanges = Pick<
  Prisma.IncidentUncheckedUpdateInput,
  | 'status'
  | 'severity'
  | 'currentAssigneeId'
  | 'acknowledgedById'
  | 'acknowledgedTimestamp'
  | 'severityConfirmedById'
  | 'severityConfirmTimestamp'
  | 'resolvedById'
  | 'resolvedTimestamp'
  | 'resolutionSummary'
  | 'closedById'
  | 'closedTimestamp'
>;

/** One audit event; the caller is its actor. Every event written also gets one notification. */
export type AuditStep = {
  eventType: Extract<AuditEventType, NotificationEventType>;
  metadata: Prisma.InputJsonObject;
  subjectUserId?: string;
};

export type OutboxStep = {
  eventType: 'SLA_EVALUATION_REQUESTED' | 'POSTMORTEM_GENERATION_REQUESTED';
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

/** A transition decided under the lock: nothing at all (a no-op) or changes with their events. */
export type Plan = { changes: IncidentChanges; events: AuditStep[]; outbox: OutboxStep[] };

export const NO_CHANGE: Plan = { changes: {}, events: [], outbox: [] };
