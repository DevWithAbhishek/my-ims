import { z } from 'zod';

export const PATTERN_LABELS = ['FACTUAL', 'INFERENCE', 'UNKNOWN'] as const;

/** Bounds of a valid evaluation output (owner-approved with SLICE-12 §4.6). */
export const EVALUATION_LIMITS = {
  patternsMax: 30,
  textMax: 1000,
  evidenceIdsPerPatternMax: 50,
  limitationsMax: 1000,
} as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

/** A pattern's origin is the evidence it cites. Keys the model adds are dropped. */
const outputSchema = z.object({
  patterns: z
    .array(
      z.object({
        text: boundedText(EVALUATION_LIMITS.textMax),
        label: z.enum(PATTERN_LABELS),
        evidenceIds: z.array(z.uuid()).min(1).max(EVALUATION_LIMITS.evidenceIdsPerPatternMax),
      }),
    )
    .max(EVALUATION_LIMITS.patternsMax),
  limitations: boundedText(EVALUATION_LIMITS.limitationsMax).nullable(),
});

export type EvaluationResult = z.infer<typeof outputSchema>;

export type ParsedEvaluationOutput =
  { ok: true; value: EvaluationResult } | { ok: false; fields: string[] };

/**
 * Validates the model's text before anything is stored (SLICE-12 §4.6): structured, every pattern
 * labelled, and every cited id one of the evidence ids that were sent. Anything else is rejected.
 */
export function parseEvaluationOutput(
  text: string,
  sentEvidenceIds: ReadonlySet<string>,
): ParsedEvaluationOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return { ok: false, fields: ['*'] };
  }
  const result = outputSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      fields: [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '*'))],
    };
  }
  for (const pattern of result.data.patterns) {
    if (pattern.evidenceIds.some((id) => !sentEvidenceIds.has(id))) {
      return { ok: false, fields: ['patterns.evidenceIds'] };
    }
  }
  return { ok: true, value: result.data };
}
