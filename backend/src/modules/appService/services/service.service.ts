import { isUniqueViolation } from '../../../infra/db/errors.js';
import { getPrisma, lockRowForUpdate } from '../../../infra/db/prisma.js';
import { ConflictError, ValidationError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { assertSameTeam, requireTeam } from '../../identity/index.js';
import {
  invalidAction,
  serviceNotFound,
  toPage,
  policyNotFound,
  type Page,
} from '../appService.common.js';
import {
  findPolicyWithOwner,
  insertPolicy,
  lockUsersForShare,
} from '../escalation-policies/policy.repository.js';
import { policyUserViolations } from '../policy-users.rules.js';
import { SLA_FIELDS, slaOrderingIssues } from '../sla.rules.js';
import { runServiceTransaction, type Db } from '../transaction.js';
import { slaValuesOf, toServiceResponse, type ServiceResponse } from './service.mapper.js';
import {
  findServiceById,
  hasAnyIncident,
  hasUnresolvedIncidents,
  insertService,
  listServices as selectServices,
  lockTeamForShare,
  updateService as writeService,
} from './service.repository.js';
import type { CreateServiceBody, ListServicesQuery, UpdateServiceBody } from './service.schema.js';

const duplicateService = () =>
  new ConflictError('A service with this name already exists', 'SERVICE_ALREADY_EXISTS');

/** Team must exist and be active; the row is locked `FOR SHARE` until the transaction ends. */
async function assertAssignableTeam(tx: Db, teamId: string): Promise<void> {
  const team = await lockTeamForShare(tx, teamId);
  if (team === null || team.status === 'DEACTIVATED') {
    throw invalidAction('Team does not exist or is deactivated');
  }
}

export async function createService(body: CreateServiceBody): Promise<ServiceResponse> {
  const { escalationPolicy, ...serviceFields } = body;
  try {
    return await runServiceTransaction(async (tx) => {
      await assertAssignableTeam(tx, body.teamId);

      const users = await lockUsersForShare(tx, Object.values(escalationPolicy));
      const violations = policyUserViolations(escalationPolicy, users, body.teamId);
      if (violations.length > 0) {
        throw invalidAction('Escalation policy users are not valid for this service', violations);
      }

      const policy = await insertPolicy(tx, {
        level1Id: escalationPolicy.level1,
        level2Id: escalationPolicy.level2,
        level3Id: escalationPolicy.level3,
        fallbackAdminId: escalationPolicy.fallbackAdmin,
      });
      const service = await insertService(tx, { ...serviceFields, escalationPolicyId: policy.id });
      return toServiceResponse(service);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateService();
    throw error;
  }
}

/** Admins see any team (optionally filtered); other roles see their own team only. */
export async function listServices(
  auth: AuthContext,
  query: ListServicesQuery,
): Promise<Page<ServiceResponse>> {
  let teamId = query.teamId;
  if (auth.role !== 'ADMIN') {
    const ownTeamId = requireTeam(auth);
    if (teamId !== undefined) assertSameTeam(auth, teamId);
    teamId = ownTeamId;
  }
  const rows = await selectServices(getPrisma(), { ...query, teamId });
  return toPage(rows.map(toServiceResponse), query.limit, query.offset);
}

export async function getService(auth: AuthContext, serviceId: string): Promise<ServiceResponse> {
  if (auth.role !== 'ADMIN') requireTeam(auth);
  const service = await findServiceById(getPrisma(), serviceId);
  if (!service) throw serviceNotFound();
  if (auth.role !== 'ADMIN') assertSameTeam(auth, service.teamId);
  return toServiceResponse(service);
}

/** The fields of `patch` that are present and differ from the stored `current` values. */
function changedFields<T extends object>(current: object, patch: T): Partial<T> {
  const stored = current as Record<string, unknown>;
  const changed = Object.entries(patch).filter(
    ([key, value]) => value !== undefined && stored[key] !== value,
  );
  return Object.fromEntries(changed) as Partial<T>;
}

export async function updateService(
  serviceId: string,
  body: UpdateServiceBody,
): Promise<ServiceResponse> {
  try {
    return await runServiceTransaction(async (tx) => {
      // The lock conflicts with the key-share lock an incident insert takes on this row, so the
      // incident checks below see every incident that committed before this update.
      if (!(await lockRowForUpdate(tx, 'AppService', serviceId))) throw serviceNotFound();
      const stored = await findServiceById(tx, serviceId);
      if (!stored) throw serviceNotFound();

      const changes = changedFields(stored, body);

      const slaIssues = slaOrderingIssues({ ...slaValuesOf(stored), ...changes });
      if (slaIssues.length > 0) {
        throw new ValidationError('Request validation failed', 'VALIDATION_FAILED', slaIssues);
      }

      const policyChanging = changes.escalationPolicyId !== undefined;

      if (changes.teamId !== undefined) {
        await assertAssignableTeam(tx, changes.teamId);
        // Any incident pins the service to its team; this wins over SERVICE_HAS_OPEN_INCIDENTS.
        if (await hasAnyIncident(tx, serviceId)) {
          throw invalidAction('The team of a service with incidents cannot change');
        }
      }

      if (changes.escalationPolicyId !== undefined) {
        // Locking the policy serializes two services racing for the same orphaned policy.
        if (!(await lockRowForUpdate(tx, 'EscalationPolicy', changes.escalationPolicyId))) {
          throw policyNotFound();
        }
        const policy = await findPolicyWithOwner(tx, changes.escalationPolicyId);
        if (!policy) throw policyNotFound();
        if (policy.appService !== null) {
          throw invalidAction('The escalation policy is attached to another service');
        }
      }

      const slaChanging = SLA_FIELDS.some((field) => changes[field] !== undefined);
      const deactivating = changes.status === 'DEACTIVATED';
      if (
        (deactivating || slaChanging || policyChanging) &&
        (await hasUnresolvedIncidents(tx, serviceId))
      ) {
        throw new ConflictError('Service has unresolved incidents', 'SERVICE_HAS_OPEN_INCIDENTS');
      }

      if (Object.keys(changes).length === 0) return toServiceResponse(stored);
      return toServiceResponse(await writeService(tx, serviceId, changes));
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateService();
    throw error;
  }
}
