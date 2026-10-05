import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../../identity/index.js';
import { pageResponse } from '../appService.common.js';
import * as serviceService from './service.service.js';
import {
  createServiceBodySchema,
  listServicesQuerySchema,
  serviceParamsSchema,
  updateServiceBodySchema,
} from './service.schema.js';

export const createServiceHandler: RequestHandler = async (req, res) => {
  const body = parseOrThrow(createServiceBodySchema, req.body);
  res.status(201).json({ data: await serviceService.createService(body) });
};

export const listServicesHandler: RequestHandler = async (req, res) => {
  const query = parseOrThrow(listServicesQuerySchema, req.query);
  res.status(200).json(pageResponse(await serviceService.listServices(getAuth(req), query)));
};

export const getServiceHandler: RequestHandler = async (req, res) => {
  const { serviceId } = parseOrThrow(serviceParamsSchema, req.params);
  res.status(200).json({ data: await serviceService.getService(getAuth(req), serviceId) });
};

export const updateServiceHandler: RequestHandler = async (req, res) => {
  const { serviceId } = parseOrThrow(serviceParamsSchema, req.params);
  const body = parseOrThrow(updateServiceBodySchema, req.body);
  res.status(200).json({ data: await serviceService.updateService(serviceId, body) });
};
