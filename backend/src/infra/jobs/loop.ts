import { logger } from '../../shared/observability/logger.js';

export type Loop = { stop(): Promise<void> };

/**
 * Runs `run` repeatedly, one run at a time. When `run` returns `true` (more work is waiting) the next
 * run starts immediately; otherwise it waits `intervalMs`. A failing run is logged and retried.
 */
export function startLoop(
  name: string,
  intervalMs: number,
  run: () => Promise<boolean | void>,
): Loop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    let more = false;
    try {
      more = (await run()) === true;
    } catch (err) {
      logger.error({ err, loop: name, outcome: 'loop_failed' }, 'Background loop run failed');
    }
    schedule(more ? 0 : intervalMs);
  };

  schedule(0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
