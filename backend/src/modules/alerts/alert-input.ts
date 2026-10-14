import { z } from 'zod';

/** `key=value`: a non-empty key, then `=`, then anything. */
const LABEL = /^[^=]+=/;

const isoDateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/**
 * `CommonAlertInputDto`, the wire format of a `GENERIC` source. Unknown fields are tolerated (the
 * element is stored verbatim as `originalPayload`); an optional field is absent, not `null`.
 */
const commonAlertInputSchema = z
  .object({
    sourceEventId: z.string().min(1).max(200).optional(),
    sourceFingerprint: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    serviceId: z.uuid().transform((value) => value.toLowerCase()),
    environment: z.string().min(1).max(100),
    sourceSeverity: z.string().max(50).optional(),
    summary: z.string().min(1).max(500).optional(),
    description: z.string().max(10_000).optional(),
    labels: z.array(z.string().max(200).regex(LABEL)).max(50).optional(),
    additionalDetails: z.string().max(10_000).optional(),
    status: z.enum(['FIRING', 'RESOLVED']).default('FIRING'),
    startedAt: isoDateTime,
    endedAt: isoDateTime.optional(),
    sourceUrl: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .optional(),
  })
  .refine((alert) => alert.endedAt === undefined || alert.endedAt >= alert.startedAt, {
    path: ['endedAt'],
    message: 'endedAt must not be before startedAt',
  });

/** A validated alert; every absent optional field is `null`. */
export type NormalizedAlert = {
  sourceEventId: string | null;
  sourceFingerprint: string | null;
  name: string | null;
  serviceId: string;
  environment: string;
  sourceSeverity: string | null;
  summary: string | null;
  description: string | null;
  labels: string[];
  additionalDetails: string | null;
  status: 'FIRING' | 'RESOLVED';
  startedAt: Date;
  endedAt: Date | null;
  sourceUrl: string | null;
};

export type NormalizeResult =
  { ok: true; alert: NormalizedAlert } | { ok: false; fields: string[] };

/** PostgreSQL text and `jsonb` cannot store NUL; such an alert is invalid, not a server error. */
function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (Array.isArray(value)) return value.some(containsNul);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, inner]) => key.includes('\0') || containsNul(inner));
  }
  return false;
}

/** Validates one element of the request's `alerts` array. Failures name fields, never values. */
export function normalizeAlert(item: unknown): NormalizeResult {
  if (containsNul(item)) return { ok: false, fields: ['(payload)'] };

  const parsed = commonAlertInputSchema.safeParse(item);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(alert)'))];
    return { ok: false, fields };
  }
  const data = parsed.data;
  return {
    ok: true,
    alert: {
      sourceEventId: data.sourceEventId ?? null,
      sourceFingerprint: data.sourceFingerprint ?? null,
      name: data.name ?? null,
      serviceId: data.serviceId,
      environment: data.environment,
      sourceSeverity: data.sourceSeverity ?? null,
      summary: data.summary ?? null,
      description: data.description ?? null,
      labels: data.labels ?? [],
      additionalDetails: data.additionalDetails ?? null,
      status: data.status,
      startedAt: data.startedAt,
      endedAt: data.endedAt ?? null,
      sourceUrl: data.sourceUrl ?? null,
    },
  };
}
