import { isUniqueViolation } from '../../../infra/db/errors.js';
import { getPrisma, lockRowForUpdate } from '../../../infra/db/prisma.js';
import { ConflictError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { assertSameTeam, requireTeam } from '../auth/guard.js';
import { revokeSessionsForUsers } from '../auth/session.repository.js';
import { invalidAction, notFound, toPage, type Page } from '../identity.common.js';
import { runIdentityTransaction } from '../transaction.js';
import { toTeamResponse, type TeamResponse } from './team.mapper.js';
import {
  createTeam as insertTeam,
  detachUsersFromTeam,
  findTeamById,
  hasAttachedServices,
  hasUnresolvedIncidents,
  listTeams as selectTeams,
  updateTeam as writeTeam,
} from './team.repository.js';
import type { ListTeamsQuery, UpdateTeamBody } from './team.schema.js';

const duplicateTeam = () => new ConflictError('Team name already exists', 'DUPLICATE_TEAM');
const teamNotFound = () => notFound('team', 'TEAM_NOT_FOUND');

export async function createTeam(name: string): Promise<TeamResponse> {
  try {
    return toTeamResponse(await insertTeam(getPrisma(), name));
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateTeam();
    throw error;
  }
}

export async function listTeams(query: ListTeamsQuery): Promise<Page<TeamResponse>> {
  const rows = await selectTeams(getPrisma(), query);
  return toPage(rows.map(toTeamResponse), query.limit, query.offset);
}

export async function getTeam(auth: AuthContext, teamId: string): Promise<TeamResponse> {
  if (auth.role !== 'ADMIN') {
    requireTeam(auth);
    assertSameTeam(auth, teamId);
  }
  const team = await findTeamById(getPrisma(), teamId);
  if (!team) throw teamNotFound();
  return toTeamResponse(team);
}

export async function updateTeam(teamId: string, body: UpdateTeamBody): Promise<TeamResponse> {
  try {
    return await runIdentityTransaction(async (tx) => {
      if (!(await lockRowForUpdate(tx, 'Team', teamId))) throw teamNotFound();
      const team = await findTeamById(tx, teamId);
      if (!team) throw teamNotFound();

      const deactivating = body.status === 'DEACTIVATED' && team.status === 'ACTIVE';
      if (deactivating) {
        // Open incidents take precedence over attached services when both apply.
        if (await hasUnresolvedIncidents(tx, teamId)) {
          throw new ConflictError('Team has unresolved incidents', 'TEAM_WITH_OPEN_INCIDENT');
        }
        if (await hasAttachedServices(tx, teamId)) {
          throw invalidAction('Reassign the team services before deactivating it');
        }
      }

      const updated = await writeTeam(tx, teamId, { name: body.name, status: body.status });
      if (deactivating) {
        const userIds = await detachUsersFromTeam(tx, teamId);
        await revokeSessionsForUsers(tx, userIds);
      }
      return toTeamResponse(updated);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateTeam();
    throw error;
  }
}
