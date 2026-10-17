import { AppError } from '../../../shared/errors/AppError.js';
import type { IncidentStatus } from '../incidents.types.js';
import {
  assertManuallyCreatable,
  assertRetryable,
  assertReviewable,
  computeMttrMinutes,
  deriveAiGenerated,
} from './postmortem.rules.js';
import type {
  LockedPostmortem,
  PostmortemGenerationStatus,
  PostmortemReviewStatus,
} from './postmortem.types.js';

const pm = (
  generationStatus: PostmortemGenerationStatus,
  reviewStatus: PostmortemReviewStatus = 'PENDING',
): LockedPostmortem => ({ id: 'p', generationStatus, reviewStatus });

const outcome = (run: () => void): string => {
  try {
    run();
    return 'ok';
  } catch (error) {
    const e = error as AppError;
    return `${e.statusCode} ${e.code}`;
  }
};

describe('assertReviewable (P2, P3)', () => {
  it('passes for an unreviewed draft of a RESOLVED incident', () => {
    expect(outcome(() => assertReviewable(pm('DRAFT'), 'RESOLVED'))).toBe('ok');
  });

  it('is 404 POSTMORTEM_NOT_FOUND without a postmortem', () => {
    expect(outcome(() => assertReviewable(null, 'MITIGATING'))).toBe('404 POSTMORTEM_NOT_FOUND');
  });

  it.each([
    [pm('GENERATING'), 'RESOLVED'],
    [pm('FAILED'), 'RESOLVED'],
    [pm('DRAFT', 'REVIEWED'), 'CLOSED'],
    [pm('DRAFT', 'REVIEWED'), 'RESOLVED'],
    [pm('DRAFT', 'REJECTED'), 'RESOLVED'],
  ] as [LockedPostmortem, IncidentStatus][])(
    'is 409 POSTMORTEM_STATE_INVALID for %j on a %s incident (a second approve included)',
    (postmortem, status) => {
      expect(outcome(() => assertReviewable(postmortem, status))).toBe(
        '409 POSTMORTEM_STATE_INVALID',
      );
    },
  );

  it('is 403 INVALID_ACTION for an unreviewed draft of an incident that is not RESOLVED', () => {
    expect(outcome(() => assertReviewable(pm('DRAFT'), 'CLOSED'))).toBe('403 INVALID_ACTION');
  });

  it('puts the current statuses in the 409 details', () => {
    try {
      assertReviewable(pm('FAILED', 'PENDING'), 'RESOLVED');
    } catch (error) {
      expect((error as AppError).details).toEqual([
        { currentGenerationStatus: 'FAILED', currentReviewStatus: 'PENDING' },
      ]);
    }
  });
});

describe('assertRetryable (P4)', () => {
  it('passes for a FAILED postmortem of a RESOLVED incident', () => {
    expect(outcome(() => assertRetryable(pm('FAILED'), 'RESOLVED'))).toBe('ok');
  });

  it('is 404 without a postmortem', () => {
    expect(outcome(() => assertRetryable(null, 'OPEN'))).toBe('404 POSTMORTEM_NOT_FOUND');
  });

  it.each([
    [pm('GENERATING'), 'RESOLVED'],
    [pm('DRAFT'), 'RESOLVED'],
    [pm('DRAFT', 'REVIEWED'), 'CLOSED'],
    [pm('FAILED'), 'CLOSED'],
  ] as [LockedPostmortem, IncidentStatus][])('is 403 INVALID_ACTION for %j on %s', (p, s) => {
    expect(outcome(() => assertRetryable(p, s))).toBe('403 INVALID_ACTION');
  });
});

describe('assertManuallyCreatable (P5)', () => {
  it('passes for a FAILED postmortem of a RESOLVED incident', () => {
    expect(outcome(() => assertManuallyCreatable(pm('FAILED'), 'RESOLVED'))).toBe('ok');
  });

  it.each([
    [null, 'RESOLVED'],
    [null, 'OPEN'],
    [pm('GENERATING'), 'RESOLVED'],
    [pm('DRAFT'), 'RESOLVED'],
    [pm('DRAFT', 'REVIEWED'), 'CLOSED'],
    [pm('FAILED'), 'CLOSED'],
  ] as [LockedPostmortem | null, IncidentStatus][])(
    'is 403 INVALID_ACTION for %j on %s',
    (p, s) => {
      expect(outcome(() => assertManuallyCreatable(p, s))).toBe('403 INVALID_ACTION');
    },
  );
});

describe('computeMttrMinutes', () => {
  const created = new Date('2026-10-17T10:00:00.000Z');
  const after = (ms: number) => new Date(created.getTime() + ms);

  it.each([
    [0, 0],
    [1, 1],
    [59_999, 1],
    [60_000, 1],
    [60_001, 2],
    [90 * 60_000, 90],
    [90 * 60_000 + 1, 91],
  ])('%d ms is %d minutes (ceiling)', (ms, minutes) => {
    expect(computeMttrMinutes(created, after(ms))).toBe(minutes);
  });
});

describe('deriveAiGenerated', () => {
  const generatedAt = new Date();
  it.each([
    ['GENERATING', null, true],
    ['FAILED', null, true],
    ['DRAFT', generatedAt, true],
    ['DRAFT', null, false],
  ] as const)('%s with generatedAt %s is %s', (generationStatus, at, expected) => {
    expect(deriveAiGenerated({ generationStatus, generatedAt: at })).toBe(expected);
  });
});
