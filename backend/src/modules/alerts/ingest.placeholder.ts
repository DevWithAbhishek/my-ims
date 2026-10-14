import { AppError } from '../../shared/errors/AppError.js';
import type { IngestHandler } from './webhook.types.js';

/**
 * Used until SLICE-04 provides ingestion: a request that passed the trust gate is answered
 * `501 NOT_IMPLEMENTED`, so a sender never believes alerts were accepted when nothing stored them.
 */
export const ingestNotImplemented: IngestHandler = () =>
  Promise.reject(
    new AppError({
      statusCode: 501,
      code: 'NOT_IMPLEMENTED',
      message: 'Alert ingestion is not available yet',
    }),
  );
