import { randomUUID } from 'node:crypto';

export type SourceType = 'INCIDENT' | 'POSTMORTEM';

/** The only incident fields investigation reads: `description` and `severity` (SLICE-12 §4.3). */
export type IncidentSource = {
  incidentId: string;
  description: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
};

/** The only postmortem fields investigation reads, and the incident it belongs to. */
export type PostmortemSource = {
  incidentId: string;
  summary: string | null;
  impact: string | null;
  rootCause: string | null;
  factors: string | null;
  resolution: string | null;
};

/**
 * One piece of candidate evidence: the incident record or a retrieved postmortem. `id` is generated
 * here and is the only handle the model has. `sourceType` and `sourceReference` (the incident the
 * record comes from) are set from the source, never taken from the model.
 */
export type EvidenceCandidate = {
  id: string;
  sourceType: SourceType;
  sourceReference: string;
  incidentId: string;
  /** Exactly the allow-listed fields of the record. */
  fields: Readonly<Record<string, string | null>>;
};

/** The incident itself is always the first candidate, then the postmortems in the order given. */
export function buildCandidates(
  incident: IncidentSource,
  postmortems: readonly PostmortemSource[],
  newId: () => string = randomUUID,
): EvidenceCandidate[] {
  return [
    {
      id: newId(),
      sourceType: 'INCIDENT',
      sourceReference: incident.incidentId,
      incidentId: incident.incidentId,
      fields: { description: incident.description, severity: incident.severity },
    },
    ...postmortems.map((postmortem): EvidenceCandidate => ({
      id: newId(),
      sourceType: 'POSTMORTEM',
      sourceReference: postmortem.incidentId,
      incidentId: postmortem.incidentId,
      fields: {
        summary: postmortem.summary,
        impact: postmortem.impact,
        rootCause: postmortem.rootCause,
        factors: postmortem.factors,
        resolution: postmortem.resolution,
        incidentId: postmortem.incidentId,
      },
    })),
  ];
}

/**
 * What leaves the system, as the flat record the provider contract requires: one JSON string per
 * candidate holding its generated `id` and exactly its allow-listed fields. The incident's own id,
 * team, service, users and every other field never appear.
 */
export type InvestigationInput = { evidence: string[] };

export function projectInvestigationInput(
  candidates: readonly EvidenceCandidate[],
): InvestigationInput {
  return {
    evidence: candidates.map((candidate) =>
      JSON.stringify({ id: candidate.id, ...candidate.fields }),
    ),
  };
}
