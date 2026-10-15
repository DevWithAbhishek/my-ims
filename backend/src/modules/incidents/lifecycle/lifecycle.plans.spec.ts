import type { AppError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import {
  planAcknowledge,
  planAssign,
  planChangeSeverity,
  planConfirmSeverity,
  planResolve,
  planUnassign,
} from './lifecycle.plans.js';
import type { LockedIncident } from './lifecycle.types.js';

const NOW = new Date('2026-10-15T10:00:00.000Z');
const incident = (overrides: Partial<LockedIncident> = {}): LockedIncident => ({
  id: 'i1',
  teamId: 't1',
  affectedServiceId: 's1',
  status: 'OPEN',
  severity: 'P2',
  currentAssigneeId: null,
  acknowledgedById: null,
  ...overrides,
});
const auth = (role: AuthContext['role'] = 'TEAM_LEAD', userId = 'caller'): AuthContext => ({
  userId,
  email: 'a@example.com',
  role,
  teamId: 't1',
  sessionId: 's',
});
const events = (plan: { events: { eventType: string }[] }) => plan.events.map((e) => e.eventType);
const failure = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    const { statusCode, code } = error as AppError;
    return { statusCode, code };
  }
  throw new Error('did not throw');
};

describe('planAcknowledge (I3)', () => {
  it('auto-assigns an unassigned incident: ASSIGNED then ACKNOWLEDGED', () => {
    const plan = planAcknowledge(incident(), 'caller', NOW);
    expect(plan.changes).toEqual({
      status: 'ACKNOWLEDGED',
      acknowledgedById: 'caller',
      acknowledgedTimestamp: NOW,
      currentAssigneeId: 'caller',
    });
    expect(plan.events).toEqual([
      {
        eventType: 'ASSIGNED',
        metadata: { from: null, to: 'caller', auto: true },
        subjectUserId: 'caller',
      },
      {
        eventType: 'ACKNOWLEDGED',
        metadata: { acknowledgedBy: 'caller', autoAssigned: true },
        subjectUserId: 'caller',
      },
    ]);
    expect(plan.outbox).toEqual([]);
  });

  it('keeps the assignee of an assigned incident and writes only ACKNOWLEDGED', () => {
    const plan = planAcknowledge(incident({ currentAssigneeId: 'other' }), 'caller', NOW);
    expect(plan.changes).not.toHaveProperty('currentAssigneeId');
    expect(events(plan)).toEqual(['ACKNOWLEDGED']);
    expect(plan.events[0].metadata).toEqual({ acknowledgedBy: 'caller', autoAssigned: false });
  });

  it.each(['ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const)('%s → 409', (status) => {
    expect(failure(() => planAcknowledge(incident({ status }), 'caller', NOW))).toEqual({
      statusCode: 409,
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('planConfirmSeverity (I4)', () => {
  it('moves ACKNOWLEDGED to MITIGATING and requests an SLA evaluation', () => {
    const plan = planConfirmSeverity(incident({ status: 'ACKNOWLEDGED' }), 'P0', 'caller', NOW);
    expect(plan.changes).toEqual({
      severity: 'P0',
      severityConfirmedById: 'caller',
      severityConfirmTimestamp: NOW,
      status: 'MITIGATING',
    });
    expect(plan.events[0]).toEqual({
      eventType: 'SEVERITY_CONFIRMED',
      metadata: { from: 'P2', to: 'P0', statusFrom: 'ACKNOWLEDGED', statusTo: 'MITIGATING' },
    });
    expect(plan.outbox).toEqual([
      {
        eventType: 'SLA_EVALUATION_REQUESTED',
        aggregateType: 'INCIDENT',
        aggregateId: 'i1',
        payload: { incidentId: 'i1' },
      },
    ]);
  });

  it('writes the event even when the severity is confirmed unchanged', () => {
    const plan = planConfirmSeverity(incident({ status: 'ACKNOWLEDGED' }), 'P2', 'caller', NOW);
    expect(plan.events[0].metadata).toMatchObject({ from: 'P2', to: 'P2' });
  });

  it.each(['OPEN', 'MITIGATING', 'RESOLVED', 'CLOSED'] as const)('%s → 409', (status) => {
    expect(failure(() => planConfirmSeverity(incident({ status }), 'P1', 'caller', NOW))).toEqual({
      statusCode: 409,
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('planChangeSeverity (I5)', () => {
  it('changes the severity and keeps the status in the event', () => {
    const plan = planChangeSeverity(incident({ status: 'MITIGATING' }), 'P0', auth());
    expect(plan.changes).toEqual({ severity: 'P0' });
    expect(plan.events[0].metadata).toEqual({
      from: 'P2',
      to: 'P0',
      statusFrom: 'MITIGATING',
      statusTo: 'MITIGATING',
    });
    expect(plan.outbox).toHaveLength(1);
  });

  it('is a complete no-op for the same value', () => {
    expect(planChangeSeverity(incident({ status: 'OPEN' }), 'P2', auth())).toEqual({
      changes: {},
      events: [],
      outbox: [],
    });
  });

  it('refuses an Engineer on an OPEN incident but not once acknowledged', () => {
    expect(failure(() => planChangeSeverity(incident(), 'P0', auth('ENGINEER')))).toEqual({
      statusCode: 403,
      code: 'FORBIDDEN_ROLE',
    });
    expect(() =>
      planChangeSeverity(incident({ status: 'ACKNOWLEDGED' }), 'P0', auth('ENGINEER')),
    ).not.toThrow();
  });

  it.each(['RESOLVED', 'CLOSED'] as const)('%s → 409 (before the role rule)', (status) => {
    expect(failure(() => planChangeSeverity(incident({ status }), 'P0', auth('ENGINEER')))).toEqual(
      {
        statusCode: 409,
        code: 'INVALID_STATE_TRANSITION',
      },
    );
  });
});

describe('planAssign (I6)', () => {
  it('first assignment: ASSIGNED { from: null, auto: false }', () => {
    const plan = planAssign(incident(), 'b');
    expect(plan.changes).toEqual({ currentAssigneeId: 'b' });
    expect(plan.events).toEqual([
      {
        eventType: 'ASSIGNED',
        metadata: { from: null, to: 'b', auto: false },
        subjectUserId: 'b',
      },
    ]);
  });

  it('reassignment: REASSIGNED { from, to }', () => {
    const plan = planAssign(incident({ currentAssigneeId: 'a' }), 'b');
    expect(plan.events).toEqual([
      { eventType: 'REASSIGNED', metadata: { from: 'a', to: 'b' }, subjectUserId: 'b' },
    ]);
  });

  it('never touches the acknowledgement or the status', () => {
    const { changes } = planAssign(
      incident({ status: 'ACKNOWLEDGED', currentAssigneeId: 'a' }),
      'b',
    );
    expect(Object.keys(changes)).toEqual(['currentAssigneeId']);
  });

  it('the current assignee again is a no-op', () => {
    expect(planAssign(incident({ currentAssigneeId: 'a' }), 'a').events).toEqual([]);
  });

  it.each(['RESOLVED', 'CLOSED'] as const)('%s → 409', (status) => {
    expect(failure(() => planAssign(incident({ status }), 'b')).statusCode).toBe(409);
  });
});

describe('planUnassign (I7)', () => {
  it('assigned and acknowledged: REASSIGNED then OPEN, acknowledgement cleared, SLA evaluation', () => {
    const plan = planUnassign(
      incident({ status: 'MITIGATING', currentAssigneeId: 'a', acknowledgedById: 'a' }),
    );
    expect(plan.changes).toEqual({
      currentAssigneeId: null,
      status: 'OPEN',
      acknowledgedById: null,
      acknowledgedTimestamp: null,
    });
    expect(plan.events).toEqual([
      { eventType: 'REASSIGNED', metadata: { from: 'a', to: null }, subjectUserId: 'a' },
      { eventType: 'OPEN', metadata: { statusFrom: 'MITIGATING' } },
    ]);
    expect(plan.outbox).toHaveLength(1);
  });

  it('assigned but still OPEN: only REASSIGNED, no SLA evaluation', () => {
    const plan = planUnassign(incident({ currentAssigneeId: 'a' }));
    expect(events(plan)).toEqual(['REASSIGNED']);
    expect(plan.outbox).toEqual([]);
  });

  it('unassigned but acknowledged: only OPEN', () => {
    const plan = planUnassign(incident({ status: 'ACKNOWLEDGED' }));
    expect(events(plan)).toEqual(['OPEN']);
    expect(plan.outbox).toHaveLength(1);
  });

  it('already unassigned and OPEN: nothing', () => {
    expect(planUnassign(incident())).toEqual({ changes: {}, events: [], outbox: [] });
  });

  it.each(['RESOLVED', 'CLOSED'] as const)('%s → 409', (status) => {
    expect(failure(() => planUnassign(incident({ status }))).statusCode).toBe(409);
  });
});

describe('planResolve (I8)', () => {
  const mitigating = incident({ status: 'MITIGATING', currentAssigneeId: 'caller' });

  it('resolves and writes RESOLVED with the summary', () => {
    const plan = planResolve(mitigating, auth('ENGINEER'), 'rolled back', NOW);
    expect(plan.changes).toEqual({
      status: 'RESOLVED',
      resolvedById: 'caller',
      resolvedTimestamp: NOW,
      resolutionSummary: 'rolled back',
    });
    expect(plan.events).toEqual([
      {
        eventType: 'RESOLVED',
        metadata: { resolutionSummary: 'rolled back', serviceConfirmedWorking: true },
      },
    ]);
  });

  it.each(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED'] as const)('%s → 409', (status) => {
    expect(failure(() => planResolve(incident({ status }), auth(), 's', NOW)).code).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('an Engineer who is not the assignee gets NOT_CURRENT_ASSIGNEE; a Team Lead does not', () => {
    const other = incident({ status: 'MITIGATING', currentAssigneeId: 'someone' });
    expect(failure(() => planResolve(other, auth('ENGINEER'), 's', NOW)).code).toBe(
      'NOT_CURRENT_ASSIGNEE',
    );
    expect(() => planResolve(other, auth('TEAM_LEAD'), 's', NOW)).not.toThrow();
  });
});
