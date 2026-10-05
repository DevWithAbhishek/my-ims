import { logger } from '../observability/logger.js';

export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Runs `shutdown` once on SIGTERM/SIGINT, then exits 0 (1 if it fails or exceeds the timeout).
 */
export function onShutdownSignal(shutdown: () => Promise<void>): void {
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'Shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
}
