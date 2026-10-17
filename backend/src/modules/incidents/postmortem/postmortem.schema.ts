import { z } from 'zod';

/** Bound of every postmortem text field (SLICE-11 §4.4, §4.5). */
export const POSTMORTEM_TEXT_MAX = 20_000;

/** Trimmed, non-empty, bounded; `trim()` runs first so a blank string is empty and rejected. */
const text = z.string().trim().min(1).max(POSTMORTEM_TEXT_MAX);
const riskLevel = z.enum(['P0', 'P1', 'P2', 'P3']);

/**
 * `UpdatePostmortemDto`: every field optional; which action it is (P2, P3, P4) follows from the
 * fields present (see `postmortem.dispatcher.ts`). `mttrMinutes`, `provenance` and `review` are
 * not editable, so they are unknown fields (`400`).
 */
export const updatePostmortemBodySchema = z
  .object({
    summary: text.optional(),
    impact: text.optional(),
    detection: text.optional(),
    timeline: text.optional(),
    rootCause: text.optional(),
    contributingFactors: text.optional(),
    resolution: text.optional(),
    correctiveActions: text.optional(),
    preventiveActions: text.optional(),
    unknowns: text.nullable().optional(),
    riskLevel: riskLevel.optional(),
    reviewStatus: z.literal('REVIEWED').optional(),
    generationStatus: z.literal('GENERATING').optional(),
  })
  .strict();

export type UpdatePostmortemBody = z.output<typeof updatePostmortemBodySchema>;

/** `CreatePostmortemDto` (P5): the whole content is required, `unknowns` may be absent or `null`. */
export const createPostmortemBodySchema = z
  .object({
    summary: text,
    impact: text,
    detection: text,
    timeline: text,
    rootCause: text,
    contributingFactors: text,
    resolution: text,
    correctiveActions: text,
    preventiveActions: text,
    unknowns: text.nullable().optional(),
    riskLevel,
  })
  .strict();

export type CreatePostmortemBody = z.output<typeof createPostmortemBodySchema>;
