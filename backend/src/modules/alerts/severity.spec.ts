import { resolveInitialSeverity } from './severity.js';

const DEFAULT_CONFIG = {
  signingSecret: 'secret',
  severityMapping: { critical: 'P0', high: 'P1', warning: 'P2', info: 'P3' },
};

describe('resolveInitialSeverity', () => {
  it.each([
    ['critical', 'P0'],
    ['high', 'P1'],
    ['warning', 'P2'],
    ['info', 'P3'],
  ])('maps %s to %s', (source, expected) => {
    expect(resolveInitialSeverity(DEFAULT_CONFIG, source, 'P1')).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(resolveInitialSeverity(DEFAULT_CONFIG, 'Critical', 'P3')).toBe('P0');
    expect(resolveInitialSeverity(DEFAULT_CONFIG, 'WARNING', 'P3')).toBe('P2');
  });

  it('is otherwise exact: no trimming, no partial matches', () => {
    expect(resolveInitialSeverity(DEFAULT_CONFIG, ' critical', 'P3')).toBe('P3');
    expect(resolveInitialSeverity(DEFAULT_CONFIG, 'crit', 'P3')).toBe('P3');
  });

  it('honors a custom mapping, including mixed-case keys', () => {
    const config = { severityMapping: { Sev1: 'P0', sev2: 'P1' } };
    expect(resolveInitialSeverity(config, 'SEV1', 'P3')).toBe('P0');
    expect(resolveInitialSeverity(config, 'sev2', 'P3')).toBe('P1');
    expect(resolveInitialSeverity(config, 'critical', 'P3')).toBe('P3');
  });

  it('falls back to the service default for unrecognized or absent severities', () => {
    expect(resolveInitialSeverity(DEFAULT_CONFIG, 'catastrophic', 'P2')).toBe('P2');
    expect(resolveInitialSeverity(DEFAULT_CONFIG, '', 'P2')).toBe('P2');
    expect(resolveInitialSeverity(DEFAULT_CONFIG, null, 'P0')).toBe('P0');
  });

  it.each([
    ['no mapping', {}],
    ['a null mapping', { severityMapping: null }],
    ['an array mapping', { severityMapping: ['critical'] }],
    ['a string mapping', { severityMapping: 'critical=P0' }],
  ])('behaves as if everything were unrecognized with %s', (_label, config) => {
    expect(resolveInitialSeverity(config, 'critical', 'P2')).toBe('P2');
  });

  it('ignores mapping entries that are not P0..P3', () => {
    const config = { severityMapping: { critical: 'P9', high: 3, info: 'P3' } };
    expect(resolveInitialSeverity(config, 'critical', 'P1')).toBe('P1');
    expect(resolveInitialSeverity(config, 'high', 'P1')).toBe('P1');
    expect(resolveInitialSeverity(config, 'info', 'P1')).toBe('P3');
  });
});
