/** Bounds of a valid investigation output (SLICE-12 §4.3 step 5; owner-approved). */
export const INVESTIGATION_LIMITS = {
  relevanceMax: 500,
  summaryMax: 2000,
  itemTextMax: 1000,
  findingsMax: 20,
  possibleAreasMax: 20,
  suggestedStepsMax: 20,
  evidenceIdsPerItemMax: 25,
  limitationsMax: 1000,
} as const;

export const EVIDENCE_TYPES = ['FACT', 'INFERENCE', 'UNKNOWN'] as const;
export const SOURCE_TYPES = ['INCIDENT', 'POSTMORTEM'] as const;
