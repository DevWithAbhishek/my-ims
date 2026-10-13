import type { LifecycleStates } from '../../generated/prisma/enums.js';
import type { AiTriage, AiTriageEvidence, Severity } from './incidents.types.js';

/** The stored triage fields the API may expose. The internal `summary` and raw output are never read. */
export type TriageRecord = {
  failureStatus: LifecycleStates;
  category: string | null;
  suggestedSeverity: Severity | null;
  confidence: number | null;
  evidence: unknown;
  reasoning: string | null;
  model: string | null;
  modelVersion: string | null;
  createdAt: Date;
};

const EMPTY: Omit<AiTriage, 'status'> = {
  category: null,
  suggestedSeverity: null,
  confidence: null,
  evidence: [],
  reasoningSummary: null,
  model: null,
  modelVersion: null,
  generatedAt: null,
};

/** Keeps only well-formed `{ type, reference, excerpt }` items, copying exactly those three fields. */
function toEvidence(stored: unknown): AiTriageEvidence[] {
  if (!Array.isArray(stored)) return [];
  const items: AiTriageEvidence[] = [];
  for (const item of stored as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { type, reference, excerpt } = item as Record<string, unknown>;
    if (typeof type === 'string' && typeof reference === 'string' && typeof excerpt === 'string') {
      items.push({ type, reference, excerpt });
    }
  }
  return items;
}

/**
 * Derives the advisory triage block from the latest accepted alert's record: no record or a
 * pending record → `PENDING`; `SUCCESS` → `COMPLETED`; `FAILED` → `UNAVAILABLE`. While `PENDING`
 * or `UNAVAILABLE` every value is `null` and `evidence` is empty.
 */
export function buildAiTriage(record: TriageRecord | null): AiTriage {
  if (record === null || record.failureStatus === 'PENDING') return { status: 'PENDING', ...EMPTY };
  if (record.failureStatus === 'FAILED') return { status: 'UNAVAILABLE', ...EMPTY };
  return {
    status: 'COMPLETED',
    category: record.category,
    suggestedSeverity: record.suggestedSeverity,
    confidence: record.confidence,
    evidence: toEvidence(record.evidence),
    reasoningSummary: record.reasoning,
    model: record.model,
    modelVersion: record.modelVersion,
    generatedAt: record.createdAt.toISOString(),
  };
}
