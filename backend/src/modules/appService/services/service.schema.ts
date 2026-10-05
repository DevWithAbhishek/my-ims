import { z } from 'zod';
import { limitSchema, offsetSchema, sortSchema, uuidSchema } from '../appService.common.js';
import { MAX_SLA_MINUTES, slaOrderingIssues, type SlaField, SLA_FIELDS } from '../sla.rules.js';

const serviceName = z.string().min(1).max(50);
const severity = z.enum(['P0', 'P1', 'P2', 'P3']);
const status = z.enum(['ACTIVE', 'DEACTIVATED']);
const slaMinutes = z.number().int().positive().max(MAX_SLA_MINUTES);

const slaShape = Object.fromEntries(SLA_FIELDS.map((field) => [field, slaMinutes])) as Record<
  SlaField,
  typeof slaMinutes
>;
const optionalSlaShape = Object.fromEntries(
  SLA_FIELDS.map((field) => [field, slaMinutes.optional()]),
) as Record<SlaField, z.ZodOptional<typeof slaMinutes>>;

/** Adds a `422` issue per severity whose resolution is below its response (where both are sent). */
function checkSlaOrdering(values: Partial<Record<SlaField, number>>, ctx: z.RefinementCtx): void {
  for (const { field, issue } of slaOrderingIssues(values)) {
    ctx.addIssue({ code: 'custom', path: [field], message: issue });
  }
}

export const createServiceBodySchema = z
  .object({
    name: serviceName,
    defaultSeverity: severity.optional(),
    ...slaShape,
    teamId: uuidSchema,
    escalationPolicy: z
      .object({
        level1: uuidSchema,
        level2: uuidSchema,
        level3: uuidSchema,
        fallbackAdmin: uuidSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine(checkSlaOrdering);

export const updateServiceBodySchema = z
  .object({
    name: serviceName.optional(),
    defaultSeverity: severity.optional(),
    status: status.optional(),
    ...optionalSlaShape,
    teamId: uuidSchema.optional(),
    escalationPolicyId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.values(body).every((value) => value === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'At least one field is required' });
    }
    checkSlaOrdering(body, ctx);
  });

export const serviceParamsSchema = z.object({ serviceId: uuidSchema }).strict();

export const listServicesQuerySchema = z
  .object({
    limit: limitSchema,
    offset: offsetSchema,
    teamId: uuidSchema.optional(),
    orderBy: z.enum(['name', 'createdAt']).default('name'),
    sort: sortSchema,
  })
  .strict();

export type CreateServiceBody = z.output<typeof createServiceBodySchema>;
export type UpdateServiceBody = z.output<typeof updateServiceBodySchema>;
export type ListServicesQuery = z.output<typeof listServicesQuerySchema>;
