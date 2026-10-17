import { parsePostmortemOutput } from './postmortem.output.js';

const VALID = {
  summary: 's',
  impact: 'i',
  detection: 'd',
  timeline: 't',
  rootCause: 'r',
  contributingFactors: 'c',
  resolution: 'x',
  correctiveActions: 'a',
  preventiveActions: 'p',
  unknowns: null,
  riskLevel: 'P2',
};
const parse = (value: unknown) => parsePostmortemOutput(JSON.stringify(value));

describe('parsePostmortemOutput', () => {
  it('accepts a valid output with unknowns null or a string', () => {
    expect(parse(VALID)).toEqual({ ok: true, value: VALID });
    expect(parse({ ...VALID, unknowns: 'u' })).toMatchObject({ ok: true });
  });

  it('accepts texts of exactly 20,000 characters and trims them', () => {
    expect(parse({ ...VALID, summary: 'x'.repeat(20_000) })).toMatchObject({ ok: true });
    expect(parse({ ...VALID, summary: '  padded ' })).toMatchObject({
      ok: true,
      value: { summary: 'padded' },
    });
  });

  it('drops keys beyond the schema', () => {
    const result = parse({ ...VALID, extra: 'x' });
    expect(result.ok && 'extra' in result.value).toBe(false);
  });

  it.each([
    'summary',
    'impact',
    'detection',
    'timeline',
    'rootCause',
    'contributingFactors',
    'resolution',
    'correctiveActions',
    'preventiveActions',
  ])('rejects a missing, empty, blank, non-string or over-long %s', (field) => {
    for (const bad of [undefined, '', '   ', 5, null, 'x'.repeat(20_001)]) {
      const value: Record<string, unknown> = { ...VALID, [field]: bad };
      if (bad === undefined) delete value[field];
      expect(parse(value)).toEqual({ ok: false, fields: [field] });
    }
  });

  it.each([undefined, '', 5, 'x'.repeat(20_001)])('rejects unknowns %j', (bad) => {
    const value: Record<string, unknown> = { ...VALID, unknowns: bad };
    if (bad === undefined) delete value.unknowns;
    expect(parse(value)).toEqual({ ok: false, fields: ['unknowns'] });
  });

  it.each(['P4', 'p1', '', null, 1])('rejects riskLevel %j', (bad) => {
    expect(parse({ ...VALID, riskLevel: bad })).toEqual({ ok: false, fields: ['riskLevel'] });
  });

  it('rejects text that is not JSON, and JSON that is not an object', () => {
    expect(parsePostmortemOutput('not json')).toEqual({ ok: false, fields: ['*'] });
    expect(parse([1])).toMatchObject({ ok: false });
    expect(parse('text')).toMatchObject({ ok: false });
  });

  it('reports field names only, never values', () => {
    const result = parse({ ...VALID, summary: 'SECRET-VALUE'.repeat(5000) });
    expect(JSON.stringify(result)).not.toContain('SECRET-VALUE');
  });
});
