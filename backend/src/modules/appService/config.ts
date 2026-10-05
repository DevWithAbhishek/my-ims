import { getPrisma } from '../../infra/db/prisma.js';
import { toPolicyConfig, toServiceConfig } from './config.mapper.js';
import { findPolicyByServiceId } from './escalation-policies/policy.repository.js';
import { findServiceById } from './services/service.repository.js';
import type { Severity } from './sla.rules.js';

export type ServiceStatus = 'ACTIVE' | 'DEACTIVATED';

/** Configuration of one service as consumed by ingestion (SLICE-04) and SLA/escalation (SLICE-07). */
export type ServiceConfig = {
  id: string;
  name: string;
  status: ServiceStatus;
  teamId: string;
  defaultSeverity: Severity;
  escalationPolicyId: string;
  sla: Record<Severity, { responseMinutes: number; resolutionMinutes: number }>;
};

/** The four responders of a service's escalation policy (user ids). */
export type EscalationPolicyConfig = {
  level1: string;
  level2: string;
  level3: string;
  fallbackAdmin: string;
};

/** The service's configuration, or `null` when the service does not exist. */
export async function getServiceConfig(serviceId: string): Promise<ServiceConfig | null> {
  const service = await findServiceById(getPrisma(), serviceId);
  return service ? toServiceConfig(service) : null;
}

/** The escalation policy of the service, or `null` when the service does not exist. */
export async function getEscalationPolicyByService(
  serviceId: string,
): Promise<EscalationPolicyConfig | null> {
  const policy = await findPolicyByServiceId(getPrisma(), serviceId);
  return policy ? toPolicyConfig(policy) : null;
}
