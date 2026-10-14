import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { PayloadTooLargeError } from '../../shared/errors/AppError.js';
import { WEBHOOK } from './webhook.config.js';

/** `res.locals` key under which the request's raw bytes are stored. */
export const RAW_BODY_KEY = 'rawBody';

function rejectOversize(req: Request, res: Response, next: NextFunction): void {
  // Stop buffering: whatever is still arriving is read and discarded, then the connection closes.
  res.setHeader('Connection', 'close');
  req.resume();
  next(new PayloadTooLargeError('The request body exceeds the 1 MB limit', 'PAYLOAD_TOO_LARGE'));
}

/**
 * Captures the raw request bytes (the signature is computed over them, so the body must not be
 * parsed or re-serialized) without ever holding more than `maxBytes`. Mounted before any JSON
 * parser. An oversize body is `413 PAYLOAD_TOO_LARGE`, decided from `Content-Length` when present.
 */
export function captureRawBody(maxBytes: number = WEBHOOK.maxBodyBytes): RequestHandler {
  return (req, res, next) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      rejectOversize(req, res, next);
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let finished = false;

    const stopListening = () => {
      finished = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        stopListening();
        chunks.length = 0;
        rejectOversize(req, res, next);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      stopListening();
      res.locals[RAW_BODY_KEY] = Buffer.concat(chunks, received);
      next();
    };
    const onError = (error: Error) => {
      stopListening();
      next(error);
    };
    const onClose = () => {
      if (!finished) stopListening(); // the client went away; nobody is left to answer
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  };
}
