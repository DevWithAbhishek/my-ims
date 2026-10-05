import type { UserRole } from '../../shared/types/auth-context.js';

export const POLICY_LEVELS = ['level1', 'level2', 'level3', 'fallbackAdmin'] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

export type PolicyUsers = Partial<Record<PolicyLevel, string>>;

export type PolicyUserFacts = {
  role: UserRole;
  status: 'ACTIVE' | 'DEACTIVATED';
  teamId: string | null;
};

const REQUIRED_ROLE: Record<PolicyLevel, UserRole> = {
  level1: 'ENGINEER',
  level2: 'ENGINEER',
  level3: 'TEAM_LEAD',
  fallbackAdmin: 'ADMIN',
};

/**
 * Checks the selected policy users against the service's team: `level1`/`level2` must be active
 * engineers and `level3` an active team lead of that team; `fallbackAdmin` an active admin.
 * An unknown user id is a violation.
 */
export function policyUserViolations(
  selection: PolicyUsers,
  users: ReadonlyMap<string, PolicyUserFacts>,
  teamId: string,
): { field: PolicyLevel; issue: string }[] {
  const violations: { field: PolicyLevel; issue: string }[] = [];
  for (const level of POLICY_LEVELS) {
    const userId = selection[level];
    if (userId === undefined) continue;

    const user = users.get(userId);
    const role = REQUIRED_ROLE[level];
    if (!user) {
      violations.push({ field: level, issue: 'User does not exist' });
    } else if (user.status !== 'ACTIVE') {
      violations.push({ field: level, issue: 'User is not active' });
    } else if (user.role !== role) {
      violations.push({ field: level, issue: `User must have the ${role} role` });
    } else if (level !== 'fallbackAdmin' && user.teamId !== teamId) {
      violations.push({ field: level, issue: "User must belong to the service's team" });
    }
  }
  return violations;
}
