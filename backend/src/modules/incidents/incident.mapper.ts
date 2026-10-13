import { buildAiTriage, type TriageRecord } from './ai-triage.js';
import type { IncidentDetailRow, IncidentListRow } from './incident.repository.js';
import type {
  AlertSummary,
  IncidentDetailResponse,
  IncidentListItem,
  IncidentResponse,
  UserSummary,
} from './incidents.types.js';
import { buildSlaStatus, type SlaThresholds } from './sla.js';

type ServiceSlaColumns = IncidentListRow['affectedService'];

export function toUserSummary(user: { id: string; name: string } | null): UserSummary | null {
  return user === null ? null : { id: user.id, name: user.name };
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** The service's flat `P0ResponseSlaMinutes` … columns as per-severity thresholds. */
export function toSlaThresholds(service: ServiceSlaColumns): SlaThresholds {
  return {
    P0: {
      responseMinutes: service.P0ResponseSlaMinutes,
      resolutionMinutes: service.P0ResolutionSlaMinutes,
    },
    P1: {
      responseMinutes: service.P1ResponseSlaMinutes,
      resolutionMinutes: service.P1ResolutionSlaMinutes,
    },
    P2: {
      responseMinutes: service.P2ResponseSlaMinutes,
      resolutionMinutes: service.P2ResolutionSlaMinutes,
    },
    P3: {
      responseMinutes: service.P3ResponseSlaMinutes,
      resolutionMinutes: service.P3ResolutionSlaMinutes,
    },
  };
}

export function toListItem(row: IncidentListRow, now: Date): IncidentListItem {
  const sla = buildSlaStatus(
    {
      severity: row.severity,
      createdAt: row.createdAt,
      acknowledgedAt: row.acknowledgedTimestamp,
      resolvedAt: row.resolvedTimestamp,
      thresholds: toSlaThresholds(row.affectedService),
    },
    now,
  );
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    service: { id: row.affectedService.id, name: row.affectedService.name },
    currentAssignee: toUserSummary(row.currentAssignee),
    createdAt: row.createdAt.toISOString(),
    slaState: { response: sla.response.state, resolution: sla.resolution.state },
  };
}

/** The sort value of a feed row as text, for the cursor. */
export function sortValueOf(
  row: IncidentListRow,
  orderBy: 'createdAt' | 'severity' | 'status' | 'title' | 'affectedServiceId' | 'teamId',
): string {
  return orderBy === 'createdAt' ? row.createdAt.toISOString() : row[orderBy];
}

export function toIncidentResponse(row: IncidentDetailRow, now: Date): IncidentResponse {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    severity: row.severity,
    service: { id: row.affectedService.id, name: row.affectedService.name },
    teamId: row.teamId,
    currentAssignee: toUserSummary(row.currentAssignee),
    acknowledgedBy: toUserSummary(row.acknowledgedBy),
    severityConfirmedBy: toUserSummary(row.severityConfirmedBy),
    resolvedBy: toUserSummary(row.resolvedBy),
    closedBy: toUserSummary(row.closedBy),
    resolutionSummary: row.resolutionSummary,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: iso(row.acknowledgedTimestamp),
    severityConfirmedAt: iso(row.severityConfirmTimestamp),
    resolvedAt: iso(row.resolvedTimestamp),
    closedAt: iso(row.closedTimestamp),
    sla: buildSlaStatus(
      {
        severity: row.severity,
        createdAt: row.createdAt,
        acknowledgedAt: row.acknowledgedTimestamp,
        resolvedAt: row.resolvedTimestamp,
        thresholds: toSlaThresholds(row.affectedService),
      },
      now,
    ),
  };
}

export function toAlertSummary(alert: IncidentDetailRow['alert'][number]): AlertSummary {
  return {
    id: alert.id,
    name: alert.name,
    environment: alert.environment,
    sourceSeverity: alert.sourceSeverity,
    initialSeverity: alert.initialSeverity,
    sourceStatus: alert.sourceStatus,
    startedAt: alert.startedTimestamp.toISOString(),
    endedAt: iso(alert.endedTimestamp),
    sourceUrl: alert.sourceUrl,
    alertSource: { id: alert.alertSource.id, name: alert.alertSource.name },
  };
}

export function toIncidentDetail(
  row: IncidentDetailRow,
  triage: TriageRecord | null,
  now: Date,
): IncidentDetailResponse {
  return {
    ...toIncidentResponse(row, now),
    alerts: row.alert.map(toAlertSummary),
    aiTriage: buildAiTriage(triage),
  };
}
