import { changedConfigurationKeys, DEFAULT_SEVERITY_MAPPING } from './seed-alert-source.js';

describe('DEFAULT_SEVERITY_MAPPING', () => {
  it('maps critical/high/warning/info to P0..P3', () => {
    expect(DEFAULT_SEVERITY_MAPPING).toEqual({
      critical: 'P0',
      high: 'P1',
      warning: 'P2',
      info: 'P3',
    });
  });
});

describe('changedConfigurationKeys', () => {
  const current = {
    signingSecret: 's1',
    severityMapping: { critical: 'P0', high: 'P1' },
    extra: 1,
  };

  it('is empty when nothing changed, whatever the key order', () => {
    expect(
      changedConfigurationKeys(current, {
        ...current,
        severityMapping: { high: 'P1', critical: 'P0' },
      }),
    ).toEqual([]);
  });

  it('names a rotated secret without its value', () => {
    const keys = changedConfigurationKeys(current, { ...current, signingSecret: 's2' });
    expect(keys).toEqual(['signingSecret']);
  });

  it('names an edited mapping, and returns several keys sorted', () => {
    expect(
      changedConfigurationKeys(current, {
        ...current,
        signingSecret: 's2',
        severityMapping: { critical: 'P1', high: 'P1' },
      }),
    ).toEqual(['severityMapping', 'signingSecret']);
  });

  it('counts an added or removed key as changed', () => {
    expect(changedConfigurationKeys({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(changedConfigurationKeys({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });
});
