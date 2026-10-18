import {
  buildCandidates,
  projectInvestigationInput,
  type IncidentSource,
  type PostmortemSource,
} from './investigation.candidates';

const incident: IncidentSource = { incidentId: 'inc-1', description: 'db down', severity: 'P1' };
const postmortem = (n: number): PostmortemSource => ({
  incidentId: `inc-pm-${n}`,
  summary: `s${n}`,
  impact: `i${n}`,
  rootCause: null,
  factors: `f${n}`,
  resolution: `r${n}`,
});

describe('buildCandidates', () => {
  it('puts the incident first, then the postmortems in order, each with a generated id', () => {
    let n = 0;
    const candidates = buildCandidates(incident, [postmortem(1), postmortem(2)], () => `id-${++n}`);
    expect(candidates.map((c) => [c.id, c.sourceType, c.sourceReference])).toEqual([
      ['id-1', 'INCIDENT', 'inc-1'],
      ['id-2', 'POSTMORTEM', 'inc-pm-1'],
      ['id-3', 'POSTMORTEM', 'inc-pm-2'],
    ]);
  });

  it('always has the incident as a source, even without postmortems', () => {
    expect(buildCandidates(incident, [])).toHaveLength(1);
  });
});

describe('projectInvestigationInput (the data allow-list)', () => {
  it('sends exactly the allow-listed fields plus the generated id, and nothing else', () => {
    const polluted = {
      ...postmortem(1),
      prompt: 'secret',
      inputData: 'raw',
      reviewedById: 'u1',
    } as PostmortemSource;
    const candidates = buildCandidates(
      { ...incident, teamId: 't', title: 'x' } as IncidentSource,
      [polluted],
      (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    );
    const input = projectInvestigationInput(candidates);
    expect(Object.keys(input)).toEqual(['evidence']);
    const [incidentRecord, postmortemRecord] = input.evidence.map((e) => JSON.parse(e));
    expect(incidentRecord).toEqual({ id: 'id-1', description: 'db down', severity: 'P1' });
    expect(Object.keys(postmortemRecord).sort()).toEqual(
      ['factors', 'id', 'impact', 'incidentId', 'resolution', 'rootCause', 'summary'].sort(),
    );
    expect(JSON.stringify(input)).not.toMatch(/secret|raw|teamId|title|inc-1/);
  });
});
