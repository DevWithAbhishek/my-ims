import { NOTIFICATION_CATALOG, type NotificationEventType } from './catalog';
import { renderMessage } from './templates';

describe('renderMessage', () => {
  it('renders every event type without facts', () => {
    for (const event of Object.keys(NOTIFICATION_CATALOG) as NotificationEventType[]) {
      const { subject, text } = renderMessage(event, {});
      expect(subject.startsWith('[IMS] ')).toBe(true);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('names the incident, severity, status and service', () => {
    const { subject, text } = renderMessage('ACKNOWLEDGED', {
      incidentTitle: 'Checkout down',
      severity: 'P1',
      status: 'ACKNOWLEDGED',
      serviceName: 'payments',
    });
    expect(subject).toBe('[IMS] Incident acknowledged: Checkout down');
    expect(text).toContain('Incident: Checkout down');
    expect(text).toContain('Severity: P1');
    expect(text).toContain('Status: ACKNOWLEDGED');
    expect(text).toContain('Service: payments');
  });

  it('keeps the subject on one line (no header injection) and bounded', () => {
    const { subject } = renderMessage('RESOLVED', {
      incidentTitle: `bad\r\nBcc: x@example.com\n${'a'.repeat(400)}`,
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.length).toBeLessThan(200);
  });

  it('describes team and alert source notices by name', () => {
    expect(renderMessage('TEAM_UPDATED', { teamName: 'Platform' }).text).toContain(
      'Team: Platform',
    );
    expect(renderMessage('ALERT_SOURCE_BLOCKED', { alertSourceName: 'Datadog' }).text).toContain(
      'Alert source: Datadog',
    );
  });
});
