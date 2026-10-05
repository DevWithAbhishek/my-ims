import { Router } from 'express';
import { ServiceUnavailableError } from '../errors/AppError.js';
import { childLogger } from '../observability/logger.js';

export type ReadinessCheck = {
  name: string;
  check: () => Promise<unknown>;
};

export const READINESS_TIMEOUT_MS = 2000;
export const READINESS_RETRY_AFTER_SECONDS = 5;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `GET /health` (liveness, no dependencies) and `GET /ready` (dependency checks). */
export function createHealthRouter(checks: ReadinessCheck[]): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const results = await Promise.allSettled(
      checks.map(({ check }) => withTimeout(check(), READINESS_TIMEOUT_MS)),
    );

    const failed = checks.filter((_check, index) => results[index].status === 'rejected');
    if (failed.length > 0) {
      const log = childLogger({ requestId: res.locals.requestId as string });
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          log.warn(
            { dependency: checks[index].name, err: result.reason },
            'Readiness check failed',
          );
        }
      });
      throw new ServiceUnavailableError(
        'A required dependency is unavailable',
        'DEPENDENCY_UNAVAILABLE',
        READINESS_RETRY_AFTER_SECONDS,
      );
    }

    res.status(200).json({ data: { status: 'ok' } });
  });

  return router;
}
