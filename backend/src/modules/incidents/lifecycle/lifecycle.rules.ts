import { ConflictError, ForbiddenError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import type { IncidentStatus } from '../incidents.types.js';

/** Statuses in which severity and assignment may still change. */
export const UNRESOLVED_STATUSES: readonly IncidentStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'MITIGATING',
];

/** Gate 3: `409 INVALID_STATE_TRANSITION`; `requiredStatus` is one status or the allowed set. */
export function assertRequiredState(
  current: IncidentStatus,
  required: readonly IncidentStatus[],
): void {
  if (required.includes(current)) return;
  throw new ConflictError(
    'The incident is not in a state that allows this action',
    'INVALID_STATE_TRANSITION',
    [
      {
        currentStatus: current,
        requiredStatus: required.length === 1 ? required[0] : [...required],
      },
    ],
  );
}

/** Gate 1 for I6 and I7. */
export function requireManagerRole(auth: AuthContext): void {
  if (auth.role === 'ENGINEER') {
    throw new ForbiddenError('Role is not allowed to perform this action', 'FORBIDDEN_ROLE');
  }
}

/** I5: an Engineer may not change the severity of an `OPEN` incident. */
export function assertMaySetSeverity(auth: AuthContext, status: IncidentStatus): void {
  if (auth.role === 'ENGINEER' && status === 'OPEN') {
    throw new ForbiddenError('Role is not allowed to perform this action', 'FORBIDDEN_ROLE');
  }
}

/** I8: Team Leads and Admins resolve any incident, an Engineer only as the current assignee. */
export function assertMayResolve(auth: AuthContext, currentAssigneeId: string | null): void {
  if (auth.role === 'ENGINEER' && currentAssigneeId !== auth.userId) {
    throw new ForbiddenError('Only the current assignee may resolve', 'NOT_CURRENT_ASSIGNEE');
  }
}

export type EscalationChain = {
  level1: string;
  level2: string;
  level3: string;
  fallbackAdmin: string;
};

/** The four users of the service's escalation policy. */
export function isChainMember(chain: EscalationChain | null, userId: string): boolean {
  if (chain === null) return false;
  return [chain.level1, chain.level2, chain.level3, chain.fallbackAdmin].includes(userId);
}

export function assertChainMember(chain: EscalationChain | null, userId: string): void {
  if (!isChainMember(chain, userId)) {
    throw new ForbiddenError('Caller is not in the escalation chain of the service', 'FORBIDDEN');
  }
}

export type AssigneeCandidate = {
  role: 'ENGINEER' | 'TEAM_LEAD' | 'ADMIN';
  status: 'ACTIVE' | 'DEACTIVATED';
  teamId: string | null;
};

/** I6: an `ACTIVE` Engineer or Team Lead of the incident's team (a missing user is `null`). */
export function isEligibleAssignee(candidate: AssigneeCandidate | null, teamId: string): boolean {
  return (
    candidate !== null &&
    candidate.status === 'ACTIVE' &&
    candidate.teamId === teamId &&
    (candidate.role === 'ENGINEER' || candidate.role === 'TEAM_LEAD')
  );
}

/** One generic error for every ineligible assignee: it never reveals whether the user exists. */
export function assigneeNotEligible(): ForbiddenError {
  return new ForbiddenError(
    'The user cannot be assigned to this incident',
    'ASSIGNEE_NOT_ELIGIBLE',
  );
}
