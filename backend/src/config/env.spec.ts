import { ConfigError, parseConfig } from './env.js';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  PORT: '4000',
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/ims',
  DIRECT_URL: 'postgresql://user:pw@localhost:5432/ims',
  JWT_SECRET: 'jwt-secret-value',
  REDIS_URL: 'redis://localhost:6379',
};

function configErrorFor(env: NodeJS.ProcessEnv): ConfigError {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected parseConfig to throw');
}

describe('parseConfig', () => {
  it('returns the typed config with default token expiries', () => {
    expect(parseConfig(validEnv)).toEqual({
      nodeEnv: 'development',
      port: 4000,
      databaseUrl: validEnv.DATABASE_URL,
      directUrl: validEnv.DIRECT_URL,
      jwtSecret: 'jwt-secret-value',
      redisUrl: 'redis://localhost:6379',
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
    });
  });

  it('honors explicit token expiries', () => {
    const config = parseConfig({
      ...validEnv,
      ACCESS_TOKEN_EXPIRY: '30m',
      REFRESH_TOKEN_EXPIRY: '14d',
    });
    expect(config.accessTokenExpiry).toBe('30m');
    expect(config.refreshTokenExpiry).toBe('14d');
  });

  it.each(['NODE_ENV', 'PORT', 'DATABASE_URL', 'DIRECT_URL', 'JWT_SECRET', 'REDIS_URL'])(
    'fails naming %s when it is missing',
    (name) => {
      const env = { ...validEnv };
      delete env[name];
      const error = configErrorFor(env);
      expect(error.variables).toEqual([name]);
      expect(error.message).toContain(`${name} is required`);
    },
  );

  it('treats an empty value as missing', () => {
    expect(configErrorFor({ ...validEnv, JWT_SECRET: '' }).variables).toEqual(['JWT_SECRET']);
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['DATABASE_URL', 'mysql://user:pw@localhost/ims'],
    ['DIRECT_URL', 'not-a-url'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['ACCESS_TOKEN_EXPIRY', 'soon'],
    ['REFRESH_TOKEN_EXPIRY', '7 days'],
  ])('rejects an invalid %s (%s)', (name, value) => {
    expect(configErrorFor({ ...validEnv, [name]: value }).variables).toEqual([name]);
  });

  it('reports every invalid variable at once', () => {
    const error = configErrorFor({ NODE_ENV: 'development' });
    expect(error.variables).toEqual(
      expect.arrayContaining(['PORT', 'DATABASE_URL', 'DIRECT_URL', 'JWT_SECRET', 'REDIS_URL']),
    );
  });

  it('never prints values in the error message', () => {
    const error = configErrorFor({
      ...validEnv,
      DATABASE_URL: 'mysql://admin:hunter2-secret@db.internal/ims',
      PORT: 'port-value-leak',
    });
    expect(error.message).not.toContain('hunter2-secret');
    expect(error.message).not.toContain('db.internal');
    expect(error.message).not.toContain('port-value-leak');
  });
});
