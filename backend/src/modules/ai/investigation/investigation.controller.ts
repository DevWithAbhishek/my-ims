import type { Request, RequestHandler, Response } from 'express';
import { BadRequestError } from '../../../shared/errors/AppError.js';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../../identity/index.js';
import { withDatabaseOutageMapping } from './investigation.outage.js';
import {
  incidentParamsSchema,
  investigationParamsSchema,
  listInvestigationsQuerySchema,
  readIdempotencyKey,
  requestQuerySchema,
} from './investigation.schema.js';
import * as service from './investigation.service.js';

/** N1 takes no body: any request that carries one is rejected. */
function assertNoBody(req: Request): void {
  const hasBody =
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
  if (hasBody) throw new BadRequestError('This endpoint accepts no request body');
}

const requestIdOf = (res: Response): string | undefined =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

export function createInvestigationHandlers(deps: service.InvestigationServiceDeps): {
  request: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
} {
  return {
    /**
     * N1. Order: authentication (middleware) → path id → team gate → no body/query → the
     * `Idempotency-Key` header → rate limit → idempotency and creation.
     */
    request: async (req, res) => {
      const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
      const auth = getAuth(req);
      await withDatabaseOutageMapping(() => service.assertCanAccessIncident(auth, incidentId));

      assertNoBody(req);
      parseOrThrow(requestQuerySchema, req.query);
      const key = readIdempotencyKey(req.header('idempotency-key'));

      await service.enforceRateLimit(auth, incidentId, requestIdOf(res), deps);
      const { created, investigation } = await withDatabaseOutageMapping(() =>
        service.createInvestigation(auth, incidentId, key, requestIdOf(res)),
      );
      res.status(created ? 202 : 200).json({ data: investigation });
    },

    list: async (req, res) => {
      const { incidentId } = parseOrThrow(incidentParamsSchema, req.params);
      const query = parseOrThrow(listInvestigationsQuerySchema, req.query);
      const page = await withDatabaseOutageMapping(() =>
        service.listInvestigations(getAuth(req), incidentId, query),
      );
      res.status(200).json({
        data: page.items,
        pagination: { limit: page.limit, offset: page.offset, hasMore: page.hasMore },
      });
    },

    get: async (req, res) => {
      const { incidentId, investigationId } = parseOrThrow(investigationParamsSchema, req.params);
      const investigation = await withDatabaseOutageMapping(() =>
        service.getInvestigation(getAuth(req), incidentId, investigationId),
      );
      res.status(200).json({ data: investigation });
    },
  };
}
