import type { AppService } from '../../../generated/prisma/client.js';
import { SLA_FIELDS, type SlaValues } from '../sla.rules.js';

export type ServiceResponse = SlaValues & {
  id: string;
  name: string;
  defaultSeverity: 'P0' | 'P1' | 'P2' | 'P3';
  status: 'ACTIVE' | 'DEACTIVATED';
  teamId: string;
  escalationPolicyId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** The eight stored SLA values of a service. */
export function slaValuesOf(service: AppService): SlaValues {
  return Object.fromEntries(SLA_FIELDS.map((field) => [field, service[field]])) as SlaValues;
}

export function toServiceResponse(service: AppService): ServiceResponse {
  return {
    id: service.id,
    name: service.name,
    defaultSeverity: service.defaultSeverity,
    status: service.status,
    ...slaValuesOf(service),
    teamId: service.teamId,
    escalationPolicyId: service.escalationPolicyId,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}
