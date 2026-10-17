/** Bounds of a valid triage output (SLICE-10 §4.4 "bounded non-empty strings"; owner-approved). */
export const TRIAGE_LIMITS = {
  categoryMax: 100,
  evidenceItemsMax: 10,
  evidenceTypeMax: 64,
  evidenceReferenceMax: 512,
  evidenceExcerptMax: 1000,
  summaryMax: 1000,
  reasoningMax: 2000,
} as const;
