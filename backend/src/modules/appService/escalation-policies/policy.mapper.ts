import type { EscalationPolicy } from '../../../generated/prisma/client.js';

export type EscalationPolicyResponse = {
  id: string;
  level1: string;
  level2: string;
  level3: string;
  fallbackAdmin: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toPolicyResponse(policy: EscalationPolicy): EscalationPolicyResponse {
  return {
    id: policy.id,
    level1: policy.level1Id,
    level2: policy.level2Id,
    level3: policy.level3Id,
    fallbackAdmin: policy.fallbackAdminId,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}
