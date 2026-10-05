import type { Team } from '../../../generated/prisma/client.js';

export type TeamResponse = {
  id: string;
  name: string;
  status: 'ACTIVE' | 'DEACTIVATED';
  createdAt: Date;
  updatedAt: Date;
};

export function toTeamResponse(team: Team): TeamResponse {
  return {
    id: team.id,
    name: team.name,
    status: team.status,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}
