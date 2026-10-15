import { getEscalationPolicyByService } from '../../appService/index.js';
import { ValidationError, BadRequestError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { findIncidentDetail } from '../incident.repository.js';
import { toIncidentResponse } from '../incident.mapper.js';
import { incidentNotFound, type Db } from '../incidents.common.js';
import type { IncidentResponse, Severity } from '../incidents.types.js';
import {
  clearActiveIdentityKeys,
  insertGeneratingPostmortem,
  lockUserForShare,
} from './lifecycle.repository.js';
import {
  planAcknowledge,
  planAssign,
  planChangeSeverity,
  planConfirmSeverity,
  planResolve,
  planUnassign,
} from './lifecycle.plans.js';
import {
  assertChainMember,
  assigneeNotEligible,
  isEligibleAssignee,
  requireManagerRole,
} from './lifecycle.rules.js';
import type { Plan } from './lifecycle.types.js';
import { runTransition } from './transition.kernel.js';

async function respondWith(tx: Db, incidentId: string): Promise<IncidentResponse> {
  const row = await findIncidentDetail(tx, incidentId);
  if (row === null) throw incidentNotFound();
  return toIncidentResponse(row, new Date());
}

const chainGate = (auth: AuthContext) => async (scope: { affectedServiceId: string }) =>
  assertChainMember(await getEscalationPolicyByService(scope.affectedServiceId), auth.userId);

/** I3 acknowledge. Any role of the incident's team. */
export function acknowledgeIncident(auth: AuthContext, incidentId: string, requestId: string) {
  return runTransition({
    auth,
    incidentId,
    requestId,
    decide: async (tx, incident) => {
      // The acknowledging user is read by U4's conflict check under a user row lock (known issue 8).
      await lockUserForShare(tx, auth.userId);
      return planAcknowledge(incident, auth.userId, new Date());
    },
    respond: (tx) => respondWith(tx, incidentId),
  });
}

/** I4 confirm severity. Chain members only. */
export function confirmSeverity(
  auth: AuthContext,
  incidentId: string,
  severity: Severity,
  requestId: string,
) {
  return runTransition({
    auth,
    incidentId,
    requestId,
    gate: chainGate(auth),
    decide: (_tx, incident) => planConfirmSeverity(incident, severity, auth.userId, new Date()),
    respond: (tx) => respondWith(tx, incidentId),
  });
}

/** I5 change severity. Chain members; an Engineer not while the incident is `OPEN`. */
export function changeSeverity(
  auth: AuthContext,
  incidentId: string,
  severity: Severity,
  requestId: string,
) {
  return runTransition({
    auth,
    incidentId,
    requestId,
    gate: chainGate(auth),
    decide: (_tx, incident) => planChangeSeverity(incident, severity, auth),
    respond: (tx) => respondWith(tx, incidentId),
  });
}

/** I6 assign / reassign. Team Lead or Admin. */
export function assignIncident(
  auth: AuthContext,
  incidentId: string,
  assigneeId: string,
  requestId: string,
) {
  requireManagerRole(auth);
  return runTransition({
    auth,
    incidentId,
    requestId,
    decide: async (tx, incident) => {
      const candidate = await lockUserForShare(tx, assigneeId);
      if (!isEligibleAssignee(candidate, incident.teamId)) throw assigneeNotEligible();
      return planAssign(incident, assigneeId);
    },
    respond: (tx) => respondWith(tx, incidentId),
  });
}

/** I7 unassign. Team Lead or Admin. */
export function unassignIncident(auth: AuthContext, incidentId: string, requestId: string) {
  requireManagerRole(auth);
  return runTransition({
    auth,
    incidentId,
    requestId,
    decide: (_tx, incident) => planUnassign(incident),
    respond: (tx) => respondWith(tx, incidentId),
  });
}

export type ResolveInput = { resolutionSummary?: string; serviceConfirmedWorking?: boolean };

/**
 * Body validation of I8, after Gate 2 and before the lock: the summary is required (`422`) and
 * `serviceConfirmedWorking` must be `true` (`400`).
 */
function validateResolveInput(input: ResolveInput): string {
  if (input.resolutionSummary === undefined) {
    throw new ValidationError('resolutionSummary is required', 'VALIDATION_FAILED', [
      { field: 'resolutionSummary', issue: 'Required' },
    ]);
  }
  if (input.serviceConfirmedWorking !== true) {
    throw new BadRequestError('serviceConfirmedWorking must be true to resolve an incident');
  }
  return input.resolutionSummary;
}

/**
 * I8 resolve. In the same transaction: the `Postmortem` row (`GENERATING` / `PENDING`), the
 * identity keys of every alert cleared, and the generation request in the outbox.
 */
export function resolveIncident(
  auth: AuthContext,
  incidentId: string,
  input: ResolveInput,
  requestId: string,
) {
  let resolutionSummary = '';
  return runTransition({
    auth,
    incidentId,
    requestId,
    gate: () => {
      resolutionSummary = validateResolveInput(input);
    },
    decide: async (tx, incident): Promise<Plan> => {
      const plan = planResolve(incident, auth, resolutionSummary, new Date());
      const postmortem = await insertGeneratingPostmortem(tx, incidentId);
      await clearActiveIdentityKeys(tx, incidentId);
      return {
        ...plan,
        outbox: [
          ...plan.outbox,
          {
            eventType: 'POSTMORTEM_GENERATION_REQUESTED',
            aggregateType: 'POSTMORTEM',
            aggregateId: postmortem.id,
            payload: { postmortemId: postmortem.id, incidentId },
          },
        ],
      };
    },
    respond: (tx) => respondWith(tx, incidentId),
  });
}
