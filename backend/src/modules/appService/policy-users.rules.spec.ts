import { policyUserViolations, type PolicyUserFacts } from './policy-users.rules.js';

const TEAM = 'a0000000-0000-4000-8000-00000000000a';
const OTHER_TEAM = 'b0000000-0000-4000-8000-00000000000b';
const ids = {
  engineer: 'e0000000-0000-4000-8000-000000000001',
  engineer2: 'e0000000-0000-4000-8000-000000000002',
  lead: 'c0000000-0000-4000-8000-000000000003',
  admin: 'd0000000-0000-4000-8000-000000000004',
};

const facts = (overrides: Partial<PolicyUserFacts>): PolicyUserFacts => ({
  role: 'ENGINEER',
  status: 'ACTIVE',
  teamId: TEAM,
  ...overrides,
});

const users = (extra: Record<string, PolicyUserFacts> = {}) =>
  new Map<string, PolicyUserFacts>(
    Object.entries({
      [ids.engineer]: facts({}),
      [ids.engineer2]: facts({}),
      [ids.lead]: facts({ role: 'TEAM_LEAD' }),
      [ids.admin]: facts({ role: 'ADMIN', teamId: null }),
      ...extra,
    }),
  );

const valid = {
  level1: ids.engineer,
  level2: ids.engineer2,
  level3: ids.lead,
  fallbackAdmin: ids.admin,
};

describe('policyUserViolations', () => {
  it('accepts a valid policy (the admin may belong to no team)', () => {
    expect(policyUserViolations(valid, users(), TEAM)).toEqual([]);
  });

  it('only checks the levels that are present', () => {
    expect(policyUserViolations({ level3: ids.lead }, users(), TEAM)).toEqual([]);
    expect(policyUserViolations({}, new Map(), TEAM)).toEqual([]);
  });

  it.each([
    ['level1', { level1: ids.lead }],
    ['level2', { level2: ids.admin }],
    ['level3', { level3: ids.engineer }],
    ['fallbackAdmin', { fallbackAdmin: ids.lead }],
  ])('rejects a wrong role at %s', (field, selection) => {
    expect(policyUserViolations(selection, users(), TEAM).map((v) => v.field)).toEqual([field]);
  });

  it('rejects users of another team for team levels but not for the fallback admin', () => {
    const map = users({
      [ids.engineer]: facts({ teamId: OTHER_TEAM }),
      [ids.lead]: facts({ role: 'TEAM_LEAD', teamId: OTHER_TEAM }),
      [ids.admin]: facts({ role: 'ADMIN', teamId: OTHER_TEAM }),
    });
    expect(policyUserViolations(valid, map, TEAM).map((v) => v.field)).toEqual([
      'level1',
      'level3',
    ]);
  });

  it('rejects deactivated and unknown users', () => {
    const map = users({ [ids.engineer]: facts({ status: 'DEACTIVATED' }) });
    const selection = { ...valid, level2: 'f0000000-0000-4000-8000-000000000009' };
    expect(policyUserViolations(selection, map, TEAM)).toEqual([
      { field: 'level1', issue: 'User is not active' },
      { field: 'level2', issue: 'User does not exist' },
    ]);
  });
});
