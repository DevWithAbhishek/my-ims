import { INCIDENT_EVENT_TYPES, type IncidentEventType } from '../incidents.types.js';
import {
  collectUserIds,
  isIncidentEventType,
  toTimelineItems,
  type StoredAuditEvent,
} from './timeline.mapper.js';

const A = '0199c1a4-7b1e-7000-8000-00000000000a';
const B = '0199c1a4-7b1e-7000-8000-00000000000b';
const alice = { id: A, name: 'Alice' };
const bob = { id: B, name: 'Bob' };
const users = new Map([
  [A, alice],
  [B, bob],
]);
const TS = '2026-01-01T00:00:00.000Z';
const createdAt = new Date(TS);

function event(
  eventType: IncidentEventType,
  metadata: unknown,
  actor: string | null = null,
): StoredAuditEvent {
  return { id: 'e1', eventType, actor, metadata, createdAt };
}

const details = (eventType: IncidentEventType, metadata: unknown) =>
  toTimelineItems([event(eventType, metadata)], users)[0].details;

type Case = [IncidentEventType, Record<string, unknown>, Record<string, unknown>];
const SEV = { from: 'P2', to: 'P1', statusFrom: 'ACKNOWLEDGED', statusTo: 'MITIGATING' };
const CASES: Case[] = [
  ['ALERT_RECEIVED', { alertId: 'a1' }, { alertId: 'a1' }],
  ['ALERT_DUPLICATE', { alertSourceId: 's1' }, { alertSourceId: 's1' }],
  ['AI_TRIAGE_COMPLETED', { createdAt: TS }, { createdAt: TS }],
  ['INCIDENT_CREATED', { incidentId: 'i1' }, { incidentId: 'i1' }],
  ['ASSIGNED', { from: null, to: B, auto: true }, { from: null, to: bob, auto: true }],
  ['REASSIGNED', { from: A, to: B }, { from: alice, to: bob }],
  ['OPEN', { statusFrom: 'ACKNOWLEDGED' }, { statusFrom: 'ACKNOWLEDGED' }],
  [
    'ACKNOWLEDGED',
    { acknowledgedBy: A, autoAssigned: false },
    { acknowledgedBy: A, autoAssigned: false },
  ],
  ['SEVERITY_CONFIRMED', SEV, SEV],
  [
    'COMMENT_ADDED',
    { comment: { id: 'c1', title: null, body: 'hello', authorId: A, createdAt: TS } },
    { comment: { id: 'c1', title: null, body: 'hello', author: alice, createdAt: TS } },
  ],
  ['SLA_WARNING', { kind: 'RESPONSE' }, { kind: 'RESPONSE' }],
  ['ESCALATED_L1', { notifiedUser: A }, { notifiedUser: alice }],
  ['ESCALATED_L2', { notifiedUser: B }, { notifiedUser: bob }],
  ['ESCALATED_L3', { notifiedUser: A }, { notifiedUser: alice }],
  ['ESCALATED_L4', { notifiedUser: B }, { notifiedUser: bob }],
  ['SOURCE_ALERT_RESOLVED', { alertId: 'a1' }, { alertId: 'a1' }],
  [
    'RESOLVED',
    { resolutionSummary: 'fixed', serviceConfirmedWorking: true },
    { resolutionSummary: 'fixed', serviceConfirmedWorking: true },
  ],
  ['NOTIFIED', { recipients: [A, B] }, { recipients: [alice, bob] }],
  ['POSTMORTEM_GENERATED', { postmortemId: 'p1' }, { postmortemId: 'p1' }],
  [
    'POSTMORTEM_REVIEWED',
    { postmortemId: 'p1', reviewedBy: A },
    { postmortemId: 'p1', reviewedBy: alice },
  ],
  ['AI_INVESTIGATION_COMPLETED', { investigationId: 'n1' }, { investigationId: 'n1' }],
  ['CLOSED', { closedAt: TS }, { closedAt: TS }],
];

describe('timeline mapper', () => {
  it('covers every one of the 22 incident event types', () => {
    expect(CASES.map(([type]) => type).sort()).toEqual([...INCIDENT_EVENT_TYPES].sort());
    expect(INCIDENT_EVENT_TYPES).toHaveLength(22);
  });

  it.each(CASES)('maps %s details', (type, metadata, expected) => {
    expect(details(type, metadata)).toEqual(expected);
  });

  it.each(CASES)('never exposes keys outside the whitelist for %s', (type, metadata) => {
    const polluted = { ...metadata, internalNote: 'x', token: 'secret', rawModelOutput: 'raw' };
    const serialized = JSON.stringify(details(type, polluted));
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('internalNote');
    expect(serialized).not.toContain('rawModelOutput');
  });

  it('returns the actor as a UserSummary and null for the system', () => {
    const [human, system] = toTimelineItems(
      [event('OPEN', { statusFrom: 'RESOLVED' }, A), event('SLA_WARNING', { kind: 'RESOLUTION' })],
      users,
    );
    expect(human.actor).toEqual(alice);
    expect(system.actor).toBeNull();
    expect(human.createdAt).toBe(TS);
  });

  it('never returns raw metadata', () => {
    const [item] = toTimelineItems([event('OPEN', { statusFrom: 'RESOLVED' })], users);
    expect(Object.keys(item).sort()).toEqual(['actor', 'createdAt', 'details', 'eventType', 'id']);
  });

  it('tolerates missing or malformed metadata', () => {
    expect(details('ASSIGNED', null)).toEqual({ from: null, to: null, auto: false });
    expect(details('COMMENT_ADDED', 'oops')).toEqual({ comment: null });
    expect(details('NOTIFIED', { recipients: 'x' })).toEqual({ recipients: [] });
    expect(details('RESOLVED', [])).toEqual({
      resolutionSummary: null,
      serviceConfirmedWorking: false,
    });
  });

  it('collects every user id once, from actors and metadata', () => {
    const found = collectUserIds([
      event('ASSIGNED', { from: A, to: B, auto: false }, A),
      event('NOTIFIED', { recipients: [A, B] }, null),
      event('COMMENT_ADDED', { comment: { id: 'c', body: 'x', authorId: B } }, B),
    ]);
    expect(found.sort()).toEqual([A, B]);
  });

  it('recognizes only incident event types', () => {
    expect(isIncidentEventType('COMMENT_ADDED')).toBe(true);
    expect(isIncidentEventType('USER_UPDATED')).toBe(false);
  });
});
