/** Integration tests run against a dedicated database so they never touch development data. */
export const DEFAULT_TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5431/ims_test';
export const DEFAULT_TEST_REDIS_URL = 'redis://localhost:6379/15';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** Same server, different database. */
export function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

/** Refuses to run destructive helpers against anything that is not a test database. */
export function assertTestDatabase(url: string): void {
  if (!/_test$|^ims_migrate_check_/.test(databaseName(url))) {
    throw new Error('Refusing to run against a database whose name does not end in "_test"');
  }
}
