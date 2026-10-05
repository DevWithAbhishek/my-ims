import type { AppService, EscalationPolicy } from '../../generated/prisma/client.js';
import type { EscalationPolicyConfig, ServiceConfig } from './config.js';

export function toServiceConfig(service: AppService): ServiceConfig {
  return {
    id: service.id,
    name: service.name,
    status: service.status,
    teamId: service.teamId,
    defaultSeverity: service.defaultSeverity,
    escalationPolicyId: service.escalationPolicyId,
    sla: {
      P0: {
        responseMinutes: service.P0ResponseSlaMinutes,
        resolutionMinutes: service.P0ResolutionSlaMinutes,
      },
      P1: {
        responseMinutes: service.P1ResponseSlaMinutes,
        resolutionMinutes: service.P1ResolutionSlaMinutes,
      },
      P2: {
        responseMinutes: service.P2ResponseSlaMinutes,
        resolutionMinutes: service.P2ResolutionSlaMinutes,
      },
      P3: {
        responseMinutes: service.P3ResponseSlaMinutes,
        resolutionMinutes: service.P3ResolutionSlaMinutes,
      },
    },
  };
}

export function toPolicyConfig(policy: EscalationPolicy): EscalationPolicyConfig {
  return {
    level1: policy.level1Id,
    level2: policy.level2Id,
    level3: policy.level3Id,
    fallbackAdmin: policy.fallbackAdminId,
  };
}
