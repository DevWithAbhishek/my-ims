import { buildSlaStatus, type SlaThresholds } from './sla.js';

const thresholds: SlaThresholds = {
  P0: { responseMinutes: 5, resolutionMinutes: 30 },
  P1: { responseMinutes: 10, resolutionMinutes: 60 },
  P2: { responseMinutes: 30, resolutionMinutes: 120 },
  P3: { responseMinutes: 60, resolutionMinutes: 240 },
};
const createdAt = new Date('2026-01-01T00:00:00.000Z');
const at = (minutes: number, extraMs = 0) =>
  new Date(createdAt.getTime() + minutes * 60_000 + extraMs);

function status(overrides: Partial<Parameters<typeof buildSlaStatus>[0]>, now: Date) {
  return buildSlaStatus(
    { severity: 'P1', createdAt, acknowledgedAt: null, resolvedAt: null, thresholds, ...overrides },
    now,
  );
}

describe('buildSlaStatus', () => {
  it('computes deadlines from createdAt and the current severity', () => {
    const result = status({ severity: 'P0' }, at(0));
    expect(result.applicableSeverity).toBe('P0');
    expect(result.response).toEqual({
      thresholdMinutes: 5,
      deadlineAt: '2026-01-01T00:05:00.000Z',
      state: 'ON_TRACK',
      metAt: null,
    });
    expect(result.resolution.deadlineAt).toBe('2026-01-01T00:30:00.000Z');
  });

  it('is ON_TRACK below 80 %, WARNING from 80 %, BREACHED after the deadline', () => {
    expect(status({}, at(7, 999)).response.state).toBe('ON_TRACK');
    expect(status({}, at(8)).response.state).toBe('WARNING');
    expect(status({}, at(10)).response.state).toBe('WARNING');
    expect(status({}, at(10, 1)).response.state).toBe('BREACHED');
  });

  it('is MET once acknowledged or resolved, even after the deadline', () => {
    const result = status({ acknowledgedAt: at(20), resolvedAt: at(90) }, at(500));
    expect(result.response).toMatchObject({ state: 'MET', metAt: at(20).toISOString() });
    expect(result.resolution).toMatchObject({ state: 'MET', metAt: at(90).toISOString() });
  });

  it('evaluates the two clocks independently', () => {
    const result = status({ acknowledgedAt: at(3) }, at(50));
    expect(result.response.state).toBe('MET');
    expect(result.resolution.state).toBe('WARNING');
  });

  it('uses the current severity thresholds without resetting the clock', () => {
    const asP1 = status({ severity: 'P1' }, at(20));
    const asP3 = status({ severity: 'P3' }, at(20));
    expect(asP1.response.state).toBe('BREACHED');
    expect(asP3.response.state).toBe('ON_TRACK');
    expect(asP3.response.deadlineAt).toBe(at(60).toISOString());
  });
});
