import type { User } from '../../../generated/prisma/client.js';

export type UserResponse = {
  id: string;
  name: string;
  email: string;
  role: 'ENGINEER' | 'TEAM_LEAD' | 'ADMIN';
  status: 'ACTIVE' | 'DEACTIVATED';
  teamId: string | null;
  leadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Explicit field list: `passwordHash` can never leak into a response. */
export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    teamId: user.teamId,
    leadId: user.leadId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
