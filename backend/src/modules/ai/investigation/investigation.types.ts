import type { InvestigationBrief } from './investigation.output.js';

export type UserSummary = { id: string; name: string };

export type EvidenceItem = {
  id: string;
  evidenceType: 'FACT' | 'INFERENCE' | 'UNKNOWN';
  sourceType: string | null;
  sourceReference: string | null;
  relevance: string | null;
};

/** `InvestigationResponse` (SLICE-12 §5). Never carries prompts, retrieved data, `input` or the key. */
export type InvestigationResponse = {
  id: string;
  incidentId: string;
  status: 'REQUESTED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  requestedBy: UserSummary;
  createdAt: string;
  completedAt: string | null;
  brief: InvestigationBrief | null;
  evidence: EvidenceItem[];
  failureReason: string | null;
  provenance: { model: string | null; modelVersion: string | null };
};
