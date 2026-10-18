import { parseEvaluationOutput } from './evaluation.output';

const A = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f01';
const B = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f02';
const sent = new Set([A]);

const parse = (value: unknown, ids = sent) => parseEvaluationOutput(JSON.stringify(value), ids);
const valid = () => ({
  patterns: [{ text: 'Pool exhaustion recurs', label: 'INFERENCE', evidenceIds: [A] }],
  limitations: null,
});

describe('parseEvaluationOutput', () => {
  it('accepts a structured output whose patterns cite sent evidence', () => {
    const result = parse(valid());
    expect(result.ok && result.value.patterns).toHaveLength(1);
  });

  it('accepts no patterns at all', () => {
    expect(parse({ patterns: [], limitations: 'Too little evidence.' }).ok).toBe(true);
  });

  it('rejects non-JSON text and a missing structure', () => {
    expect(parseEvaluationOutput('nope', sent).ok).toBe(false);
    expect(parse({ limitations: null }).ok).toBe(false);
  });

  it('rejects a pattern citing evidence that was not sent, or citing nothing', () => {
    const unsupported = valid();
    unsupported.patterns[0].evidenceIds = [B];
    expect(parse(unsupported).ok).toBe(false);
    const none = valid();
    none.patterns[0].evidenceIds = [];
    expect(parse(none).ok).toBe(false);
  });

  it('rejects an unlabelled pattern or an unknown label', () => {
    const missing = valid() as { patterns: Record<string, unknown>[] };
    delete missing.patterns[0].label;
    expect(parse(missing).ok).toBe(false);
    const wrong = valid();
    wrong.patterns[0].label = 'GUESS';
    expect(parse(wrong).ok).toBe(false);
  });
});
