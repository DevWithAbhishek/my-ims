import { getInvestigationRetrievalConfig } from '../../../config/env.js';
import { isUniqueViolation } from '../../../infra/db/errors.js';
import { getPrisma, runInTransaction } from '../../../infra/db/prisma.js';
import { enqueueOutbox, OUTBOX_EVENT_TYPES } from '../../../infra/jobs/index.js';
import {
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} from '../../../shared/errors/AppError.js';
import { logger } from '../../../shared/observability/logger.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { assertSameTeam, requireTeam } from '../../identity/index.js';
import { writeBlockNotice } from './investigation.block-notice.js';
import { toInvestigationResponse } from './investigation.mapper.js';
import type { InvestigationRateLimiter } from './investigation.rate-limit.js';
import {
  findIncidentScope,
  findInvestigationByKey,
  findInvestigationDetail,
  findInvestigationPage,
  insertInvestigation,
} from './investigation.repository.js';
import type { ListInvestigationsQuery } from './investigation.schema.js';
import type { InvestigationResponse } from './investigation.types.js';

export type InvestigationServiceDeps = {
  limiter: InvestigationRateLimiter;
  now?: () => number;
};

function incidentNotFound(): NotFoundError {
  return new NotFoundError('Incident not found', 'INCIDENT_NOT_FOUND', [{ resource: 'incident' }]);
}

function investigationNotFound(): NotFoundError {
  return new NotFoundError('Investigation not found', 'INVESTIGATION_NOT_FOUND', [
    { resource: 'investigation' },
  ]);
}

/**
 * The gates of every investigation endpoint: the caller needs a team (`403 INVALID_ACTION`), the
 * incident must exist (`404`) and belong to that team (`403 TEAM_ACCESS_DENIED`). Any incident
 * status is allowed. The team always comes from the token.
 */
export async function assertCanAccessIncident(
  auth: AuthContext,
  incidentId: string,
): Promise<void> {
  requireTeam(auth);
  const scope = await findIncidentScope(getPrisma(), incidentId);
  if (scope === null) throw incidentNotFound();
  assertSameTeam(auth, scope.teamId);
}

/**
 * The N1 rate limit: every request is counted; a violation or a request that meets a block is
 * `429 RATE_LIMITED` with `Retry-After`. The Admin notice of a final-stage block is written here,
 * once per block window; a failed write is logged and retried by the next blocked request.
 */
export async function enforceRateLimit(
  auth: AuthContext,
  incidentId: string,
  requestId: string | undefined,
  deps: InvestigationServiceDeps,
): Promise<void> {
  const outcome = await deps.limiter.consume(auth.userId, (deps.now ?? Date.now)());
  if (outcome.kind === 'ALLOWED') return;

  if (outcome.notice !== null) {
    try {
      await writeBlockNotice({
        userId: auth.userId,
        teamId: requireTeam(auth),
        incidentId,
        ...(requestId === undefined ? {} : { requestId }),
        notice: outcome.notice,
      });
      await deps.limiter.acknowledgeNotice(auth.userId);
    } catch (err) {
      logger.error(
        { err, actorId: auth.userId, incidentId, requestId },
        'Could not write the investigation block notice',
      );
    }
  }
  throw new TooManyRequestsError(
    'Too many investigation requests; try again later',
    'RATE_LIMITED',
    Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)),
  );
}

export type RequestResult = { created: boolean; investigation: InvestigationResponse };

/** An existing row with this key: a replay for the same incident and user, else `409`. */
async function resolveExisting(
  auth: AuthContext,
  incidentId: string,
  idempotencyKey: string,
): Promise<InvestigationResponse | null> {
  const db = getPrisma();
  const existing = await findInvestigationByKey(db, idempotencyKey);
  if (existing === null) return null;
  if (existing.incidentId !== incidentId || existing.requestedById !== auth.userId) {
    throw new ConflictError(
      'The Idempotency-Key was already used for another request',
      'IDEMPOTENCY_KEY_REUSED',
    );
  }
  const row = await findInvestigationDetail(db, incidentId, existing.id);
  if (row === null) throw investigationNotFound();
  return toInvestigationResponse(row);
}

/**
 * N1: one transaction inserts the `REQUESTED` investigation (its `input` holds the retrieval
 * parameters only) and writes `INVESTIGATION_REQUESTED` to the outbox. The key is globally unique:
 * a replay returns the existing resource, and of simultaneous identical requests one creates.
 */
export async function createInvestigation(
  auth: AuthContext,
  incidentId: string,
  idempotencyKey: string,
  requestId: string | undefined,
): Promise<RequestResult> {
  const replay = await resolveExisting(auth, incidentId, idempotencyKey);
  if (replay !== null) return { created: false, investigation: replay };

  const input = { postmortemLimit: getInvestigationRetrievalConfig().postmortemLimit };
  try {
    const investigation = await runInTransaction(async (tx) => {
      const { id } = await insertInvestigation(tx, {
        idempotencyKey,
        requestedById: auth.userId,
        incidentId,
        input,
      });
      await enqueueOutbox(tx, {
        eventType: OUTBOX_EVENT_TYPES.INVESTIGATION_REQUESTED,
        aggregateType: 'INVESTIGATION',
        aggregateId: id,
        payload: {
          investigationId: id,
          incidentId,
          ...(requestId === undefined ? {} : { requestId }),
        },
      });
      const row = await findInvestigationDetail(tx, incidentId, id);
      return toInvestigationResponse(row!);
    });
    return { created: true, investigation };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await resolveExisting(auth, incidentId, idempotencyKey);
    if (winner === null) throw error;
    return { created: false, investigation: winner };
  }
}

export type InvestigationPage = {
  items: InvestigationResponse[];
  limit: number;
  offset: number;
  hasMore: boolean;
};

/** N2: every investigation of the incident for every role of its team; no brief, no evidence. */
export async function listInvestigations(
  auth: AuthContext,
  incidentId: string,
  query: ListInvestigationsQuery,
): Promise<InvestigationPage> {
  await assertCanAccessIncident(auth, incidentId);
  const rows = await findInvestigationPage(getPrisma(), incidentId, {
    sort: query.sort,
    offset: query.offset,
    take: query.limit + 1,
  });
  return {
    items: rows.slice(0, query.limit).map((row) => toInvestigationResponse(row)),
    limit: query.limit,
    offset: query.offset,
    hasMore: rows.length > query.limit,
  };
}

/** N3: brief and evidence when `COMPLETED`; another incident's investigation is `404`. */
export async function getInvestigation(
  auth: AuthContext,
  incidentId: string,
  investigationId: string,
): Promise<InvestigationResponse> {
  await assertCanAccessIncident(auth, incidentId);
  const row = await findInvestigationDetail(getPrisma(), incidentId, investigationId);
  if (row === null) throw investigationNotFound();
  return toInvestigationResponse(row);
}
