import { z } from 'zod';
import { emailSchema, passwordSchema } from '../auth/auth.schema.js';
import { limitSchema, offsetSchema, sortSchema, uuidSchema } from '../identity.common.js';

const name = z.string().min(1).max(50);
const assignableRole = z.enum(['ENGINEER', 'TEAM_LEAD']);
const status = z.enum(['ACTIVE', 'DEACTIVATED']);

export const createUserBodySchema = z
  .object({
    name,
    email: emailSchema,
    password: passwordSchema,
    role: assignableRole.default('ENGINEER'),
    teamId: uuidSchema.optional(),
    leadId: uuidSchema.optional(),
  })
  .strict();

export const updateUserBodySchema = z
  .object({
    name: name.optional(),
    password: passwordSchema.optional(),
    role: assignableRole.optional(),
    status: status.optional(),
    teamId: uuidSchema.optional(),
    leadId: uuidSchema.optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field is required',
  });

export const userParamsSchema = z.object({ userId: uuidSchema }).strict();
export const teamUsersParamsSchema = z.object({ teamId: uuidSchema }).strict();

export const listUsersQuerySchema = z
  .object({
    limit: limitSchema,
    offset: offsetSchema,
    role: assignableRole.optional(),
    status: status.optional(),
    orderBy: z.enum(['name', 'createdAt']).default('name'),
    sort: sortSchema,
  })
  .strict();

export type CreateUserBody = z.output<typeof createUserBodySchema>;
export type UpdateUserBody = z.output<typeof updateUserBodySchema>;
export type ListUsersQuery = z.output<typeof listUsersQuerySchema>;
