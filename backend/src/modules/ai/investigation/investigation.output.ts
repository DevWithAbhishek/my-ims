import { z } from 'zod';
import type { EvidenceCandidate, SourceType } from './investigation.candidates.js';
import { EVIDENCE_TYPES, INVESTIGATION_LIMITS, SOURCE_TYPES } from './investigation.limits.js';

const boundedText = (max: number) => z.string().trim().min(1).max(max);

const evidenceIds = z.array(z.uuid()).min(1).max(INVESTIGATION_LIMITS.evidenceIdsPerItemMax);

const citedItem = z.object({
  text: boundedText(INVESTIGATION_LIMITS.itemTextMax),
  evidenceIds,
});

const briefSchema = z.object({
  summary: boundedText(INVESTIGATION_LIMITS.summaryMax),
  findings: z.array(citedItem).max(INVESTIGATION_LIMITS.findingsMax),
  possibleAreas: z.array(citedItem).max(INVESTIGATION_LIMITS.possibleAreasMax),
  suggestedSteps: z
    .array(z.object({ text: boundedText(INVESTIGATION_LIMITS.itemTextMax) }))
    .max(INVESTIGATION_LIMITS.suggestedStepsMax),
  limitations: boundedText(INVESTIGATION_LIMITS.limitationsMax).nullable(),
});

/** Keys the model adds beyond these are dropped, so what is stored is exactly the validated form. */
const outputSchema = z.object({
  evidence: z
    .array(
      z.object({
        id: z.uuid(),
        evidenceType: z.enum(EVIDENCE_TYPES),
        sourceType: z.enum(SOURCE_TYPES),
        relevance: boundedText(INVESTIGATION_LIMITS.relevanceMax),
      }),
    )
    .min(1),
  brief: briefSchema,
});

export type InvestigationBrief = z.infer<typeof briefSchema>;

/** One evidence record to store: the model's judgement plus the origin taken from the candidate. */
export type ValidatedEvidence = {
  id: string;
  evidenceType: (typeof EVIDENCE_TYPES)[number];
  sourceType: SourceType;
  sourceReference: string;
  incidentId: string;
  relevance: string;
};

export type ParsedInvestigationOutput =
  | { ok: true; evidence: ValidatedEvidence[]; brief: InvestigationBrief }
  | {
      ok: false;
      /** Paths of the failing fields (never values), safe to log. */
      fields: string[];
    };

const fail = (...fields: string[]): ParsedInvestigationOutput => ({ ok: false, fields });

/**
 * Parses and validates the model's text against the candidates it was given (SLICE-12 §4.3 step 5).
 * Any violation makes the whole output invalid: unknown or repeated evidence ids, an origin that
 * does not match the candidate, a finding without a `FACT` among its evidence, a citation of an id
 * that is not in the evidence list.
 */
export function parseInvestigationOutput(
  text: string,
  candidates: readonly EvidenceCandidate[],
): ParsedInvestigationOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return fail('*');
  }
  const result = outputSchema.safeParse(raw);
  if (!result.success) {
    return fail(...new Set(result.error.issues.map((issue) => issue.path.join('.') || '*')));
  }

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const listed = new Map<string, ValidatedEvidence>();
  for (const item of result.data.evidence) {
    const candidate = byId.get(item.id);
    if (!candidate) return fail('evidence.id');
    if (listed.has(item.id)) return fail('evidence.id');
    if (item.sourceType !== candidate.sourceType) return fail('evidence.sourceType');
    listed.set(item.id, {
      id: item.id,
      evidenceType: item.evidenceType,
      sourceType: candidate.sourceType,
      sourceReference: candidate.sourceReference,
      incidentId: candidate.incidentId,
      relevance: item.relevance,
    });
  }

  const { brief } = result.data;
  for (const finding of brief.findings) {
    const cited = finding.evidenceIds.map((id) => listed.get(id));
    if (cited.some((entry) => entry === undefined)) return fail('brief.findings.evidenceIds');
    if (!cited.some((entry) => entry?.evidenceType === 'FACT')) {
      return fail('brief.findings.evidenceIds');
    }
  }
  for (const area of brief.possibleAreas) {
    if (area.evidenceIds.some((id) => !listed.has(id)))
      return fail('brief.possibleAreas.evidenceIds');
  }

  return { ok: true, evidence: [...listed.values()], brief };
}
