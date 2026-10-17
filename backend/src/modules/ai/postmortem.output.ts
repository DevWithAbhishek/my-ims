import { z } from 'zod';
import { POSTMORTEM_TEXT_MAX } from './postmortem.limits.js';

/** Trimmed, non-empty, bounded. `trim()` runs first so a blank string is empty and rejected. */
const text = z.string().trim().min(1).max(POSTMORTEM_TEXT_MAX);

/**
 * The structured output of a postmortem generation. Keys the model adds beyond these are dropped,
 * so what is stored (and later exposed) is exactly the validated form.
 */
const postmortemOutputSchema = z.object({
  summary: text,
  impact: text,
  detection: text,
  timeline: text,
  rootCause: text,
  contributingFactors: text,
  resolution: text,
  correctiveActions: text,
  preventiveActions: text,
  unknowns: text.nullable(),
  riskLevel: z.enum(['P0', 'P1', 'P2', 'P3']),
});

export type PostmortemOutput = z.infer<typeof postmortemOutputSchema>;

export type ParsedPostmortemOutput =
  | { ok: true; value: PostmortemOutput }
  /** `fields` are the paths of the failing fields (never values), safe to log. */
  | { ok: false; fields: string[] };

/** Parses and strictly validates the model's text. Invalid output is never stored anywhere. */
export function parsePostmortemOutput(text: string): ParsedPostmortemOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return { ok: false, fields: ['*'] };
  }
  const result = postmortemOutputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    fields: [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '*'))],
  };
}
