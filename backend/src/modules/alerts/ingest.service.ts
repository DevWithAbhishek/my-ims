import { appendAuditEvent } from '../../infra/audit/append-audit-event.js';
import { isUniqueViolation } from '../../infra/db/errors.js';
import { runInTransaction, type TransactionClient } from '../../infra/db/prisma.js';
import { enqueueOutbox, OUTBOX_EVENT_TYPES } from '../../infra/jobs/index.js';
import { logger } from '../../shared/observability/logger.js';
import { getServiceConfig, type ServiceConfig } from '../appService/index.js';
import { createIncident } from '../incidents/index.js';
import { normalizeAlert, type NormalizedAlert } from './alert-input.js';
import {
  findAlertByActiveKey,
  findLatestAlertByIdentity,
  insertAlert,
  markSourceResolved,
} from './alert.repository.js';
import { resolveIdentity, type AlertIdentity } from './identity.js';
import { deriveIncidentText } from './incident-text.js';
import {
  rejected,
  type AlertIngestResponse,
  type AlertIngestResult,
  type ItemOutcome,
} from './ingest.types.js';
import { mapDatabaseOutage } from './outage.js';
import { resolveInitialSeverity } from './severity.js';
import type { IngestHandler, VerifiedAlertContext } from './webhook.types.js';

export type IngestDeps = {
  getServiceConfig: (serviceId: string) => Promise<ServiceConfig | null>;
  now: () => Date;
};

/** Everything one alert needs once it passed validation, service and identity checks. */
type PreparedAlert = {
  alert: NormalizedAlert;
  identity: AlertIdentity;
  service: ServiceConfig;
  originalPayload: unknown;
  context: VerifiedAlertContext;
};

/**
 * Step 7 of the webhook pipeline. Alerts are handled in request order, each in its own transaction,
 * so one rejection never affects its siblings and two alerts with the same identity in one batch
 * resolve deterministically (the first creates, the second is a duplicate).
 */
export function createIngestHandler(overrides: Partial<IngestDeps> = {}): IngestHandler {
  const deps: IngestDeps = { getServiceConfig, now: () => new Date(), ...overrides };

  return async (context) => {
    const rateLimited = new Set(context.rateLimitedIndices);
    const services = new Map<string, ServiceConfig | null>();
    const results: AlertIngestResult[] = [];

    try {
      for (const [index, item] of context.items.entries()) {
        const outcome = rateLimited.has(index)
          ? rejected('RATE_LIMITED')
          : await processAlert(item, context, services, deps);
        results.push({ index, ...outcome });
      }
    } catch (error) {
      throw mapDatabaseOutage(error);
    }

    logger.info(
      {
        requestId: context.requestId,
        alertSourceId: context.alertSource.id,
        outcomes: countOutcomes(results),
      },
      'alert batch processed',
    );

    const everyAlertRejected = results.length > 0 && results.every((r) => r.outcome === 'REJECTED');
    const body: AlertIngestResponse = { data: { results } };
    return { statusCode: everyAlertRejected ? 400 : 200, body };
  };
}

async function processAlert(
  item: unknown,
  context: VerifiedAlertContext,
  services: Map<string, ServiceConfig | null>,
  deps: IngestDeps,
): Promise<ItemOutcome> {
  const normalized = normalizeAlert(item);
  if (!normalized.ok) return rejected('ALERT_INVALID', normalized.fields.join(', '));
  const { alert } = normalized;

  const service = await lookupService(alert.serviceId, services, deps);
  if (service === null) return rejected('UNKNOWN_SERVICE');
  if (service.status !== 'ACTIVE') return rejected('SERVICE_DEACTIVATED');

  const identity = resolveIdentity(alert);
  if (identity === null) return rejected('IDENTITY_UNRESOLVABLE');

  const prepared: PreparedAlert = { alert, identity, service, originalPayload: item, context };
  return alert.status === 'RESOLVED'
    ? runInTransaction((tx) => recordSourceResolved(tx, prepared, deps))
    : ingestFiring(prepared);
}

async function lookupService(
  serviceId: string,
  cache: Map<string, ServiceConfig | null>,
  deps: IngestDeps,
): Promise<ServiceConfig | null> {
  if (!cache.has(serviceId)) cache.set(serviceId, await deps.getServiceConfig(serviceId));
  return cache.get(serviceId) ?? null;
}

/**
 * A `FIRING` delivery. The database unique key `(alertSourceId, activeIdentityKey)` decides
 * concurrent deliveries: the loser's transaction is rolled back by the violation and is handled
 * again in a new transaction, where it finds the winner's alert and becomes a `DUPLICATE`.
 */
async function ingestFiring(prepared: PreparedAlert): Promise<ItemOutcome> {
  try {
    return await runInTransaction((tx) => createOrDuplicate(tx, prepared));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return runInTransaction((tx) => createOrDuplicate(tx, prepared));
  }
}

async function createOrDuplicate(tx: TransactionClient, p: PreparedAlert): Promise<ItemOutcome> {
  const alertSourceId = p.context.alertSource.id;

  const existing = await findAlertByActiveKey(tx, alertSourceId, p.identity.activeIdentityKey);
  if (existing?.incidentId) {
    await appendAuditEvent(tx, {
      incidentId: existing.incidentId,
      eventType: 'ALERT_DUPLICATE',
      actorId: null,
      metadata: { alertSourceId },
    });
    return {
      outcome: 'DUPLICATE',
      alertId: existing.id,
      incidentId: existing.incidentId,
      error: null,
    };
  }

  // Evaluated only when an incident would be created, after identity and deduplication.
  const text = deriveIncidentText(p.alert);
  if (text === null) return rejected('ALERT_INVALID', 'name or summary is required');

  const severity = resolveInitialSeverity(
    p.context.alertSource.configuration,
    p.alert.sourceSeverity,
    p.service.defaultSeverity,
  );
  const incident = await createIncident(tx, {
    ...text,
    severity,
    teamId: p.service.teamId,
    affectedServiceId: p.service.id,
  });
  const alert = await insertAlert(tx, {
    alert: p.alert,
    identity: p.identity,
    initialSeverity: severity,
    originalPayload: p.originalPayload,
    alertSourceId,
    incidentId: incident.id,
  });

  await appendAuditEvent(tx, {
    incidentId: incident.id,
    eventType: 'INCIDENT_CREATED',
    actorId: null,
    metadata: { incidentId: incident.id },
  });
  await appendAuditEvent(tx, {
    incidentId: incident.id,
    eventType: 'ALERT_RECEIVED',
    actorId: null,
    metadata: { alertId: alert.id },
  });
  await enqueueOutbox(tx, {
    eventType: OUTBOX_EVENT_TYPES.ALERT_TRIAGE_REQUESTED,
    aggregateType: 'ALERT',
    aggregateId: alert.id,
    payload: { alertId: alert.id, incidentId: incident.id, requestId: p.context.requestId },
  });
  await enqueueOutbox(tx, {
    eventType: OUTBOX_EVENT_TYPES.SLA_EVALUATION_REQUESTED,
    aggregateType: 'INCIDENT',
    aggregateId: incident.id,
    payload: { incidentId: incident.id, requestId: p.context.requestId },
  });

  return { outcome: 'INCIDENT_CREATED', alertId: alert.id, incidentId: incident.id, error: null };
}

/**
 * A source-`RESOLVED` delivery never creates an incident: it records the source's state on the
 * most recent alert with the same identity. Incident status and the active key are unchanged.
 */
async function recordSourceResolved(
  tx: TransactionClient,
  p: PreparedAlert,
  deps: IngestDeps,
): Promise<ItemOutcome> {
  const latest = await findLatestAlertByIdentity(tx, p.context.alertSource.id, p.identity);
  if (latest?.incidentId == null) {
    return rejected('ALERT_INVALID', 'no alert with this identity to resolve');
  }

  const changed = await markSourceResolved(tx, latest.id, p.alert.endedAt ?? deps.now());
  if (changed) {
    await appendAuditEvent(tx, {
      incidentId: latest.incidentId,
      eventType: 'SOURCE_ALERT_RESOLVED',
      actorId: null,
      metadata: { alertId: latest.id },
    });
  }
  return {
    outcome: 'SOURCE_RESOLVED_RECORDED',
    alertId: latest.id,
    incidentId: latest.incidentId,
    error: null,
  };
}

function countOutcomes(results: AlertIngestResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { outcome } of results) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}
