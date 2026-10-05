import { logger } from '../../src/shared/observability/logger';
import { testDatabaseUrl, testRedisUrl } from '../helpers/test-env';

// Runs before every integration test file: point the app at the test services.
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '3000';
process.env.DATABASE_URL = testDatabaseUrl();
process.env.DIRECT_URL = testDatabaseUrl();
process.env.REDIS_URL = testRedisUrl();
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'integration-test-secret';

logger.level = 'silent';
