import type { AppError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import {
  assertChainMember,
  assertMayResolve,
  assertMaySetSeverity,
  assertRequiredState,
  isChainMember,
  isEligibleAssignee,
  requireManagerRole,
} from './lifecycle.rules.js';

const auth = (role: AuthContext['role'], userId = 'u1'): AuthContext => ({
  userId,
  email: 'a@example.com',
  role,
  teamId: 't1',
  sessionId: 's1',
});
const thrown = (fn: () => void): AppError => {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('did not throw');
};

describe('assertRequiredState', () => {
  it('passes inside the allowed set', () => {
    expect(() => assertRequiredState('OPEN', ['OPEN', 'ACKNOWLEDGED'])).not.toThrow();
  });

  it('reports a single required status as a string', () => {
    const error = thrown(() => assertRequiredState('OPEN', ['MITIGATING']));
    expect([error.statusCode, error.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);
    expect(error.details).toEqual([{ currentStatus: 'OPEN', requiredStatus: 'MITIGATING' }]);
  });

  it('reports the allowed set for multi-state actions', () => {
    const error = thrown(() => assertRequiredState('RESOLVED', ['OPEN', 'ACKNOWLEDGED']));
    expect(error.details).toEqual([
      { currentStatus: 'RESOLVED', requiredStatus: ['OPEN', 'ACKNOWLEDGED'] },
    ]);
  });
});

describe('role rules', () => {
  it('requireManagerRole: Team Lead and Admin pass, Engineer is FORBIDDEN_ROLE', () => {
    expect(() => requireManagerRole(auth('TEAM_LEAD'))).not.toThrow();
    expect(() => requireManagerRole(auth('ADMIN'))).not.toThrow();
    expect(thrown(() => requireManagerRole(auth('ENGINEER'))).code).toBe('FORBIDDEN_ROLE');
  });

  it('assertMaySetSeverity: only an Engineer on an OPEN incident is refused', () => {
    expect(thrown(() => assertMaySetSeverity(auth('ENGINEER'), 'OPEN')).code).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(() => assertMaySetSeverity(auth('ENGINEER'), 'ACKNOWLEDGED')).not.toThrow();
    expect(() => assertMaySetSeverity(auth('TEAM_LEAD'), 'OPEN')).not.toThrow();
    expect(() => assertMaySetSeverity(auth('ADMIN'), 'OPEN')).not.toThrow();
  });

  it('assertMayResolve: an Engineer must be the current assignee', () => {
    expect(() => assertMayResolve(auth('ENGINEER', 'u1'), 'u1')).not.toThrow();
    expect(thrown(() => assertMayResolve(auth('ENGINEER', 'u1'), 'u2')).code).toBe(
      'NOT_CURRENT_ASSIGNEE',
    );
    expect(thrown(() => assertMayResolve(auth('ENGINEER', 'u1'), null)).code).toBe(
      'NOT_CURRENT_ASSIGNEE',
    );
    expect(() => assertMayResolve(auth('TEAM_LEAD'), 'u2')).not.toThrow();
    expect(() => assertMayResolve(auth('ADMIN'), null)).not.toThrow();
  });
});

describe('escalation chain', () => {
  const chain = { level1: 'a', level2: 'b', level3: 'c', fallbackAdmin: 'd' };

  it.each(['a', 'b', 'c', 'd'])('%s is a member', (id) => {
    expect(isChainMember(chain, id)).toBe(true);
  });

  it('refuses a user outside the chain, and every user when there is no policy', () => {
    expect(thrown(() => assertChainMember(chain, 'x'))).toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(isChainMember(null, 'a')).toBe(false);
  });
});

describe('isEligibleAssignee', () => {
  const ok = { role: 'ENGINEER', status: 'ACTIVE', teamId: 't1' } as const;

  it('accepts an active Engineer or Team Lead of the incident team', () => {
    expect(isEligibleAssignee(ok, 't1')).toBe(true);
    expect(isEligibleAssignee({ ...ok, role: 'TEAM_LEAD' }, 't1')).toBe(true);
  });

  it.each([
    ['a user that does not exist', null],
    ['a user of another team', { ...ok, teamId: 't2' }],
    ['a user without a team', { ...ok, teamId: null }],
    ['a deactivated user', { ...ok, status: 'DEACTIVATED' as const }],
    ['an Admin', { ...ok, role: 'ADMIN' as const }],
  ])('rejects %s', (_name, candidate) => {
    expect(isEligibleAssignee(candidate, 't1')).toBe(false);
  });
});
