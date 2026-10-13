import { z } from 'zod';
import { ORDER_BY_VALUES } from './cursor.js';
import { limitSchema, offsetSchema, sortSchema, uuidSchema } from './incidents.common.js';

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const;

/** `a,b,c` → `['a','b','c']`, each one of `values`; duplicates collapse. */
function commaList<const V extends readonly [string, ...string[]]>(values: V) {
  return z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(values)).min(1))
    .transform((items) => [...new Set(items)]);
}

export const incidentParamsSchema = z.object({ incidentId: uuidSchema }).strict();

export const listIncidentsQuerySchema = z
  .object({
    limit: limitSchema,
    cursor: z.string().optional(),
    status: commaList(STATUSES).optional(),
    severity: commaList(SEVERITIES).optional(),
    serviceId: uuidSchema.optional(),
    assigneeId: uuidSchema.optional(),
    orderBy: z.enum(ORDER_BY_VALUES).default('severity'),
    sort: sortSchema.default('asc'),
  })
  .strict();

export const timelineQuerySchema = z
  .object({
    limit: limitSchema,
    offset: offsetSchema,
    orderBy: z.literal('createdAt').default('createdAt'),
    sort: sortSchema.default('asc'),
  })
  .strict();

export type ListIncidentsQuery = z.output<typeof listIncidentsQuerySchema>;
export type TimelineQuery = z.output<typeof timelineQuerySchema>;
