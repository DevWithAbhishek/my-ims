import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../../identity/index.js';
import { incidentParamsSchema } from '../incident.schema.js';
import { selectRow } from './incident-update.dispatcher.js';
import { updateIncidentBodySchema } from './incident-update.schema.js';

/** `PATCH /incidents/:incidentId`: validation first (400/422), then the one matching action. */
export const updateIncidentHandler: RequestHandler = async (req, res) => {
  const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
  const body = parseOrThrow(updateIncidentBodySchema, req.body);
  const row = selectRow(body);
  const result = await row.handle({ auth: getAuth(req), incidentId, body });
  res.status(result.status).json({ data: result.data });
};
