import { z } from 'zod';
import { uuidSchema } from '../incidents.common.js';

const commentSchema = z
  .object({
    title: z.string().max(200).optional(),
    body: z.string().trim().min(1).max(10_000),
  })
  .strict();

/** `UpdateIncidentDto`: every field optional; which action it is follows from the fields present. */
export const updateIncidentBodySchema = z
  .object({
    status: z.enum(['ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'OPEN']).optional(),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    currentAssignee: uuidSchema.nullable().optional(),
    resolutionSummary: z.string().trim().min(1).max(10_000).optional(),
    serviceConfirmedWorking: z.boolean().optional(),
    comment: commentSchema.optional(),
  })
  .strict();

export type UpdateIncidentBody = z.output<typeof updateIncidentBodySchema>;
