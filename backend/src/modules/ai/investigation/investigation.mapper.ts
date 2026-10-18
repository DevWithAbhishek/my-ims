import type { InvestigationBrief } from './investigation.output.js';
import type { InvestigationDetailRow, InvestigationListRow } from './investigation.repository.js';
import type { InvestigationResponse } from './investigation.types.js';

type Row = InvestigationListRow & Partial<Pick<InvestigationDetailRow, 'result' | 'evidences'>>;

/**
 * The brief and the evidence are exposed only for a `COMPLETED` investigation (and only when the
 * row was read with them: list items never carry them). DB names map to API names here
 * (`relevanceInfo` → `relevance`).
 */
export function toInvestigationResponse(row: Row): InvestigationResponse {
  const completed = row.status === 'COMPLETED';
  return {
    id: row.id,
    incidentId: row.incidentId,
    status: row.status,
    requestedBy: { id: row.requestedBy.id, name: row.requestedBy.name },
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    brief: completed && row.result != null ? (row.result as unknown as InvestigationBrief) : null,
    evidence: completed
      ? (row.evidences ?? []).map((item) => ({
          id: item.id,
          evidenceType: item.evidenceType,
          sourceType: item.sourceType,
          sourceReference: item.sourceReference,
          relevance: item.relevanceInfo,
        }))
      : [],
    failureReason: row.failureReason,
    provenance: { model: row.model, modelVersion: row.modelVersion },
  };
}
