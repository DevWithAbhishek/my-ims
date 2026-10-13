import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../../identity/index.js';
import { incidentParamsSchema, timelineQuerySchema } from '../incident.schema.js';
import { withDatabaseOutageMapping } from '../incidents.common.js';
import * as timelineService from './timeline.service.js';

export const getTimelineHandler: RequestHandler = async (req, res) => {
  const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
  const query = parseOrThrow(timelineQuerySchema, req.query);
  const page = await withDatabaseOutageMapping(() =>
    timelineService.getTimeline(getAuth(req), incidentId, query),
  );
  res.status(200).json({
    data: page.items,
    pagination: { limit: page.limit, offset: page.offset, hasMore: page.hasMore },
  });
};
