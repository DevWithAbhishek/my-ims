import { isUniqueViolation } from '../../../infra/db/errors.js';
import { getPrisma, lockRowForUpdate } from '../../../infra/db/prisma.js';
import { ConflictError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { assertSameTeam, requireTeam } from '../auth/guard.js';
import { hashPassword } from '../auth/password.js';
import { revokeSessionsForUsers } from '../auth/session.repository.js';
import { invalidAction, notFound, toPage, type Page } from '../identity.common.js';
import { findTeamById } from '../teams/team.repository.js';
import { concurrencyConflict, runIdentityTransaction, type Db } from '../transaction.js';
import { planUserUpdate } from './user-update.rules.js';
import { toUserResponse, type UserResponse } from './user.mapper.js';
import {
  countReportingUsers,
  createUser as insertUser,
  findUserById,
  isAssignedToUnresolvedIncident,
  listUsersOfTeam,
  updateUser as writeUser,
} from './user.repository.js';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody } from './user.schema.js';

const userNotFound = () => notFound('user', 'USER_NOT_FOUND');
const teamNotFound = () => notFound('team', 'TEAM_NOT_FOUND');

export async function createUser(body: CreateUserBody): Promise<UserResponse> {
  const passwordHash = await hashPassword(body.password);
  try {
    return await runIdentityTransaction(async (tx) => {
      if (body.leadId !== undefined) {
        if (body.teamId === undefined) throw invalidAction('leadId requires teamId');
        if (body.role !== 'ENGINEER') throw invalidAction('Only engineers can have a lead');
      }

      if (body.teamId !== undefined) {
        await lockRowForUpdate(tx, 'Team', body.teamId);
        const team = await findTeamById(tx, body.teamId);
        if (!team || team.status !== 'ACTIVE') {
          throw invalidAction('teamId must reference an active team');
        }
      }

      if (body.leadId !== undefined) {
        await lockRowForUpdate(tx, 'User', body.leadId);
        const lead = await findUserById(tx, body.leadId);
        if (
          !lead ||
          lead.status !== 'ACTIVE' ||
          lead.role !== 'TEAM_LEAD' ||
          lead.teamId !== body.teamId
        ) {
          throw invalidAction('leadId must reference an active Team Lead of the same team');
        }
      }

      const user = await insertUser(tx, {
        name: body.name,
        email: body.email,
        passwordHash,
        role: body.role,
        teamId: body.teamId ?? null,
        leadId: body.leadId ?? null,
      });
      return toUserResponse(user);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('Email already exists', 'EMAIL_ALREADY_EXISTS');
    }
    throw error;
  }
}

export async function listTeamUsers(
  auth: AuthContext,
  teamId: string,
  query: ListUsersQuery,
): Promise<Page<UserResponse>> {
  if (auth.role !== 'ADMIN') {
    requireTeam(auth);
    assertSameTeam(auth, teamId);
  }
  const db = getPrisma();
  if (!(await findTeamById(db, teamId))) throw teamNotFound();
  const rows = await listUsersOfTeam(db, teamId, query);
  return toPage(rows.map(toUserResponse), query.limit, query.offset);
}

export async function getUser(auth: AuthContext, userId: string): Promise<UserResponse> {
  if (auth.role !== 'ADMIN') requireTeam(auth);
  const user = await findUserById(getPrisma(), userId);
  if (!user) throw userNotFound();
  if (auth.role !== 'ADMIN') assertSameTeam(auth, user.teamId);
  return toUserResponse(user);
}

/** Locks rows in a fixed order (teams, then users by id) so concurrent writers cannot deadlock. */
async function lockInOrder(tx: Db, teamIds: string[], userIds: string[]): Promise<void> {
  for (const id of [...new Set(teamIds)].sort()) await lockRowForUpdate(tx, 'Team', id);
  for (const id of [...new Set(userIds)].sort()) await lockRowForUpdate(tx, 'User', id);
}

export async function updateUser(userId: string, body: UpdateUserBody): Promise<UserResponse> {
  const passwordHash = body.password === undefined ? undefined : await hashPassword(body.password);
  return runIdentityTransaction(async (tx) => {
    const preRead = await findUserById(tx, userId);
    if (!preRead) throw userNotFound();

    const teamIds = [preRead.teamId, body.teamId].filter((id): id is string => id != null);
    const userIds = [userId, ...(body.leadId !== undefined ? [body.leadId] : [])];
    await lockInOrder(tx, teamIds, userIds);

    const target = await findUserById(tx, userId);
    if (!target) throw userNotFound();
    if (target.teamId !== preRead.teamId) throw concurrencyConflict();

    const plan = planUserUpdate(target, body, {
      newTeam: body.teamId === undefined ? null : await findTeamById(tx, body.teamId),
      lead: body.leadId === undefined ? null : await findUserById(tx, body.leadId),
      assignedToUnresolvedIncident: await isAssignedToUnresolvedIncident(tx, userId),
      reportingUsers: target.role === 'TEAM_LEAD' ? await countReportingUsers(tx, userId) : 0,
    });

    const updated = await writeUser(tx, userId, {
      ...plan.data,
      ...(passwordHash === undefined ? {} : { passwordHash }),
    });
    if (plan.revokeSessions) await revokeSessionsForUsers(tx, [userId]);
    return toUserResponse(updated);
  });
}
