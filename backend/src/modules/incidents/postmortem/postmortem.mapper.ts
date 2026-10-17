import { toUserSummary } from '../incident.mapper.js';
import type { PostmortemRow } from './postmortem.repository.js';
import { deriveAiGenerated } from './postmortem.rules.js';
import type { PostmortemFailureReason, PostmortemResponse } from './postmortem.types.js';

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** Maps the columns to the API names (`factors → contributingFactors`, `MTTR → mttrMinutes`). */
export function toPostmortemResponse(row: PostmortemRow): PostmortemResponse {
  const reviewer = toUserSummary(row.reviewedBy);
  return {
    id: row.id,
    incidentId: row.incidentId,
    generationStatus: row.generationStatus,
    reviewStatus: row.reviewStatus,
    aiGenerated: deriveAiGenerated(row),
    summary: row.summary,
    impact: row.impact,
    detection: row.detection,
    timeline: row.timeline,
    rootCause: row.rootCause,
    contributingFactors: row.factors,
    resolution: row.resolution,
    correctiveActions: row.correctiveActions,
    preventiveActions: row.preventiveActions,
    unknowns: row.unknowns,
    mttrMinutes: row.MTTR,
    riskLevel: row.riskLevel,
    provenance: {
      model: row.model,
      modelVersion: row.modelVersion,
      generatedAt: iso(row.generatedAt),
    },
    review:
      reviewer !== null && row.reviewedAt !== null
        ? { reviewedBy: reviewer, reviewedAt: row.reviewedAt.toISOString() }
        : null,
    failureReason: row.failureReason as PostmortemFailureReason | null,
  };
}
