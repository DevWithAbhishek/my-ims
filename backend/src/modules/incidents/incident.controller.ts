import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../shared/errors/zod.js';
import { getAuth } from '../identity/index.js';
import { incidentParamsSchema, listIncidentsQuerySchema } from './incident.schema.js';
import * as incidentService from './incident.service.js';
import { withDatabaseOutageMapping } from './incidents.common.js';

export const listIncidentsHandler: RequestHandler = async (req, res) => {
  const query = parseOrThrow(listIncidentsQuerySchema, req.query);
  const page = await withDatabaseOutageMapping(() =>
    incidentService.listIncidents(getAuth(req), query),
  );
  res.status(200).json({
    data: page.items,
    pagination: { nextCursor: page.nextCursor, hasMore: page.hasMore },
  });
};

export const getIncidentHandler: RequestHandler = async (req, res) => {
  const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
  const incident = await withDatabaseOutageMapping(() =>
    incidentService.getIncident(getAuth(req), incidentId),
  );
  res.status(200).json({ data: incident });
};
