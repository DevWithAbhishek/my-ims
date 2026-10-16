import {
  ALL_MILESTONES,
  escalationAuditEvent,
  isMilestone,
  milestoneKey,
  notificationEventOf,
} from './sla.milestones';
import { NOTIFICATION_CATALOG } from '../../notifications/index';

const ID = '0192b5e0-7c1a-7d2e-8f3b-4a5c6d7e8f90';

describe('milestone keys (SLICE-07 §4: <eventType>:<incidentId>:<milestone>)', () => {
  it.each([
    ['RESPONSE_WARNING', `SLA_WARNING:${ID}:RESPONSE_WARNING`],
    ['RESOLUTION_WARNING', `SLA_WARNING:${ID}:RESOLUTION_WARNING`],
    ['RESPONSE_BREACH', `RESPONSE_BREACH:${ID}:RESPONSE_BREACH`],
    ['RESOLUTION_BREACH', `RESOLUTION_BREACH:${ID}:RESOLUTION_BREACH`],
    ['ESCALATION_LEVEL_1', `ESCALATED_L1:${ID}:ESCALATION_LEVEL_1`],
    ['ESCALATION_LEVEL_2', `ESCALATED_L2:${ID}:ESCALATION_LEVEL_2`],
    ['ESCALATION_LEVEL_3', `ESCALATED_L3:${ID}:ESCALATION_LEVEL_3`],
    ['ESCALATION_LEVEL_4', `ESCALATED_L4:${ID}:ESCALATION_LEVEL_4`],
    ['ESCALATION_FAILURE_2', `ESCALATION_FAILED:${ID}:ESCALATION_FAILURE_2`],
  ] as const)('%s', (milestone, key) => {
    expect(milestoneKey(ID, milestone)).toBe(key);
  });

  it('has a distinct key for every milestone, including the failure of each level', () => {
    const keys = ALL_MILESTONES.map((milestone) => milestoneKey(ID, milestone));
    expect(new Set(keys).size).toBe(12);
  });

  it('only produces event types that exist in the notification catalog', () => {
    for (const milestone of ALL_MILESTONES) {
      expect(Object.keys(NOTIFICATION_CATALOG)).toContain(notificationEventOf(milestone));
    }
  });

  it('names the audit event of each escalation level', () => {
    expect([1, 2, 3, 4].map((level) => escalationAuditEvent(level as 1 | 2 | 3 | 4))).toEqual([
      'ESCALATED_L1',
      'ESCALATED_L2',
      'ESCALATED_L3',
      'ESCALATED_L4',
    ]);
  });

  it('recognizes only real milestones', () => {
    expect(isMilestone('RESPONSE_BREACH')).toBe(true);
    expect(isMilestone('ESCALATION_LEVEL_5')).toBe(false);
  });
});
