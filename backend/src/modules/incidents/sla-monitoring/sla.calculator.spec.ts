import type { IncidentStatus, Severity } from '../incidents.types';
import {
  breachDueAt,
  isClockRunning,
  nextStep,
  thresholdMinutes,
  upcomingMilestones,
  warningDueAt,
  type SlaSnapshot,
} from './sla.calculator';
import type { Milestone } from './sla.milestones';

const T0 = new Date('2026-10-16T10:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const thresholds = {
  P0: { responseMinutes: 5, resolutionMinutes: 30 },
  P1: { responseMinutes: 10, resolutionMinutes: 60 },
  P2: { responseMinutes: 30, resolutionMinutes: 120 },
  P3: { responseMinutes: 60, resolutionMinutes: 240 },
};

const snapshot = (
  overrides: Partial<{ status: IncidentStatus; severity: Severity }> = {},
): SlaSnapshot => ({ status: 'OPEN', severity: 'P1', createdAt: T0, thresholds, ...overrides });

const none = new Set<Milestone>();

describe('SLA time model', () => {
  it('uses the threshold of the current severity', () => {
    expect(thresholdMinutes(snapshot({ severity: 'P0' }), 'RESPONSE')).toBe(5);
    expect(thresholdMinutes(snapshot({ severity: 'P3' }), 'RESOLUTION')).toBe(240);
  });

  it('counts both clocks from createdAt: warning at exactly 80 %, breach strictly after 100 %', () => {
    expect(warningDueAt(snapshot(), 'RESPONSE')).toBe(T0.getTime() + 8 * MIN);
    expect(breachDueAt(snapshot(), 'RESPONSE')).toBe(T0.getTime() + 10 * MIN + 1);
    expect(warningDueAt(snapshot(), 'RESOLUTION')).toBe(T0.getTime() + 48 * MIN);
  });

  it('runs the response clock only while OPEN and the resolution clock until resolved', () => {
    expect(isClockRunning('OPEN', 'RESPONSE')).toBe(true);
    expect(isClockRunning('ACKNOWLEDGED', 'RESPONSE')).toBe(false);
    expect(isClockRunning('MITIGATING', 'RESOLUTION')).toBe(true);
    expect(isClockRunning('RESOLVED', 'RESOLUTION')).toBe(false);
    expect(isClockRunning('CLOSED', 'RESOLUTION')).toBe(false);
  });
});

describe('nextStep', () => {
  it('does nothing before 80 %', () => {
    expect(nextStep(snapshot(), at(8 * MIN - 1), none)).toBeNull();
  });

  it('warns at exactly 80 % of the response window', () => {
    expect(nextStep(snapshot(), at(8 * MIN), none)).toEqual({
      kind: 'WARNING',
      clock: 'RESPONSE',
      milestone: 'RESPONSE_WARNING',
    });
  });

  it('is not breached at the deadline itself, only after it', () => {
    const warned = new Set<Milestone>(['RESPONSE_WARNING']);
    expect(nextStep(snapshot(), at(10 * MIN), warned)).toBeNull();
    expect(nextStep(snapshot(), at(10 * MIN + 1), warned)).toEqual({
      kind: 'BREACH',
      clock: 'RESPONSE',
      milestone: 'RESPONSE_BREACH',
    });
  });

  it('records an overdue warning before the breach (downtime recovery)', () => {
    expect(nextStep(snapshot(), at(11 * MIN), none)).toMatchObject({
      milestone: 'RESPONSE_WARNING',
    });
    expect(
      nextStep(snapshot(), at(11 * MIN), new Set<Milestone>(['RESPONSE_WARNING'])),
    ).toMatchObject({
      milestone: 'RESPONSE_BREACH',
    });
  });

  it('never repeats a recorded milestone', () => {
    const done = new Set<Milestone>(['RESPONSE_WARNING', 'RESPONSE_BREACH']);
    const step = nextStep(snapshot(), at(11 * MIN), done);
    expect(step).toEqual({ kind: 'ESCALATION', level: 1 });
  });

  it('moves the threshold with a severity change without resetting the clock', () => {
    // At minute 6 nothing is due under P1 (warning at 8, breach after 10); raised to P0 (5 min)
    // the same elapsed time is past the deadline, so the warning and then the breach are due.
    expect(nextStep(snapshot({ severity: 'P1' }), at(6 * MIN), none)).toBeNull();
    expect(nextStep(snapshot({ severity: 'P0' }), at(6 * MIN), none)).toMatchObject({
      milestone: 'RESPONSE_WARNING',
    });
    expect(
      nextStep(snapshot({ severity: 'P0' }), at(6 * MIN), new Set<Milestone>(['RESPONSE_WARNING'])),
    ).toMatchObject({ milestone: 'RESPONSE_BREACH' });
    // Lowered to P3 (60 min) nothing is due at minute 9 although P1 would have warned.
    expect(nextStep(snapshot({ severity: 'P3' }), at(9 * MIN), none)).toBeNull();
  });

  it('escalates levels in policy order, resuming from the next unrecorded level', () => {
    const base: Milestone[] = ['RESPONSE_WARNING', 'RESPONSE_BREACH'];
    const step = (extra: Milestone[]) =>
      nextStep(snapshot(), at(11 * MIN), new Set<Milestone>([...base, ...extra]));
    expect(step([])).toEqual({ kind: 'ESCALATION', level: 1 });
    expect(step(['ESCALATION_LEVEL_1'])).toEqual({ kind: 'ESCALATION', level: 2 });
    expect(step(['ESCALATION_LEVEL_1', 'ESCALATION_LEVEL_2'])).toEqual({
      kind: 'ESCALATION',
      level: 3,
    });
    expect(step(['ESCALATION_LEVEL_1', 'ESCALATION_LEVEL_2', 'ESCALATION_LEVEL_3'])).toEqual({
      kind: 'ESCALATION',
      level: 4,
    });
  });

  it('treats a failed level as finished and attempts the next one', () => {
    const recorded = new Set<Milestone>([
      'RESPONSE_WARNING',
      'RESPONSE_BREACH',
      'ESCALATION_LEVEL_1',
      'ESCALATION_FAILURE_2',
    ]);
    expect(nextStep(snapshot(), at(11 * MIN), recorded)).toEqual({ kind: 'ESCALATION', level: 3 });
  });

  it('ends the chain after the last level, whether it succeeded or failed', () => {
    const through = (last: Milestone) =>
      new Set<Milestone>([
        'RESPONSE_WARNING',
        'RESPONSE_BREACH',
        'ESCALATION_LEVEL_1',
        'ESCALATION_LEVEL_2',
        'ESCALATION_LEVEL_3',
        last,
      ]);
    expect(nextStep(snapshot(), at(11 * MIN), through('ESCALATION_LEVEL_4'))).toBeNull();
    expect(nextStep(snapshot(), at(11 * MIN), through('ESCALATION_FAILURE_4'))).toBeNull();
  });

  it('does not escalate before the response breach is recorded', () => {
    expect(nextStep(snapshot(), at(5 * MIN), none)).toBeNull();
  });

  it('stops every response milestone and escalation once acknowledged, resolved or closed', () => {
    const breached = new Set<Milestone>(['RESPONSE_WARNING', 'RESPONSE_BREACH']);
    for (const status of ['ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const) {
      const step = nextStep(snapshot({ status }), at(11 * MIN), breached);
      expect(step?.kind === 'ESCALATION').toBe(false);
      expect(step?.kind === 'WARNING' && step.clock === 'RESPONSE').toBe(false);
    }
    expect(nextStep(snapshot({ status: 'ACKNOWLEDGED' }), at(11 * MIN), none)).toBeNull();
  });

  it('keeps the resolution clock running after acknowledgement and stops it at resolve', () => {
    expect(nextStep(snapshot({ status: 'MITIGATING' }), at(48 * MIN), none)).toEqual({
      kind: 'WARNING',
      clock: 'RESOLUTION',
      milestone: 'RESOLUTION_WARNING',
    });
    expect(nextStep(snapshot({ status: 'RESOLVED' }), at(500 * MIN), none)).toBeNull();
    expect(nextStep(snapshot({ status: 'CLOSED' }), at(500 * MIN), none)).toBeNull();
  });

  it('records the resolution breach without any other effect on the incident state', () => {
    const recorded = new Set<Milestone>(['RESOLUTION_WARNING']);
    expect(nextStep(snapshot({ status: 'MITIGATING' }), at(60 * MIN + 1), recorded)).toEqual({
      kind: 'BREACH',
      clock: 'RESOLUTION',
      milestone: 'RESOLUTION_BREACH',
    });
  });

  it('after an unassign (back to OPEN) the response clock runs against the original deadline', () => {
    expect(nextStep(snapshot({ status: 'OPEN' }), at(11 * MIN), none)).toMatchObject({
      milestone: 'RESPONSE_WARNING',
    });
  });
});

describe('upcomingMilestones', () => {
  it('lists warnings and breaches of running clocks that are still ahead', () => {
    const upcoming = upcomingMilestones(snapshot(), at(0), none);
    expect(upcoming.map((u) => u.milestone).sort()).toEqual([
      'RESOLUTION_BREACH',
      'RESOLUTION_WARNING',
      'RESPONSE_BREACH',
      'RESPONSE_WARNING',
    ]);
    expect(upcoming.find((u) => u.milestone === 'RESPONSE_WARNING')?.dueAt).toBe(
      T0.getTime() + 8 * MIN,
    );
  });

  it('leaves out what is due, recorded or belongs to a stopped clock', () => {
    const upcoming = upcomingMilestones(
      snapshot({ status: 'MITIGATING' }),
      at(9 * MIN),
      new Set<Milestone>(['RESOLUTION_WARNING']),
    );
    expect(upcoming.map((u) => u.milestone)).toEqual(['RESOLUTION_BREACH']);
    expect(upcomingMilestones(snapshot({ status: 'RESOLVED' }), at(0), none)).toEqual([]);
  });
});
