import { NOTIFICATION_CATALOG, type NotificationEventType } from './catalog';
import { planRecipientQuery, type RecipientContext } from './recipients';

const ctx: RecipientContext = {
  teamId: 'team',
  subjectUserId: 'subject',
  resolvedById: 'resolver',
  level3Id: 'level3',
  fallbackAdminId: 'fallback',
};

const plan = (event: NotificationEventType, over: Partial<RecipientContext> = {}) =>
  planRecipientQuery(event, { ...ctx, ...over });

const TEAM_AND_FALLBACK: NotificationEventType[] = [
  'INCIDENT_CREATED',
  'ACKNOWLEDGED',
  'SEVERITY_CONFIRMED',
  'SLA_WARNING',
  'ESCALATED_L1',
  'ESCALATED_L2',
  'ESCALATED_L3',
  'ESCALATED_L4',
  'SOURCE_ALERT_RESOLVED',
  'RESOLVED',
  'CLOSED',
  'REASSIGNED',
  'OPEN',
  'RESPONSE_BREACH',
  'RESOLUTION_BREACH',
  'ESCALATION_FAILED',
  'SERVICE_UPDATED',
  'SERVICE_DEACTIVATED',
  'ESCALATION_POLICY_UPDATED',
];

describe('planRecipientQuery (SLICE-09 §4.3)', () => {
  it.each(TEAM_AND_FALLBACK)('%s: team members ∪ fallback admin', (event) => {
    expect(plan(event)).toEqual({ teamId: 'team', userIds: ['fallback'], allAdmins: false });
  });

  it('ASSIGNED: the assignee ∪ level3 ∪ fallback admin, no team', () => {
    expect(plan('ASSIGNED')).toEqual({
      teamId: null,
      userIds: ['subject', 'level3', 'fallback'],
      allAdmins: false,
    });
  });

  it('AI_TRIAGE_COMPLETED: level3 ∪ fallback admin', () => {
    expect(plan('AI_TRIAGE_COMPLETED')).toEqual({
      teamId: null,
      userIds: ['level3', 'fallback'],
      allAdmins: false,
    });
  });

  it.each(['POSTMORTEM_GENERATED', 'POSTMORTEM_REVIEWED'] as const)(
    '%s: resolvedBy ∪ level3 ∪ fallback admin',
    (event) => {
      expect(plan(event).userIds).toEqual(['resolver', 'level3', 'fallback']);
    },
  );

  it('AI_INVESTIGATION_COMPLETED: the requester ∪ level3 ∪ fallback admin', () => {
    expect(plan('AI_INVESTIGATION_COMPLETED').userIds).toEqual(['subject', 'level3', 'fallback']);
  });

  it('POSTMORTEM_GENERATION_FAILED: resolvedBy ∪ level3, no fallback admin', () => {
    expect(plan('POSTMORTEM_GENERATION_FAILED')).toEqual({
      teamId: null,
      userIds: ['resolver', 'level3'],
      allAdmins: false,
    });
  });

  it.each(['TEAM_UPDATED', 'TEAM_DEACTIVATED'] as const)(
    '%s: team members only, no fallback admin',
    (event) => {
      expect(plan(event)).toEqual({ teamId: 'team', userIds: [], allAdmins: false });
    },
  );

  it.each(['ALERT_SOURCE_BLOCKED', 'INVESTIGATION_REQUEST_BLOCKED'] as const)(
    '%s: all active Admins',
    (event) => {
      expect(plan(event)).toEqual({ teamId: null, userIds: [], allAdmins: true });
    },
  );

  it('de-duplicates users named by more than one source', () => {
    expect(
      plan('ASSIGNED', { level3Id: 'same', fallbackAdminId: 'same', subjectUserId: 'same' }),
    ).toEqual({ teamId: null, userIds: ['same'], allAdmins: false });
  });

  it('skips sources that resolve to nothing', () => {
    expect(plan('POSTMORTEM_GENERATED', { resolvedById: null }).userIds).toEqual([
      'level3',
      'fallback',
    ]);
  });

  it('covers every catalog event', () => {
    for (const event of Object.keys(NOTIFICATION_CATALOG) as NotificationEventType[]) {
      expect(() => plan(event)).not.toThrow();
    }
  });
});
