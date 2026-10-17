import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../../identity/index.js';
import { incidentParamsSchema } from '../incident.schema.js';
import { selectPostmortemRow } from './postmortem.dispatcher.js';
import { createPostmortemBodySchema, updatePostmortemBodySchema } from './postmortem.schema.js';
import { createManualPostmortem, getPostmortem } from './postmortem.service.js';

/** P1 `GET /incidents/:incidentId/postmortem`. */
export const getPostmortemHandler: RequestHandler = async (req, res) => {
  const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
  res.status(200).json({ data: await getPostmortem(getAuth(req), incidentId) });
};

/** P2/P3/P4 `PATCH`: validation first (400/422), then the one matching action. */
export const updatePostmortemHandler: RequestHandler = async (req, res) => {
  const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
  const body = parseOrThrow(updatePostmortemBodySchema, req.body);
  const row = selectPostmortemRow(body);
  const data = await row.handle({
    auth: getAuth(req),
    incidentId,
    body,
    requestId: res.locals.requestId as string,
  });
  res.status(200).json({ data });
};

/** P5 `POST`: `201` with the closed incident's postmortem. */
export const createPostmortemHandler: RequestHandler = async (req, res) => {
  const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
  const body = parseOrThrow(createPostmortemBodySchema, req.body);
  const data = await createManualPostmortem(
    getAuth(req),
    incidentId,
    body,
    res.locals.requestId as string,
  );
  res.status(201).json({ data });
};
