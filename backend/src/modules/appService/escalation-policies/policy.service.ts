import { getPrisma, lockRowForUpdate } from '../../../infra/db/prisma.js';
import { ConflictError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { assertSameTeam, requireTeam } from '../../identity/index.js';
import { invalidAction, policyNotFound, serviceNotFound } from '../appService.common.js';
import { policyUserViolations } from '../policy-users.rules.js';
import { findServiceById, hasUnresolvedIncidents } from '../services/service.repository.js';
import { runServiceTransaction } from '../transaction.js';
import { toPolicyResponse, type EscalationPolicyResponse } from './policy.mapper.js';
import { findPolicyById, lockUsersForShare, updatePolicy } from './policy.repository.js';
import type { UpdatePolicyBody } from './policy.schema.js';

/** S5: a service has exactly one policy, so there is never a success path. */
export async function rejectAdditionalPolicy(serviceId: string): Promise<never> {
  if (!(await findServiceById(getPrisma(), serviceId))) throw serviceNotFound();
  throw new ConflictError(
    'A service has exactly one escalation policy; update it instead',
    'POLICIES_MAX_LIMIT_REACHED',
  );
}

export async function getPolicy(
  auth: AuthContext,
  serviceId: string,
  policyId: string,
): Promise<EscalationPolicyResponse> {
  if (auth.role !== 'ADMIN') requireTeam(auth);
  const db = getPrisma();
  const service = await findServiceById(db, serviceId);
  if (!service) throw serviceNotFound();
  if (auth.role !== 'ADMIN') assertSameTeam(auth, service.teamId);

  const policy =
    service.escalationPolicyId === policyId ? await findPolicyById(db, policyId) : null;
  if (!policy) throw policyNotFound();
  return toPolicyResponse(policy);
}

export async function updatePolicyUsers(
  serviceId: string,
  policyId: string,
  body: UpdatePolicyBody,
): Promise<EscalationPolicyResponse> {
  return runServiceTransaction(async (tx) => {
    // Same lock as the service update, so the incident check cannot race incident creation.
    if (!(await lockRowForUpdate(tx, 'AppService', serviceId))) throw serviceNotFound();
    const service = await findServiceById(tx, serviceId);
    if (!service) throw serviceNotFound();
    if (service.escalationPolicyId !== policyId) throw policyNotFound();
    const policy = await findPolicyById(tx, policyId);
    if (!policy) throw policyNotFound();

    const users = await lockUsersForShare(
      tx,
      Object.values(body).filter((id) => id !== undefined),
    );
    const violations = policyUserViolations(body, users, service.teamId);
    if (violations.length > 0) {
      throw invalidAction('Escalation policy users are not valid for this service', violations);
    }

    const changes = {
      level1Id: changed(body.level1, policy.level1Id),
      level2Id: changed(body.level2, policy.level2Id),
      level3Id: changed(body.level3, policy.level3Id),
      fallbackAdminId: changed(body.fallbackAdmin, policy.fallbackAdminId),
    };
    if (Object.values(changes).every((value) => value === undefined)) {
      return toPolicyResponse(policy);
    }

    if (await hasUnresolvedIncidents(tx, serviceId)) {
      throw new ConflictError('Service has unresolved incidents', 'POLICY_IN_USE');
    }
    return toPolicyResponse(await updatePolicy(tx, policyId, changes));
  });
}

function changed(sent: string | undefined, stored: string): string | undefined {
  return sent !== undefined && sent !== stored ? sent : undefined;
}
