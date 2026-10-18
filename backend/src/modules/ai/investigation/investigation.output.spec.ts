import type { EvidenceCandidate } from './investigation.candidates';
import { parseInvestigationOutput } from './investigation.output';

const A = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f01';
const B = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f02';
const UNKNOWN_ID = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f99';

const candidates: EvidenceCandidate[] = [
  { id: A, sourceType: 'INCIDENT', sourceReference: 'inc-1', incidentId: 'inc-1', fields: {} },
  { id: B, sourceType: 'POSTMORTEM', sourceReference: 'inc-2', incidentId: 'inc-2', fields: {} },
];

const valid = () => ({
  evidence: [
    { id: A, evidenceType: 'FACT', sourceType: 'INCIDENT', relevance: 'the incident' },
    { id: B, evidenceType: 'INFERENCE', sourceType: 'POSTMORTEM', relevance: 'similar cause' },
  ],
  brief: {
    summary: 'Looks like the database.',
    findings: [{ text: 'The DB is down.', evidenceIds: [A] }],
    possibleAreas: [{ text: 'Connection pool', evidenceIds: [B] }],
    suggestedSteps: [{ text: 'Check the pool' }],
    limitations: null,
  },
});

const parse = (value: unknown) => parseInvestigationOutput(JSON.stringify(value), candidates);

describe('parseInvestigationOutput', () => {
  it('accepts a valid output and takes the origin from the candidates', () => {
    const result = parse(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toEqual([
      expect.objectContaining({ id: A, sourceType: 'INCIDENT', sourceReference: 'inc-1' }),
      expect.objectContaining({ id: B, sourceType: 'POSTMORTEM', sourceReference: 'inc-2' }),
    ]);
    expect(result.brief.findings).toHaveLength(1);
  });

  it('drops keys the model adds', () => {
    const output = { ...valid(), extra: 1 };
    output.brief = { ...output.brief, chainOfThought: 'x' } as typeof output.brief;
    const result = parse(output);
    expect(result.ok && Object.keys(result.brief)).not.toContain('chainOfThought');
  });

  it('rejects text that is not JSON', () => {
    expect(parseInvestigationOutput('not json', candidates)).toEqual({ ok: false, fields: ['*'] });
  });

  it('rejects an evidence id that is not a candidate, and a repeated one', () => {
    const unknown = valid();
    unknown.evidence[1].id = UNKNOWN_ID;
    expect(parse(unknown).ok).toBe(false);
    const repeated = valid();
    repeated.evidence[1].id = A;
    expect(parse(repeated).ok).toBe(false);
  });

  it('requires at least one evidence record', () => {
    const output = valid();
    output.evidence = [];
    expect(parse(output).ok).toBe(false);
  });

  it('rejects a missing or mismatching origin type', () => {
    const wrong = valid();
    wrong.evidence[0].sourceType = 'POSTMORTEM';
    expect(parse(wrong).ok).toBe(false);
    const missing = valid() as { evidence: Record<string, unknown>[] };
    delete missing.evidence[0].sourceType;
    expect(parse(missing).ok).toBe(false);
  });

  it('requires every finding to cite a FACT evidence id', () => {
    const output = valid();
    output.brief.findings = [{ text: 'Guess', evidenceIds: [B] }];
    expect(parse(output).ok).toBe(false);
    output.brief.findings = [{ text: 'Mixed', evidenceIds: [B, A] }];
    expect(parse(output).ok).toBe(true);
  });

  it('rejects a finding or area that cites an id outside the evidence list, or cites none', () => {
    const finding = valid();
    finding.brief.findings = [{ text: 'x', evidenceIds: [UNKNOWN_ID] }];
    expect(parse(finding).ok).toBe(false);
    const area = valid();
    area.brief.possibleAreas = [{ text: 'x', evidenceIds: [UNKNOWN_ID] }];
    expect(parse(area).ok).toBe(false);
    const none = valid();
    none.brief.possibleAreas = [{ text: 'x', evidenceIds: [] }];
    expect(parse(none).ok).toBe(false);
  });

  it('rejects blank texts, a missing relevance and an invalid evidence type', () => {
    const blank = valid();
    blank.brief.summary = '   ';
    expect(parse(blank).ok).toBe(false);
    const relevance = valid() as { evidence: Record<string, unknown>[] };
    delete relevance.evidence[0].relevance;
    expect(parse(relevance).ok).toBe(false);
    const type = valid();
    type.evidence[0].evidenceType = 'GUESS';
    expect(parse(type).ok).toBe(false);
  });

  it('allows empty findings, areas and steps and a limitations text', () => {
    const output = valid();
    output.brief.findings = [];
    output.brief.possibleAreas = [];
    output.brief.suggestedSteps = [];
    (output.brief as { limitations: string | null }).limitations = 'Little history.';
    expect(parse(output).ok).toBe(true);
  });
});
