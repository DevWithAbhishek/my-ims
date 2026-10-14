import type { RequestHandler } from 'express';
import { z } from 'zod';
import { parseOrThrow } from '../../shared/errors/zod.js';
import { getAuth } from '../identity/index.js';
import { getAlertDetail } from './alert.service.js';
import { withDatabaseOutageMapping } from './outage.js';

const alertParamsSchema = z.strictObject({ incidentId: z.uuid(), alertId: z.uuid() });

export const getAlertHandler: RequestHandler = async (req, res) => {
  const { incidentId, alertId } = parseOrThrow(alertParamsSchema, req.params);
  const alert = await withDatabaseOutageMapping(() =>
    getAlertDetail(getAuth(req), incidentId, alertId),
  );
  res.status(200).json({ data: alert });
};
