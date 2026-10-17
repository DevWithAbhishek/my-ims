import { toPostmortemResponse } from './postmortem.mapper.js';
import type { PostmortemRow } from './postmortem.repository.js';

const base: PostmortemRow = {
  id: 'id',
  incidentId: 'incident',
  generationStatus: 'GENERATING',
  reviewStatus: 'PENDING',
  summary: null,
  impact: null,
  detection: null,
  timeline: null,
  rootCause: null,
  factors: null,
  resolution: null,
  correctiveActions: null,
  preventiveActions: null,
  unknowns: null,
  MTTR: null,
  riskLevel: null,
  model: null,
  modelVersion: null,
  generatedAt: null,
  reviewedAt: null,
  failureReason: null,
  reviewedBy: null,
};

describe('toPostmortemResponse', () => {
  it('maps a generating postmortem: null content, aiGenerated, no review', () => {
    expect(toPostmortemResponse(base)).toEqual({
      id: 'id',
      incidentId: 'incident',
      generationStatus: 'GENERATING',
      reviewStatus: 'PENDING',
      aiGenerated: true,
      summary: null,
      impact: null,
      detection: null,
      timeline: null,
      rootCause: null,
      contributingFactors: null,
      resolution: null,
      correctiveActions: null,
      preventiveActions: null,
      unknowns: null,
      mttrMinutes: null,
      riskLevel: null,
      provenance: { model: null, modelVersion: null, generatedAt: null },
      review: null,
      failureReason: null,
    });
  });

  it('maps API names, provenance and the review of an approved AI draft', () => {
    const generatedAt = new Date('2026-10-17T10:00:00.000Z');
    const reviewedAt = new Date('2026-10-17T11:00:00.000Z');
    const response = toPostmortemResponse({
      ...base,
      generationStatus: 'DRAFT',
      reviewStatus: 'REVIEWED',
      factors: 'the factors',
      MTTR: 42,
      riskLevel: 'P1',
      model: 'm',
      modelVersion: 'm-1',
      generatedAt,
      reviewedAt,
      reviewedBy: { id: 'u', name: 'Una' },
    });
    expect(response).toMatchObject({
      aiGenerated: true,
      contributingFactors: 'the factors',
      mttrMinutes: 42,
      riskLevel: 'P1',
      provenance: { model: 'm', modelVersion: 'm-1', generatedAt: generatedAt.toISOString() },
      review: { reviewedBy: { id: 'u', name: 'Una' }, reviewedAt: reviewedAt.toISOString() },
    });
    expect(response).not.toHaveProperty('factors');
    expect(response).not.toHaveProperty('MTTR');
  });

  it('a manual postmortem is not aiGenerated and has null provenance values', () => {
    const response = toPostmortemResponse({
      ...base,
      generationStatus: 'DRAFT',
      reviewStatus: 'REVIEWED',
      reviewedAt: new Date(),
      reviewedBy: { id: 'u', name: 'Una' },
    });
    expect(response.aiGenerated).toBe(false);
    expect(response.provenance).toEqual({ model: null, modelVersion: null, generatedAt: null });
  });

  it('exposes the failure reason of a FAILED postmortem', () => {
    const response = toPostmortemResponse({
      ...base,
      generationStatus: 'FAILED',
      failureReason: 'OUTPUT_INVALID',
    });
    expect(response).toMatchObject({ aiGenerated: true, failureReason: 'OUTPUT_INVALID' });
  });

  it('never carries prompt or inputData', () => {
    const response = toPostmortemResponse({
      ...base,
      prompt: 'p',
      inputData: 'i',
    } as PostmortemRow);
    expect(JSON.stringify(response)).not.toMatch(/prompt|inputData/);
  });
});
