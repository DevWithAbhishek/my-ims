import { TRIAGE_LIMITS } from './triage.limits';
import { parseTriageOutput } from './triage.output';

const valid = {
  category: 'Database saturation',
  suggestedSeverity: 'P1',
  confidence: 0.82,
  evidence: [{ type: 'LABEL', reference: 'labels', excerpt: 'db=primary' }],
  summary: 'The primary database is saturated.',
  reasoning: 'Connection errors on the primary database affect checkout.',
};

const parse = (value: unknown) => parseTriageOutput(JSON.stringify(value));
const failedFields = (value: unknown): string[] => {
  const result = parse(value);
  if (result.ok) throw new Error('expected the output to be rejected');
  return result.fields;
};

describe('parseTriageOutput', () => {
  it('accepts a valid output and returns the validated structured form', () => {
    const result = parse(valid);
    expect(result).toEqual({ ok: true, value: valid, raw: valid });
  });

  it('accepts every severity, the confidence bounds and an empty evidence array', () => {
    for (const suggestedSeverity of ['P0', 'P1', 'P2', 'P3']) {
      expect(parse({ ...valid, suggestedSeverity }).ok).toBe(true);
    }
    expect(parse({ ...valid, confidence: 0 }).ok).toBe(true);
    expect(parse({ ...valid, confidence: 1 }).ok).toBe(true);
    expect(parse({ ...valid, evidence: [] }).ok).toBe(true);
  });

  it('trims strings and drops keys it does not know, at every level', () => {
    const result = parse({
      ...valid,
      category: '  Database saturation  ',
      extra: 'ignored',
      evidence: [{ type: ' LABEL ', reference: 'labels', excerpt: 'x', note: 'ignored' }],
    });
    expect(result.ok && result.value).toEqual({
      ...valid,
      evidence: [{ type: 'LABEL', reference: 'labels', excerpt: 'x' }],
    });
  });

  it.each(['P4', 'p1', 'CRITICAL', '', 1, null])('rejects the severity %p', (suggestedSeverity) => {
    expect(failedFields({ ...valid, suggestedSeverity })).toEqual(['suggestedSeverity']);
  });

  it.each([-0.01, 1.01, 2, '0.5', null])('rejects the confidence %p', (confidence) => {
    expect(failedFields({ ...valid, confidence })).toEqual(['confidence']);
  });

  it.each([undefined, '', '   ', 7, null])('rejects the category %p', (category) => {
    expect(failedFields({ ...valid, category })).toEqual(['category']);
  });

  it('rejects malformed evidence', () => {
    expect(failedFields({ ...valid, evidence: 'none' })).toEqual(['evidence']);
    expect(failedFields({ ...valid, evidence: undefined })).toEqual(['evidence']);
    expect(failedFields({ ...valid, evidence: [{ type: 'LABEL', reference: 'labels' }] })).toEqual([
      'evidence.0.excerpt',
    ]);
    expect(
      failedFields({ ...valid, evidence: [{ type: '', reference: 'labels', excerpt: 'x' }] }),
    ).toEqual(['evidence.0.type']);
    expect(failedFields({ ...valid, evidence: [null] })).toEqual(['evidence.0']);
  });

  it('rejects a missing or blank summary or reasoning', () => {
    expect(failedFields({ ...valid, summary: undefined })).toEqual(['summary']);
    expect(failedFields({ ...valid, reasoning: ' ' })).toEqual(['reasoning']);
  });

  it('enforces every bound (and accepts a value exactly at the bound)', () => {
    const text = (length: number) => 'x'.repeat(length);
    const item = (overrides: object) => ({
      type: 'T',
      reference: 'labels',
      excerpt: 'e',
      ...overrides,
    });
    const cases: [string, object, object][] = [
      ['category', { category: text(TRIAGE_LIMITS.categoryMax) }, { category: text(101) }],
      ['summary', { summary: text(TRIAGE_LIMITS.summaryMax) }, { summary: text(1001) }],
      ['reasoning', { reasoning: text(TRIAGE_LIMITS.reasoningMax) }, { reasoning: text(2001) }],
      [
        'evidence.0.type',
        { evidence: [item({ type: text(TRIAGE_LIMITS.evidenceTypeMax) })] },
        { evidence: [item({ type: text(65) })] },
      ],
      [
        'evidence.0.reference',
        { evidence: [item({ reference: text(TRIAGE_LIMITS.evidenceReferenceMax) })] },
        { evidence: [item({ reference: text(513) })] },
      ],
      [
        'evidence.0.excerpt',
        { evidence: [item({ excerpt: text(TRIAGE_LIMITS.evidenceExcerptMax) })] },
        { evidence: [item({ excerpt: text(1001) })] },
      ],
      [
        'evidence',
        { evidence: Array.from({ length: TRIAGE_LIMITS.evidenceItemsMax }, () => item({})) },
        { evidence: Array.from({ length: TRIAGE_LIMITS.evidenceItemsMax + 1 }, () => item({})) },
      ],
    ];
    for (const [field, atBound, overBound] of cases) {
      expect(parse({ ...valid, ...atBound }).ok).toBe(true);
      expect(failedFields({ ...valid, ...overBound })).toEqual([field]);
    }
  });

  it('rejects text that is not JSON, keeping the text as the raw output', () => {
    const result = parseTriageOutput('Sure! Here is the triage: {"category": ');
    expect(result).toEqual({
      ok: false,
      raw: 'Sure! Here is the triage: {"category": ',
      fields: ['*'],
    });
  });

  it('rejects JSON that is not an object, and markdown-fenced JSON', () => {
    expect(parseTriageOutput('[]').ok).toBe(false);
    expect(parseTriageOutput('null').ok).toBe(false);
    expect(parseTriageOutput('"text"').ok).toBe(false);
    expect(parseTriageOutput('```json\n' + JSON.stringify(valid) + '\n```').ok).toBe(false);
  });

  it('parses JSON surrounded by whitespace', () => {
    expect(parseTriageOutput(`\n  ${JSON.stringify(valid)}\n`).ok).toBe(true);
  });

  it('reports failing field paths only, never values', () => {
    const result = parse({
      ...valid,
      category: '',
      confidence: 9,
      summary: 'SECRET-VALUE'.repeat(100),
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.ok ? null : result.fields)).not.toContain('SECRET');
  });
});
