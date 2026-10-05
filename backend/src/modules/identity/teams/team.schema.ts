import { z } from 'zod';
import { limitSchema, offsetSchema, sortSchema, uuidSchema } from '../identity.common.js';

const teamName = z.string().min(1).max(50);
const teamStatus = z.enum(['ACTIVE', 'DEACTIVATED']);

export const createTeamBodySchema = z.object({ name: teamName }).strict();

export const updateTeamBodySchema = z
  .object({ name: teamName.optional(), status: teamStatus.optional() })
  .strict()
  .refine((body) => body.name !== undefined || body.status !== undefined, {
    message: 'At least one field is required',
  });

export const teamParamsSchema = z.object({ teamId: uuidSchema }).strict();

export const listTeamsQuerySchema = z
  .object({
    limit: limitSchema,
    offset: offsetSchema,
    orderBy: z.enum(['name', 'createdAt']).default('name'),
    sort: sortSchema,
  })
  .strict();

export type UpdateTeamBody = z.output<typeof updateTeamBodySchema>;
export type ListTeamsQuery = z.output<typeof listTeamsQuerySchema>;
