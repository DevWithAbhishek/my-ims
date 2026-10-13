import { buildAiTriage, type TriageRecord } from './ai-triage.js';

const record = (overrides: Partial<TriageRecord> = {}): TriageRecord => ({
  failureStatus: 'SUCCESS',
  category: 'DATABASE',
  suggestedSeverity: 'P0',
  confidence: 0.87,
  evidence: [{ type: 'LOG', reference: 'log-1', excerpt: 'connection refused' }],
  reasoning: 'Connection pool exhausted',
  model: 'test-model',
  modelVersion: '1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const EMPTY = {
  category: null,
  suggestedSeverity: null,
  confidence: null,
  evidence: [],
  reasoningSummary: null,
  model: null,
  modelVersion: null,
  generatedAt: null,
};

describe('buildAiTriage', () => {
  it('is PENDING with all values null when there is no record', () => {
    expect(buildAiTriage(null)).toEqual({ status: 'PENDING', ...EMPTY });
  });

  it('is PENDING for a pending record even if fields are filled', () => {
    expect(buildAiTriage(record({ failureStatus: 'PENDING' }))).toEqual({
      status: 'PENDING',
      ...EMPTY,
    });
  });

  it('is UNAVAILABLE for a failed record even if fields are filled', () => {
    expect(buildAiTriage(record({ failureStatus: 'FAILED' }))).toEqual({
      status: 'UNAVAILABLE',
      ...EMPTY,
    });
  });

  it('is COMPLETED with the stored values for a successful record', () => {
    expect(buildAiTriage(record())).toEqual({
      status: 'COMPLETED',
      category: 'DATABASE',
      suggestedSeverity: 'P0',
      confidence: 0.87,
      evidence: [{ type: 'LOG', reference: 'log-1', excerpt: 'connection refused' }],
      reasoningSummary: 'Connection pool exhausted',
      model: 'test-model',
      modelVersion: '1',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('exposes only well-formed evidence items and only their three fields', () => {
    const result = buildAiTriage(
      record({
        evidence: [
          { type: 'LOG', reference: 'a', excerpt: 'b', rawModelOutput: 'secret' },
          { type: 'LOG', reference: 'a' },
          'text',
          null,
        ],
      }),
    );
    expect(result.evidence).toEqual([{ type: 'LOG', reference: 'a', excerpt: 'b' }]);
  });

  it('returns no evidence when the stored value is not an array', () => {
    expect(buildAiTriage(record({ evidence: { a: 1 } })).evidence).toEqual([]);
    expect(buildAiTriage(record({ evidence: null })).evidence).toEqual([]);
  });
});
