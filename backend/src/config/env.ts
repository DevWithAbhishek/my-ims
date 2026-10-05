import dotenv from 'dotenv';
import { z } from 'zod';

type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  directUrl: string;
  jwtSecret: string;
  redisUrl: string;
  accessTokenExpiry: Duration;
  refreshTokenExpiry: Duration;
}

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a PostgreSQL URL');
const redisUrl = z.string().regex(/^rediss?:\/\/.+/, 'must be a Redis URL');
const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'must be a duration such as 15m, 7d')
  .transform((value) => value as Duration);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: postgresUrl,
  DIRECT_URL: postgresUrl,
  JWT_SECRET: z.string().min(1),
  REDIS_URL: redisUrl,
  ACCESS_TOKEN_EXPIRY: duration.default('15m'),
  REFRESH_TOKEN_EXPIRY: duration.default('7d'),
});

/** Thrown for invalid configuration. The message names variables only, never their values. */
export class ConfigError extends Error {
  constructor(
    readonly variables: string[],
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const problems = new Map<string, string>();
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? 'environment');
      const missing = env[name] === undefined || env[name] === '';
      problems.set(name, missing ? 'is required' : issue.message);
    }
    const variables = [...problems.keys()];
    const detail = [...problems].map(([name, problem]) => `${name} ${problem}`).join('; ');
    throw new ConfigError(variables, `Invalid configuration: ${detail}`);
  }

  const values = result.data;
  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    directUrl: values.DIRECT_URL,
    jwtSecret: values.JWT_SECRET,
    redisUrl: values.REDIS_URL,
    accessTokenExpiry: values.ACCESS_TOKEN_EXPIRY,
    refreshTokenExpiry: values.REFRESH_TOKEN_EXPIRY,
  };
}

let cached: Config | undefined;

/** Loads `.env` (if present) and returns the validated configuration, parsing it once. */
export function getConfig(): Config {
  if (!cached) {
    dotenv.config({ quiet: true });
    cached = parseConfig(process.env);
  }
  return cached;
}
