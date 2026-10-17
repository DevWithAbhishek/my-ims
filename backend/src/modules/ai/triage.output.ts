import { z } from 'zod';
import { TRIAGE_LIMITS } from './triage.limits.js';

/** Trimmed, non-empty, bounded. `trim()` runs first so a blank string is empty and rejected. */
const boundedText = (max: number) => z.string().trim().min(1).max(max);

const evidenceSchema = z.object({
  type: boundedText(TRIAGE_LIMITS.evidenceTypeMax),
  reference: boundedText(TRIAGE_LIMITS.evidenceReferenceMax),
  excerpt: boundedText(TRIAGE_LIMITS.evidenceExcerptMax),
});

/**
 * The structured output of a triage call. Keys the model adds beyond these are dropped, so what is
 * stored (and later exposed) is exactly the validated form.
 */
const triageOutputSchema = z.object({
  category: boundedText(TRIAGE_LIMITS.categoryMax),
  suggestedSeverity: z.enum(['P0', 'P1', 'P2', 'P3']),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema).max(TRIAGE_LIMITS.evidenceItemsMax),
  summary: boundedText(TRIAGE_LIMITS.summaryMax),
  reasoning: boundedText(TRIAGE_LIMITS.reasoningMax),
});

export type TriageOutput = z.infer<typeof triageOutputSchema>;

export type ParsedTriageOutput =
  | { ok: true; value: TriageOutput; raw: unknown }
  | {
      ok: false;
      /** The parsed JSON, or the text itself when it is not JSON: kept only as `rawOutput`. */
      raw: unknown;
      /** Paths of the failing fields (never values), safe to log. */
      fields: string[];
    };

/**
 * Parses and strictly validates the model's text. Invalid output is never a valid suggestion:
 * the caller stores `raw` for diagnosis only and treats the attempt as a retryable failure.
 */
export function parseTriageOutput(text: string): ParsedTriageOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return { ok: false, raw: text, fields: ['*'] };
  }
  const result = triageOutputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data, raw };
  return {
    ok: false,
    raw,
    fields: [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '*'))],
  };
}
