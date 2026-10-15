import type { AuthContext } from '../../../shared/types/auth-context.js';
import type { Severity } from '../incidents.types.js';
import {
  assertMayResolve,
  assertMaySetSeverity,
  assertRequiredState,
  UNRESOLVED_STATUSES,
} from './lifecycle.rules.js';
import { NO_CHANGE, type LockedIncident, type OutboxStep, type Plan } from './lifecycle.types.js';

const slaEvaluation = (incident: LockedIncident): OutboxStep => ({
  eventType: 'SLA_EVALUATION_REQUESTED',
  aggregateType: 'INCIDENT',
  aggregateId: incident.id,
  payload: { incidentId: incident.id },
});

/** I3: `OPEN → ACKNOWLEDGED`; an unassigned incident is auto-assigned to the caller. */
export function planAcknowledge(incident: LockedIncident, callerId: string, now: Date): Plan {
  assertRequiredState(incident.status, ['OPEN']);
  const autoAssigned = incident.currentAssigneeId === null;
  return {
    changes: {
      status: 'ACKNOWLEDGED',
      acknowledgedById: callerId,
      acknowledgedTimestamp: now,
      ...(autoAssigned ? { currentAssigneeId: callerId } : {}),
    },
    events: [
      ...(autoAssigned
        ? [
            {
              eventType: 'ASSIGNED' as const,
              metadata: { from: null, to: callerId, auto: true },
              subjectUserId: callerId,
            },
          ]
        : []),
      {
        eventType: 'ACKNOWLEDGED',
        metadata: { acknowledgedBy: callerId, autoAssigned },
        subjectUserId: callerId,
      },
    ],
    outbox: [],
  };
}

/** I4: `ACKNOWLEDGED → MITIGATING` with the confirmed severity (written even when unchanged). */
export function planConfirmSeverity(
  incident: LockedIncident,
  severity: Severity,
  callerId: string,
  now: Date,
): Plan {
  assertRequiredState(incident.status, ['ACKNOWLEDGED']);
  return {
    changes: {
      severity,
      severityConfirmedById: callerId,
      severityConfirmTimestamp: now,
      status: 'MITIGATING',
    },
    events: [
      {
        eventType: 'SEVERITY_CONFIRMED',
        metadata: {
          from: incident.severity,
          to: severity,
          statusFrom: 'ACKNOWLEDGED',
          statusTo: 'MITIGATING',
        },
      },
    ],
    outbox: [slaEvaluation(incident)],
  };
}

/** I5: severity change in any unresolved status; the same value is a no-op. */
export function planChangeSeverity(
  incident: LockedIncident,
  severity: Severity,
  auth: AuthContext,
): Plan {
  assertRequiredState(incident.status, UNRESOLVED_STATUSES);
  assertMaySetSeverity(auth, incident.status);
  if (incident.severity === severity) return NO_CHANGE;
  return {
    changes: { severity },
    events: [
      {
        eventType: 'SEVERITY_CONFIRMED',
        metadata: {
          from: incident.severity,
          to: severity,
          statusFrom: incident.status,
          statusTo: incident.status,
        },
      },
    ],
    outbox: [slaEvaluation(incident)],
  };
}

/** I6: (re)assign in any unresolved status; the current assignee again is a no-op. */
export function planAssign(incident: LockedIncident, assigneeId: string): Plan {
  assertRequiredState(incident.status, UNRESOLVED_STATUSES);
  const previous = incident.currentAssigneeId;
  if (previous === assigneeId) return NO_CHANGE;
  return {
    changes: { currentAssigneeId: assigneeId },
    events: [
      previous === null
        ? {
            eventType: 'ASSIGNED',
            metadata: { from: null, to: assigneeId, auto: false },
            subjectUserId: assigneeId,
          }
        : {
            eventType: 'REASSIGNED',
            metadata: { from: previous, to: assigneeId },
            subjectUserId: assigneeId,
          },
    ],
    outbox: [],
  };
}

/** I7: drop the assignee and the acknowledgement and return to `OPEN`. */
export function planUnassign(incident: LockedIncident): Plan {
  assertRequiredState(incident.status, UNRESOLVED_STATUSES);
  const previous = incident.currentAssigneeId;
  const returnsToOpen = incident.status !== 'OPEN';
  if (previous === null && !returnsToOpen) return NO_CHANGE;
  return {
    changes: {
      currentAssigneeId: null,
      status: 'OPEN',
      acknowledgedById: null,
      acknowledgedTimestamp: null,
    },
    events: [
      ...(previous === null
        ? []
        : [
            {
              eventType: 'REASSIGNED' as const,
              metadata: { from: previous, to: null },
              subjectUserId: previous,
            },
          ]),
      ...(returnsToOpen
        ? [{ eventType: 'OPEN' as const, metadata: { statusFrom: incident.status } }]
        : []),
    ],
    outbox: returnsToOpen ? [slaEvaluation(incident)] : [],
  };
}

/**
 * I8: `MITIGATING → RESOLVED`. The postmortem row, the cleared alert keys and the generation
 * outbox event are added by the action, which knows the postmortem id.
 */
export function planResolve(
  incident: LockedIncident,
  auth: AuthContext,
  resolutionSummary: string,
  now: Date,
): Plan {
  assertRequiredState(incident.status, ['MITIGATING']);
  assertMayResolve(auth, incident.currentAssigneeId);
  return {
    changes: {
      status: 'RESOLVED',
      resolvedById: auth.userId,
      resolvedTimestamp: now,
      resolutionSummary,
    },
    events: [
      {
        eventType: 'RESOLVED',
        metadata: { resolutionSummary, serviceConfirmedWorking: true },
      },
    ],
    outbox: [],
  };
}
