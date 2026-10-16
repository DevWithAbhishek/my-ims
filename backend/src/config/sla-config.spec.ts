import { ConfigError, parseSlaConfig } from './env';

describe('parseSlaConfig', () => {
  it('reads the scan interval from the environment', () => {
    expect(parseSlaConfig({ SLA_SCAN_INTERVAL_MS: '5000' })).toEqual({ scanIntervalMs: 5000 });
  });

  it('has no default: a missing variable is reported by name', () => {
    expect.assertions(2);
    try {
      parseSlaConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables).toEqual(['SLA_SCAN_INTERVAL_MS']);
    }
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects %s', (value) => {
    expect(() => parseSlaConfig({ SLA_SCAN_INTERVAL_MS: value })).toThrow(ConfigError);
  });
});
