import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '../../generated/prisma/client.js';
import { appendAuditEvent } from '../../infra/audit/append-audit-event.js';
import { isUniqueViolation } from '../../infra/db/errors.js';
import { getPrisma, lockRowForUpdate, runInTransaction } from '../../infra/db/prisma.js';

export const GENERIC_SOURCE_TYPE = 'GENERIC';

export type SeverityMapping = Record<string, 'P0' | 'P1' | 'P2' | 'P3'>;

/** Read by SLICE-04; this slice only seeds it. */
export const DEFAULT_SEVERITY_MAPPING: SeverityMapping = {
  critical: 'P0',
  high: 'P1',
  warning: 'P2',
  info: 'P3',
};

export type SeedAlertSourceInput = {
  /** The seeded identifier: it is how the seed recognises an existing source. */
  id: string;
  name: string;
  signingSecret: string;
  severityMapping: SeverityMapping;
};

export type SeedAlertSourceResult = 'CREATED' | 'UPDATED' | 'UNCHANGED';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Names (sorted) of the configuration keys whose values differ. Values are never returned. */
export function changedConfigurationKeys(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(current), ...Object.keys(next)])]
    .filter((key) => !isDeepStrictEqual(current[key], next[key]))
    .sort();
}

async function updateExisting(input: SeedAlertSourceInput): Promise<SeedAlertSourceResult> {
  return runInTransaction(async (tx) => {
    if (!(await lockRowForUpdate(tx, 'AlertSource', input.id))) {
      throw new Error('Alert source disappeared during the seed');
    }
    const row = await tx.alertSource.findUniqueOrThrow({
      where: { id: input.id },
      select: { configuration: true },
    });

    const current = asRecord(row.configuration);
    const next = {
      ...current,
      signingSecret: input.signingSecret,
      severityMapping: input.severityMapping,
    };
    const changedKeys = changedConfigurationKeys(current, next);
    if (changedKeys.length === 0) return 'UNCHANGED';

    await tx.alertSource.update({
      where: { id: input.id },
      data: { configuration: next as Prisma.InputJsonObject, updatedAt: new Date() },
    });
    await appendAuditEvent(tx, {
      incidentId: null,
      eventType: 'ALERT_SOURCE_UPDATED',
      actorId: null,
      metadata: { alertSourceId: input.id, changedKeys },
    });
    return 'UPDATED';
  });
}

/**
 * Creates the alert source, or updates the configuration of the existing one (identified by
 * `input.id`). A changed configuration is audited in the same transaction as the update, with the
 * names of the changed keys only; creating a source and an unchanged re-run write no audit event.
 * The name is set on creation only, and the status is never touched.
 */
export async function seedAlertSource(input: SeedAlertSourceInput): Promise<SeedAlertSourceResult> {
  const db = getPrisma();
  const existing = await db.alertSource.findUnique({
    where: { id: input.id },
    select: { id: true },
  });

  if (!existing) {
    try {
      await db.alertSource.create({
        data: {
          id: input.id,
          name: input.name,
          sourceType: GENERIC_SOURCE_TYPE,
          configuration: {
            signingSecret: input.signingSecret,
            severityMapping: input.severityMapping,
          },
        },
      });
      return 'CREATED';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // a concurrent seed created it first
    }
  }
  return updateExisting(input);
}
