import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../../identity/index.js';
import * as policyService from './policy.service.js';
import {
  policyParamsSchema,
  policyServiceParamsSchema,
  policyUsersBodySchema,
  updatePolicyBodySchema,
} from './policy.schema.js';

export const createPolicyHandler: RequestHandler = async (req) => {
  const { serviceId } = parseOrThrow(policyServiceParamsSchema, req.params);
  parseOrThrow(policyUsersBodySchema, req.body);
  await policyService.rejectAdditionalPolicy(serviceId);
};

export const getPolicyHandler: RequestHandler = async (req, res) => {
  const { serviceId, escalationPolicyId } = parseOrThrow(policyParamsSchema, req.params);
  const policy = await policyService.getPolicy(getAuth(req), serviceId, escalationPolicyId);
  res.status(200).json({ data: policy });
};

export const updatePolicyHandler: RequestHandler = async (req, res) => {
  const { serviceId, escalationPolicyId } = parseOrThrow(policyParamsSchema, req.params);
  const body = parseOrThrow(updatePolicyBodySchema, req.body);
  const policy = await policyService.updatePolicyUsers(serviceId, escalationPolicyId, body);
  res.status(200).json({ data: policy });
};
