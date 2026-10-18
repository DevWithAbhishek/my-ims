import {
  ConfigError,
  parseAiConfig,
  parseInvestigationRetentionConfig,
  parseInvestigationRetrievalConfig,
} from './env';

const valid = {
  GEMINI_API_KEY: 'AIza-key',
  GEMINI_MODEL: 'gemini-flash-test',
  AI_REQUEST_TIMEOUT_MS: '10000',
};

describe('parseAiConfig', () => {
  it('reads every setting from the environment', () => {
    expect(parseAiConfig(valid)).toEqual({
      geminiApiKey: 'AIza-key',
      geminiModel: 'gemini-flash-test',
      requestTimeoutMs: 10000,
    });
  });

  it('has no defaults: every missing variable is reported by name, never by value', () => {
    expect.assertions(3);
    try {
      parseAiConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables.sort()).toEqual([
        'AI_REQUEST_TIMEOUT_MS',
        'GEMINI_API_KEY',
        'GEMINI_MODEL',
      ]);
    }
    try {
      parseAiConfig({ ...valid, AI_REQUEST_TIMEOUT_MS: 'soon' });
    } catch (error) {
      expect((error as Error).message).not.toContain('AIza-key');
    }
  });

  it('rejects an empty key or model and a non-positive timeout', () => {
    expect(() => parseAiConfig({ ...valid, GEMINI_API_KEY: '' })).toThrow(ConfigError);
    expect(() => parseAiConfig({ ...valid, GEMINI_MODEL: '' })).toThrow(ConfigError);
    expect(() => parseAiConfig({ ...valid, AI_REQUEST_TIMEOUT_MS: '0' })).toThrow(ConfigError);
  });
});

describe('investigation settings', () => {
  const retention = {
    INVESTIGATION_RETENTION_INTERVAL_MS: '3600000',
    INVESTIGATION_RETENTION_BATCH_SIZE: '100',
  };

  it('defaults the retrieval limit to 20 and reads an override', () => {
    expect(parseInvestigationRetrievalConfig({})).toEqual({ postmortemLimit: 20 });
    expect(parseInvestigationRetrievalConfig({ INVESTIGATION_RETRIEVAL_LIMIT: '5' })).toEqual({
      postmortemLimit: 5,
    });
    expect(() => parseInvestigationRetrievalConfig({ INVESTIGATION_RETRIEVAL_LIMIT: '0' })).toThrow(
      ConfigError,
    );
  });

  it('has no defaults for retention: both variables are reported by name', () => {
    expect(parseInvestigationRetentionConfig(retention)).toEqual({
      intervalMs: 3600000,
      batchSize: 100,
    });
    expect.assertions(4);
    try {
      parseInvestigationRetentionConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables.sort()).toEqual([
        'INVESTIGATION_RETENTION_BATCH_SIZE',
        'INVESTIGATION_RETENTION_INTERVAL_MS',
      ]);
    }
    expect(() =>
      parseInvestigationRetentionConfig({ ...retention, INVESTIGATION_RETENTION_BATCH_SIZE: 'x' }),
    ).toThrow(ConfigError);
  });
});
