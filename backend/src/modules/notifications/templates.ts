import type { NotificationEventType } from './catalog.js';
import { NOTIFICATION_DETAIL_LABELS, type NotificationDetails } from './details.js';
import type { TemplateFacts } from './notification.repository.js';

type Template = { label: string; summary: string };

/** One template per event type: a short label (subject) and a one-line summary (body). */
export const TEMPLATES: Record<NotificationEventType, Template> = {
  INCIDENT_CREATED: { label: 'Incident created', summary: 'A new incident was created.' },
  ASSIGNED: { label: 'Incident assigned', summary: 'The incident was assigned.' },
  REASSIGNED: { label: 'Incident reassigned', summary: 'The assignee of the incident changed.' },
  OPEN: { label: 'Incident back to OPEN', summary: 'The incident returned to OPEN.' },
  ACKNOWLEDGED: { label: 'Incident acknowledged', summary: 'The incident was acknowledged.' },
  SEVERITY_CONFIRMED: {
    label: 'Severity confirmed',
    summary: 'The severity of the incident was confirmed.',
  },
  SOURCE_ALERT_RESOLVED: {
    label: 'Source alert resolved',
    summary: 'The alert source reported that its alert is resolved.',
  },
  RESOLVED: { label: 'Incident resolved', summary: 'The incident was resolved.' },
  CLOSED: { label: 'Incident closed', summary: 'The incident was closed.' },
  SLA_WARNING: {
    label: 'SLA warning',
    summary: 'The incident is close to breaching its SLA.',
  },
  RESPONSE_BREACH: {
    label: 'Response SLA breached',
    summary: 'The response SLA of the incident was breached.',
  },
  RESOLUTION_BREACH: {
    label: 'Resolution SLA breached',
    summary: 'The resolution SLA of the incident was breached.',
  },
  ESCALATED_L1: {
    label: 'Escalated to level 1',
    summary: 'The incident was escalated to level 1.',
  },
  ESCALATED_L2: {
    label: 'Escalated to level 2',
    summary: 'The incident was escalated to level 2.',
  },
  ESCALATED_L3: {
    label: 'Escalated to level 3',
    summary: 'The incident was escalated to level 3.',
  },
  ESCALATED_L4: {
    label: 'Escalated to level 4',
    summary: 'The incident was escalated to level 4.',
  },
  ESCALATION_FAILED: {
    label: 'Escalation failed',
    summary: 'The incident could not be escalated.',
  },
  AI_TRIAGE_COMPLETED: {
    label: 'AI triage completed',
    summary: 'The AI triage of the incident is available.',
  },
  POSTMORTEM_GENERATED: {
    label: 'Postmortem draft generated',
    summary: 'A postmortem draft was generated for the incident.',
  },
  POSTMORTEM_REVIEWED: {
    label: 'Postmortem reviewed',
    summary: 'The postmortem of the incident was reviewed.',
  },
  POSTMORTEM_GENERATION_FAILED: {
    label: 'Postmortem generation failed',
    summary: 'The postmortem draft could not be generated for the incident.',
  },
  AI_INVESTIGATION_COMPLETED: {
    label: 'AI investigation completed',
    summary: 'The requested AI investigation of the incident is available.',
  },
  TEAM_UPDATED: { label: 'Team updated', summary: 'Your team was updated.' },
  TEAM_DEACTIVATED: { label: 'Team deactivated', summary: 'Your team was deactivated.' },
  SERVICE_UPDATED: { label: 'Service updated', summary: 'A service of your team was updated.' },
  SERVICE_DEACTIVATED: {
    label: 'Service deactivated',
    summary: 'A service of your team was deactivated.',
  },
  ESCALATION_POLICY_UPDATED: {
    label: 'Escalation policy updated',
    summary: 'The escalation policy of a service of your team was updated.',
  },
  ALERT_SOURCE_BLOCKED: {
    label: 'Alert source blocked',
    summary: 'An alert source exceeded its rate limit repeatedly and was blocked.',
  },
  INVESTIGATION_REQUEST_BLOCKED: {
    label: 'Investigation requests blocked',
    summary: 'Investigation requests were blocked after exceeding the limit.',
  },
};

export type RenderedMessage = { subject: string; text: string };

/** Header-safe single line: no control characters, collapsed whitespace, bounded length. */
function oneLine(value: string, max: number): string {
  const printable = [...value].map((ch) => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || code === 0x7f ? ' ' : ch;
  });
  const cleaned = printable.join('').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * Renders the message for one event. It names only what the facts hold (titles and names, never
 * addresses, ids of users or credentials) and carries no links.
 */
export function renderMessage(
  eventType: NotificationEventType,
  facts: TemplateFacts,
  details: NotificationDetails = {},
): RenderedMessage {
  const template = TEMPLATES[eventType];
  const subject = facts.incidentTitle
    ? `[IMS] ${template.label}: ${oneLine(facts.incidentTitle, 150)}`
    : `[IMS] ${template.label}`;

  const lines = [template.summary, ''];
  const detail = (label: string, value: string | undefined) => {
    if (value) lines.push(`${label}: ${oneLine(value, 300)}`);
  };
  detail('Incident', facts.incidentTitle);
  detail('Severity', facts.severity);
  detail('Status', facts.status);
  detail('Service', facts.serviceName);
  detail('Team', facts.teamName);
  detail('Alert source', facts.alertSourceName);
  for (const [key, label] of Object.entries(NOTIFICATION_DETAIL_LABELS)) {
    const value = details[key as keyof NotificationDetails];
    if (value !== undefined) detail(label, String(value));
  }
  return { subject, text: lines.join('\n').trimEnd() + '\n' };
}
