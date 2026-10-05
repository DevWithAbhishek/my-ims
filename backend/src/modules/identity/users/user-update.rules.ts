import { ConflictError } from '../../../shared/errors/AppError.js';
import { invalidAction } from '../identity.common.js';
import type { UpdateUserBody } from './user.schema.js';

type Role = 'ENGINEER' | 'TEAM_LEAD' | 'ADMIN';
type Status = 'ACTIVE' | 'DEACTIVATED';

export type UpdateTarget = {
  id: string;
  role: Role;
  status: Status;
  teamId: string | null;
  leadId: string | null;
};

/** State read under lock that the rules need. `null` means "referenced row does not exist". */
export type UpdateFacts = {
  newTeam: { status: Status } | null;
  lead: { role: Role; status: Status; teamId: string | null } | null;
  assignedToUnresolvedIncident: boolean;
  reportingUsers: number;
};

export type UserUpdatePlan = {
  data: {
    name?: string;
    role?: 'ENGINEER' | 'TEAM_LEAD';
    status?: Status;
    teamId?: string;
    leadId?: string | null;
  };
  revokeSessions: boolean;
};

const assignedCurrently = () =>
  new ConflictError('User is assigned to an unresolved incident', 'USER_ASSIGNED_CURRENTLY');
const stillHasEngineers = () =>
  new ConflictError('Team Lead still has engineers', 'CONFLICT_STILL_HAS_ENGINEERS');

/**
 * Applies the U4 rules to the locked target and returns what to write. Throws `403 INVALID_ACTION`
 * for invalid references first, then the `409`s (`USER_ASSIGNED_CURRENTLY` wins over
 * `CONFLICT_STILL_HAS_ENGINEERS`).
 */
export function planUserUpdate(
  target: UpdateTarget,
  body: UpdateUserBody,
  facts: UpdateFacts,
): UserUpdatePlan {
  if (target.role === 'ADMIN' && body.role !== undefined) {
    throw invalidAction('The role of an Admin cannot be changed');
  }

  const teamProvided = body.teamId !== undefined;
  if (teamProvided && (!facts.newTeam || facts.newTeam.status !== 'ACTIVE')) {
    throw invalidAction('teamId must reference an active team');
  }
  const teamChanged = teamProvided && body.teamId !== target.teamId;
  const resultingTeamId = teamChanged ? (body.teamId ?? null) : target.teamId;
  const roleChanged = body.role !== undefined && body.role !== target.role;
  const resultingRole: Role = body.role ?? target.role;
  const statusChanged = body.status !== undefined && body.status !== target.status;

  let leadId = target.leadId;
  if (teamChanged || (roleChanged && resultingRole === 'TEAM_LEAD')) leadId = null;

  if (body.leadId !== undefined) {
    if (resultingRole !== 'ENGINEER') throw invalidAction('Only engineers can have a lead');
    if (resultingTeamId === null) throw invalidAction('leadId requires the user to have a team');
    const lead = facts.lead;
    const validLead =
      body.leadId !== target.id &&
      lead !== null &&
      lead.status === 'ACTIVE' &&
      lead.role === 'TEAM_LEAD' &&
      lead.teamId === resultingTeamId;
    if (!validLead)
      throw invalidAction('leadId must reference an active Team Lead of the same team');
    leadId = body.leadId;
  }

  const movingOutOfTeam = teamChanged && target.teamId !== null;
  const deactivating = statusChanged && body.status === 'DEACTIVATED';

  if (facts.assignedToUnresolvedIncident && (movingOutOfTeam || roleChanged || deactivating)) {
    throw assignedCurrently();
  }
  if (
    target.role === 'TEAM_LEAD' &&
    facts.reportingUsers > 0 &&
    ((roleChanged && resultingRole === 'ENGINEER') || deactivating || movingOutOfTeam)
  ) {
    throw stillHasEngineers();
  }

  const data: UserUpdatePlan['data'] = {};
  if (body.name !== undefined) data.name = body.name;
  if (roleChanged && body.role !== undefined) data.role = body.role;
  if (statusChanged && body.status !== undefined) data.status = body.status;
  if (teamChanged && body.teamId !== undefined) data.teamId = body.teamId;
  if (leadId !== target.leadId) data.leadId = leadId;

  return {
    data,
    revokeSessions: body.password !== undefined || roleChanged || teamChanged || statusChanged,
  };
}
