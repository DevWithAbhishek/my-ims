import { toInvestigationResponse } from './investigation.mapper';

const base = {
  id: 'i1',
  incidentId: 'inc',
  status: 'REQUESTED',
  createdAt: new Date('2026-10-17T10:00:00.000Z'),
  completedAt: null,
  failureReason: null,
  model: null,
  modelVersion: null,
  requestedBy: { id: 'u1', name: 'Ada' },
} as const;

const brief = {
  summary: 's',
  findings: [],
  possibleAreas: [],
  suggestedSteps: [],
  limitations: null,
};

describe('toInvestigationResponse', () => {
  it('shows no brief and no evidence until COMPLETED, with null provenance and failure', () => {
    const response = toInvestigationResponse({ ...base, result: brief, evidences: [] });
    expect(response).toMatchObject({ brief: null, evidence: [], completedAt: null });
    expect(response.provenance).toEqual({ model: null, modelVersion: null });
    expect(response.failureReason).toBeNull();
  });

  it('shows brief and evidence (relevanceInfo as relevance) when COMPLETED', () => {
    const response = toInvestigationResponse({
      ...base,
      status: 'COMPLETED',
      completedAt: new Date('2026-10-17T10:01:00.000Z'),
      model: 'm',
      modelVersion: 'm-1',
      result: brief,
      evidences: [
        {
          id: 'e1',
          evidenceType: 'FACT',
          sourceType: 'INCIDENT',
          sourceReference: 'inc',
          relevanceInfo: 'why',
        },
      ],
    });
    expect(response.brief).toEqual(brief);
    expect(response.evidence).toEqual([
      {
        id: 'e1',
        evidenceType: 'FACT',
        sourceType: 'INCIDENT',
        sourceReference: 'inc',
        relevance: 'why',
      },
    ]);
    expect(response.completedAt).toBe('2026-10-17T10:01:00.000Z');
    expect(response.provenance).toEqual({ model: 'm', modelVersion: 'm-1' });
  });

  it('exposes nothing internal', () => {
    const response = toInvestigationResponse({
      ...base,
      input: { postmortemLimit: 20 },
      idempotencyKey: 'secret-key',
    } as never);
    expect(Object.keys(response).sort()).toEqual(
      [
        'brief',
        'completedAt',
        'createdAt',
        'evidence',
        'failureReason',
        'id',
        'incidentId',
        'provenance',
        'requestedBy',
        'status',
      ].sort(),
    );
  });

  it('shows a failure reason only', () => {
    const response = toInvestigationResponse({
      ...base,
      status: 'FAILED',
      failureReason: 'OUTPUT_INVALID',
    });
    expect(response).toMatchObject({
      status: 'FAILED',
      failureReason: 'OUTPUT_INVALID',
      brief: null,
    });
  });
});
