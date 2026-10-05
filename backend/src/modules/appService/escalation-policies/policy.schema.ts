import { z } from 'zod';
import { uuidSchema } from '../appService.common.js';

export const policyUsersBodySchema = z
  .object({
    level1: uuidSchema,
    level2: uuidSchema,
    level3: uuidSchema,
    fallbackAdmin: uuidSchema,
  })
  .strict();

export const updatePolicyBodySchema = z
  .object({
    level1: uuidSchema.optional(),
    level2: uuidSchema.optional(),
    level3: uuidSchema.optional(),
    fallbackAdmin: uuidSchema.optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field is required',
  });

export const policyServiceParamsSchema = z.object({ serviceId: uuidSchema }).strict();

export const policyParamsSchema = z
  .object({ serviceId: uuidSchema, escalationPolicyId: uuidSchema })
  .strict();

export type UpdatePolicyBody = z.output<typeof updatePolicyBodySchema>;
