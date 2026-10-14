import type { NormalizedAlert } from './alert-input.js';
import { deriveFingerprint, resolveIdentity } from './identity.js';

const base: NormalizedAlert = {
  sourceEventId: null,
  sourceFingerprint: null,
  name: 'cpu high',
  serviceId: '0190f7a2-6b1c-7c3e-8f4a-1b2c3d4e5f60',
  environment: 'production',
  sourceSeverity: null,
  summary: null,
  description: null,
  labels: ['b=2', 'a=1'],
  additionalDetails: null,
  status: 'FIRING',
  startedAt: new Date('2026-10-14T10:00:00Z'),
  endedAt: null,
  sourceUrl: null,
};

const alert = (overrides: Partial<NormalizedAlert>): NormalizedAlert => ({ ...base, ...overrides });

describe('resolveIdentity', () => {
  it('prefers sourceEventId over sourceFingerprint', () => {
    const identity = resolveIdentity(alert({ sourceEventId: 'evt-1', sourceFingerprint: 'fp-1' }));
    expect(identity).toEqual({
      kind: 'EVENT_ID',
      value: 'evt-1',
      activeIdentityKey: 'event:evt-1',
      sourceFingerprint: 'fp-1',
    });
  });

  it('uses the supplied sourceFingerprint when there is no event id', () => {
    expect(resolveIdentity(alert({ sourceFingerprint: 'fp-1' }))).toEqual({
      kind: 'FINGERPRINT',
      value: 'fp-1',
      activeIdentityKey: 'fingerprint:fp-1',
      sourceFingerprint: 'fp-1',
    });
  });

  it('derives a fingerprint from service, name, environment and labels, and stores it', () => {
    const identity = resolveIdentity(base);
    expect(identity?.kind).toBe('FINGERPRINT');
    expect(identity?.value).toBe(deriveFingerprint(base));
    expect(identity?.sourceFingerprint).toBe(identity?.value);
    expect(identity?.activeIdentityKey).toBe(`fingerprint:${identity?.value}`);
  });

  it('derives from labels alone, or from the name alone', () => {
    expect(resolveIdentity(alert({ name: null }))).not.toBeNull();
    expect(resolveIdentity(alert({ labels: [] }))).not.toBeNull();
  });

  it('cannot form an identity without event id, fingerprint, name or labels', () => {
    expect(resolveIdentity(alert({ name: null, labels: [] }))).toBeNull();
  });

  it('never lets an event id collide with a fingerprint of the same text', () => {
    const asEvent = resolveIdentity(alert({ sourceEventId: 'same' }));
    const asFingerprint = resolveIdentity(alert({ sourceFingerprint: 'same' }));
    expect(asEvent?.activeIdentityKey).not.toBe(asFingerprint?.activeIdentityKey);
  });
});

describe('deriveFingerprint', () => {
  it('is deterministic and independent of label order', () => {
    expect(deriveFingerprint(base)).toBe(deriveFingerprint({ ...base }));
    expect(deriveFingerprint(base)).toBe(deriveFingerprint({ ...base, labels: ['a=1', 'b=2'] }));
    expect(deriveFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable when fields outside the identity change', () => {
    const changed = alert({
      sourceSeverity: 'critical',
      summary: 'a different summary',
      description: 'other',
      additionalDetails: 'x',
      startedAt: new Date('2027-01-01T00:00:00Z'),
      endedAt: new Date('2027-01-01T01:00:00Z'),
      sourceUrl: 'https://example.com/other',
      status: 'RESOLVED',
    });
    expect(resolveIdentity(changed)?.value).toBe(resolveIdentity(base)?.value);
  });

  it.each([
    ['service', { serviceId: '0190f7a2-6b1c-7c3e-8f4a-1b2c3d4e5f61' }],
    ['name', { name: 'memory high' }],
    ['environment', { environment: 'staging' }],
    ['labels', { labels: ['a=1'] }],
  ])('changes when the %s changes', (_label, change) => {
    expect(deriveFingerprint({ ...base, ...change })).not.toBe(deriveFingerprint(base));
  });

  it('does not confuse an absent name with a name that looks like a label list', () => {
    expect(deriveFingerprint({ ...base, name: null, labels: ['x=1'] })).not.toBe(
      deriveFingerprint({ ...base, name: '', labels: ['x=1'] }),
    );
  });
});
