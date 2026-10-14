import type { RequestHandler } from 'express';
import { RAW_BODY_KEY } from './raw-body.js';
import { runTrustGate, type TrustGateDeps } from './trust-gate.js';
import type { IngestHandler } from './webhook.types.js';

export type WebhookDeps = TrustGateDeps & { ingest: IngestHandler };

/** W1: the trust gate (steps 1–6), then the verified context goes to ingestion. */
export function createWebhookHandler(deps: WebhookDeps): RequestHandler {
  return async (req, res) => {
    const context = await runTrustGate(
      {
        alertSourceId: String(req.params.alertSourceId),
        signatureHeader: req.get('x-signature'),
        timestampHeader: req.get('x-timestamp'),
        contentType: req.get('content-type'),
        rawBody: res.locals[RAW_BODY_KEY] as Buffer,
        requestId: res.locals.requestId as string,
      },
      deps,
    );
    const { statusCode, body } = await deps.ingest(context);
    res.status(statusCode).json(body);
  };
}
