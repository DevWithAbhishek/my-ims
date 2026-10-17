import { projectAllowedFields, TRIAGE_ALLOWED_FIELDS } from './triage.allowlist';

describe('projectAllowedFields', () => {
  it('names exactly the four allowed fields', () => {
    expect([...TRIAGE_ALLOWED_FIELDS].sort()).toEqual([
      'additionalDetails',
      'description',
      'labels',
      'summary',
    ]);
  });

  it('copies the allowed fields and nothing else, whatever the source carries', () => {
    const alert = {
      id: 'alert-id',
      incidentId: 'incident-id',
      name: 'cpu high',
      environment: 'production',
      sourceUrl: 'https://monitoring.example/alert/1',
      originalPayload: { token: 'secret' },
      activeIdentityKey: 'event:1',
      alertSourceId: 'source-id',
      affectedServiceId: 'service-id',
      summary: 'CPU above 90%',
      description: 'Sustained for 10 minutes',
      labels: ['host=web-1', 'team=checkout'],
      additionalDetails: 'runbook: restart',
    };
    const projected = projectAllowedFields(alert);
    expect(projected).toEqual({
      summary: 'CPU above 90%',
      description: 'Sustained for 10 minutes',
      labels: ['host=web-1', 'team=checkout'],
      additionalDetails: 'runbook: restart',
    });
    expect(Object.keys(projected).sort()).toEqual([...TRIAGE_ALLOWED_FIELDS].sort());
  });

  it('keeps absent values as null and an empty label list, and does not share the labels array', () => {
    const labels: string[] = [];
    const projected = projectAllowedFields({
      summary: null,
      description: null,
      labels,
      additionalDetails: null,
    });
    expect(projected).toEqual({
      summary: null,
      description: null,
      labels: [],
      additionalDetails: null,
    });
    expect(projected.labels).not.toBe(labels);
  });
});
