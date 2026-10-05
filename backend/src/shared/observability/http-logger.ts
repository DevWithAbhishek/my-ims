import type { Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './logger.js';

/**
 * Request-scoped logging (`req.log`). Only the method, path and status are serialized:
 * headers (Authorization), query strings and bodies are never logged.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (_req, res) => (res as Response).locals.requestId as string,
  customProps: (req) => ({ requestId: (req as Request).res?.locals.requestId as string }),
  autoLogging: { ignore: (req) => req.url === '/health' },
  serializers: {
    req: (req: Request) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
    res: (res: Response) => ({ statusCode: res.statusCode }),
  },
});
