import { isDatabaseUnavailable } from '../../infra/db/errors.js';
import { TooManyRequestsError } from '../../shared/errors/AppError.js';
import { childLogger } from '../../shared/observability/logger.js';
import type { BlockedNotice } from './admin-notice.js';
import { countAlerts, parseJsonBody, validateEnvelope } from './envelope.js';
import type { RateLimiter } from './rate-limiter.js';
import type { ReplayStore } from './replay.store.js';
import { isTimestampFresh, parseSignatureHeader, verifySignature } from './signature.js';
import type { AlertSourceRecord } from './source.repository.js';
import {
  dependencyUnavailable,
  replayDetected,
  requestStale,
  sourceAuthFailed,
} from './webhook.errors.js';
import type { VerifiedAlertContext, VerifiedAlertSource } from './webhook.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TrustGateDeps = {
  findSource: (id: string) => Promise<AlertSourceRecord | null>;
  replayStore: ReplayStore;
  rateLimiter: RateLimiter;
  notifyBlocked: (notice: BlockedNotice) => Promise<void>;
  now: () => number;
};

export type TrustGateInput = {
  alertSourceId: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  contentType: string | undefined;
  /** Step 1 (the size limit) was already enforced while capturing these bytes. */
  rawBody: Buffer;
  requestId: string;
};

function asConfiguration(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function loadSource(deps: TrustGateDeps, id: string): Promise<AlertSourceRecord | null> {
  try {
    return await deps.findSource(id);
  } catch (error) {
    if (isDatabaseUnavailable(error)) throw dependencyUnavailable();
    throw error;
  }
}

/** Step 2: the source exists, is `ACTIVE` and the signature is valid: one failure for all of it. */
async function authenticateSource(
  deps: TrustGateDeps,
  input: TrustGateInput,
): Promise<{ source: VerifiedAlertSource; signatureHex: string }> {
  const record = UUID.test(input.alertSourceId)
    ? await loadSource(deps, input.alertSourceId)
    : null;
  const active = record?.status === 'ACTIVE' ? record : null;
  const configuration = asConfiguration(active?.configuration);
  const secret =
    typeof configuration.signingSecret === 'string' && configuration.signingSecret !== ''
      ? configuration.signingSecret
      : null;

  const valid = verifySignature({
    secret,
    timestampHeader: input.timestampHeader,
    signatureHeader: input.signatureHeader,
    rawBody: input.rawBody,
  });
  const signature = parseSignatureHeader(input.signatureHeader);
  if (!valid || !active || !signature) throw sourceAuthFailed();

  return {
    source: {
      id: active.id,
      name: active.name,
      sourceType: active.sourceType,
      configuration,
    },
    signatureHex: signature.hex,
  };
}

function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** Writes the Admin notice of a block; a failure is logged and leaves the notice pending. */
async function sendBlockedNotice(
  deps: TrustGateDeps,
  notice: BlockedNotice,
  log: ReturnType<typeof childLogger>,
): Promise<void> {
  try {
    await deps.notifyBlocked(notice);
  } catch (err) {
    log.error({ err, alertSourceId: notice.alertSourceId }, 'Blocked-source notice not written');
    return;
  }
  try {
    await deps.rateLimiter.acknowledgeNotice(notice.alertSourceId);
  } catch (err) {
    log.warn({ err, alertSourceId: notice.alertSourceId }, 'Blocked-source notice not recorded');
  }
}

/** A block whose notice failed to be written is retried by the next request that meets it. */
async function retryPendingNotice(
  deps: TrustGateDeps,
  alertSourceId: string,
  requestId: string,
  log: ReturnType<typeof childLogger>,
): Promise<void> {
  let attemptCount: number | null;
  try {
    attemptCount = await deps.rateLimiter.claimPendingNotice(alertSourceId);
  } catch (err) {
    log.warn({ err, alertSourceId }, 'Pending blocked-source notice could not be checked');
    return;
  }
  if (attemptCount !== null) {
    await sendBlockedNotice(deps, { alertSourceId, attemptCount, requestId }, log);
  }
}

/** Step 5. Returns how many of the request's `alertCount` alerts fit; throws `429` when none do. */
async function applyRateLimit(
  deps: TrustGateDeps,
  alertSourceId: string,
  alertCount: number,
  requestId: string,
  log: ReturnType<typeof childLogger>,
): Promise<number> {
  const outcome = await deps.rateLimiter.consume(alertSourceId, alertCount);
  if (outcome.kind === 'ALLOWED') return outcome.allowed;

  if (outcome.kind === 'VIOLATION') {
    log.warn(
      { alertSourceId, attemptCount: outcome.attemptCount, finalStage: outcome.finalStage },
      'Alert source rate limit exceeded; source blocked',
    );
    if (outcome.finalStage) {
      await sendBlockedNotice(
        deps,
        { alertSourceId, attemptCount: outcome.attemptCount, requestId },
        log,
      );
    }
  } else {
    await retryPendingNotice(deps, alertSourceId, requestId, log);
  }

  throw new TooManyRequestsError(
    'The alert source is rate limited',
    'RATE_LIMITED',
    retryAfterSeconds(outcome.retryAfterMs),
  );
}

/**
 * Runs steps 2–6 of the webhook pipeline in order; the first failing step decides the response.
 * Nothing here persists an alert. Redis-backed steps (4 and 5) fail closed.
 */
export async function runTrustGate(
  input: TrustGateInput,
  deps: TrustGateDeps,
): Promise<VerifiedAlertContext> {
  const log = childLogger({ requestId: input.requestId });

  const { source, signatureHex } = await authenticateSource(deps, input);

  if (!isTimestampFresh(input.timestampHeader ?? '', deps.now())) throw requestStale();

  if (!(await deps.replayStore.markSeen(source.id, signatureHex))) throw replayDetected();

  const body = parseJsonBody(input.rawBody);
  const alertCount = countAlerts(body);
  const allowed = await applyRateLimit(deps, source.id, alertCount, input.requestId, log);

  const items = validateEnvelope(input.contentType, body);

  return {
    alertSource: source,
    items,
    rateLimitedIndices: Array.from({ length: items.length - allowed }, (_, i) => allowed + i),
    requestId: input.requestId,
  };
}
