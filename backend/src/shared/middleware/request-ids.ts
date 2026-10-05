import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const requestIdHeader = 'x-request-id';

const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function requestMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(requestIdHeader);
  const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();

  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
