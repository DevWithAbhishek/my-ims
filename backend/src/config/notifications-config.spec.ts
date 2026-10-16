import { ConfigError, parseNotificationsConfig } from './env';

const valid = {
  SENDGRID_API_KEY: 'SG.key',
  NOTIFICATION_FROM_EMAIL: 'ims@example.com',
  NOTIFICATION_SEND_TIMEOUT_MS: '10000',
};

describe('parseNotificationsConfig', () => {
  it('reads every setting from the environment', () => {
    expect(parseNotificationsConfig(valid)).toEqual({
      sendgridApiKey: 'SG.key',
      fromEmail: 'ims@example.com',
      sendTimeoutMs: 10000,
    });
  });

  it('has no defaults: every missing variable is reported by name, never by value', () => {
    expect.assertions(3);
    try {
      parseNotificationsConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables.sort()).toEqual([
        'NOTIFICATION_FROM_EMAIL',
        'NOTIFICATION_SEND_TIMEOUT_MS',
        'SENDGRID_API_KEY',
      ]);
    }
    try {
      parseNotificationsConfig({ ...valid, NOTIFICATION_FROM_EMAIL: 'not-an-email' });
    } catch (error) {
      expect((error as Error).message).not.toContain('SG.key');
    }
  });

  it('rejects a non-positive timeout', () => {
    expect(() => parseNotificationsConfig({ ...valid, NOTIFICATION_SEND_TIMEOUT_MS: '0' })).toThrow(
      ConfigError,
    );
  });
});
