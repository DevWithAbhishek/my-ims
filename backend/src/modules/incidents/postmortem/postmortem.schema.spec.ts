import { parseOrThrow } from '../../../shared/errors/zod.js';
import { createPostmortemBodySchema } from './postmortem.schema.js';

const valid = {
  summary: 's',
  impact: 'i',
  detection: 'd',
  timeline: 't',
  rootCause: 'r',
  contributingFactors: 'c',
  resolution: 'x',
  correctiveActions: 'a',
  preventiveActions: 'p',
  riskLevel: 'P2',
};

describe('CreatePostmortemDto', () => {
  it('accepts the whole content without unknowns, with null and with a string', () => {
    expect(parseOrThrow(createPostmortemBodySchema, valid).unknowns).toBeUndefined();
    expect(
      parseOrThrow(createPostmortemBodySchema, { ...valid, unknowns: null }).unknowns,
    ).toBeNull();
    expect(parseOrThrow(createPostmortemBodySchema, { ...valid, unknowns: 'u' }).unknowns).toBe(
      'u',
    );
  });

  it.each(Object.keys(valid))('requires %s (422)', (field) => {
    const body: Record<string, unknown> = { ...valid };
    delete body[field];
    expect(() => parseOrThrow(createPostmortemBodySchema, body)).toThrow(
      expect.objectContaining({ statusCode: 422 }),
    );
  });

  it('rejects unknown fields with 400, and a bad riskLevel or an over-long text with 422', () => {
    expect(() => parseOrThrow(createPostmortemBodySchema, { ...valid, mttrMinutes: 1 })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => parseOrThrow(createPostmortemBodySchema, { ...valid, riskLevel: 'P9' })).toThrow(
      expect.objectContaining({ statusCode: 422 }),
    );
    expect(() =>
      parseOrThrow(createPostmortemBodySchema, { ...valid, summary: 'x'.repeat(20_001) }),
    ).toThrow(expect.objectContaining({ statusCode: 422 }));
  });
});
