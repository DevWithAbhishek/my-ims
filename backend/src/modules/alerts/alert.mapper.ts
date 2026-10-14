import type { AlertDetailRow } from './alert.repository.js';
import type { AlertDetailResponse } from './alerts.types.js';

/** Schema names to API names (`startedTimestamp` → `startedAt`, `endedTimestamp` → `endedAt`). */
export function toAlertDetail(row: AlertDetailRow): AlertDetailResponse {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    sourceSeverity: row.sourceSeverity,
    initialSeverity: row.initialSeverity,
    sourceStatus: row.sourceStatus,
    startedAt: row.startedTimestamp.toISOString(),
    endedAt: row.endedTimestamp?.toISOString() ?? null,
    sourceUrl: row.sourceUrl,
    alertSource: { id: row.alertSource.id, name: row.alertSource.name },
    sourceEventId: row.sourceEventId,
    sourceFingerprint: row.sourceFingerprint,
    summary: row.summary,
    description: row.description,
    labels: row.labels,
    additionalDetails: row.additionalDetails,
    originalPayload: row.originalPayload,
  };
}
