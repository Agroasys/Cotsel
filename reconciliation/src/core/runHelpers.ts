import { config } from '../config';
import type { ReconcileMode } from '../types';

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function generateRunKey(mode: ReconcileMode): string {
  if (mode === 'DAEMON') {
    const bucket = Math.floor(Date.now() / config.daemonIntervalMs);
    return `daemon-${bucket}`;
  }
  return `once-${new Date().toISOString()}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded-concurrency map, so a wide window cannot stampede the RPC endpoint. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}
