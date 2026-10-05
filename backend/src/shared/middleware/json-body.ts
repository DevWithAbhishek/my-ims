import type { RequestHandler } from 'express';
import { BadRequestError } from '../errors/AppError.js';

/** Rejects a request body that is not JSON (`400 BAD_REQUEST`). Requests without a body pass. */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  const hasBody =
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
  if (hasBody && !req.is('application/json')) {
    throw new BadRequestError('Content-Type must be application/json');
  }
  next();
};
