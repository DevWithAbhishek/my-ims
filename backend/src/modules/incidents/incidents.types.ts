import type {
  AlertSourceStatus,
  IncidentSeverity,
  IncidentStates,
} from '../../generated/prisma/enums.js';

export type Severity = IncidentSeverity;
export type IncidentStatus = IncidentStates;

export type UserSummary = { id: string; name: string };
export type ServiceSummary = { id: string; name: string };

export type SlaState = 'ON_TRACK' | 'WARNING' | 'BREACHED' | 'MET';

export type SlaClock = {
  thresholdMinutes: number;
  deadlineAt: string;
  state: SlaState;
  metAt: string | null;
};

/** Computed at read time, never stored. */
export type SlaStatus = { applicableSeverity: Severity; response: SlaClock; resolution: SlaClock };

export type IncidentListItem = {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: Severity;
  service: ServiceSummary;
  currentAssignee: UserSummary | null;
  createdAt: string;
  slaState: { response: SlaState; resolution: SlaState };
};

export type IncidentResponse = {
  id: string;
  title: string;
  description: string;
  status: IncidentStatus;
  severity: Severity;
  service: ServiceSummary;
  teamId: string;
  currentAssignee: UserSummary | null;
  acknowledgedBy: UserSummary | null;
  severityConfirmedBy: UserSummary | null;
  resolvedBy: UserSummary | null;
  closedBy: UserSummary | null;
  resolutionSummary: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  severityConfirmedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  sla: SlaStatus;
};

export type AlertSummary = {
  id: string;
  name: string | null;
  environment: string;
  sourceSeverity: string | null;
  initialSeverity: Severity | null;
  sourceStatus: AlertSourceStatus;
  startedAt: string;
  endedAt: string | null;
  sourceUrl: string | null;
  alertSource: { id: string; name: string };
};

export type AiTriageStatus = 'PENDING' | 'COMPLETED' | 'UNAVAILABLE';

export type AiTriageEvidence = { type: string; reference: string; excerpt: string };

/** Advisory only; it never changes incident state. */
export type AiTriage = {
  status: AiTriageStatus;
  category: string | null;
  suggestedSeverity: Severity | null;
  confidence: number | null;
  evidence: AiTriageEvidence[];
  reasoningSummary: string | null;
  model: string | null;
  modelVersion: string | null;
  generatedAt: string | null;
};

export type IncidentDetailResponse = IncidentResponse & {
  alerts: AlertSummary[];
  aiTriage: AiTriage;
};

export type CommentResponse = {
  id: string;
  title: string | null;
  body: string;
  author: UserSummary;
  createdAt: string;
};

/** The 22 audit event types the timeline exposes; the 8 administrative ones are never returned. */
export const INCIDENT_EVENT_TYPES = [
  'ALERT_RECEIVED',
  'ALERT_DUPLICATE',
  'AI_TRIAGE_COMPLETED',
  'INCIDENT_CREATED',
  'ASSIGNED',
  'REASSIGNED',
  'OPEN',
  'ACKNOWLEDGED',
  'SEVERITY_CONFIRMED',
  'COMMENT_ADDED',
  'SLA_WARNING',
  'ESCALATED_L1',
  'ESCALATED_L2',
  'ESCALATED_L3',
  'ESCALATED_L4',
  'SOURCE_ALERT_RESOLVED',
  'RESOLVED',
  'NOTIFIED',
  'POSTMORTEM_GENERATED',
  'POSTMORTEM_REVIEWED',
  'AI_INVESTIGATION_COMPLETED',
  'CLOSED',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

export type TimelineItem = {
  id: string;
  eventType: IncidentEventType;
  /** `null` = system or worker. */
  actor: UserSummary | null;
  details: Record<string, unknown>;
  createdAt: string;
};
