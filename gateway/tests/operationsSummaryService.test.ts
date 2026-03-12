/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { OperationsSummaryService } from '../src/core/operationsSummaryService';

describe('OperationsSummaryService', () => {
  test('reports healthy and degraded based on latency threshold', async () => {
    const service = new OperationsSummaryService([
      {
        key: 'fast',
        name: 'Fast',
        source: 'fast_probe',
        staleAfterMs: 60_000,
        degradedLatencyMs: 200,
        check: async () => undefined,
      },
      {
        key: 'slow',
        name: 'Slow',
        source: 'slow_probe',
        staleAfterMs: 60_000,
        degradedLatencyMs: 5,
        check: async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
        },
      },
    ]);

    const snapshot = await service.getOperationsSummary();
    const fast = snapshot.services.find((entry) => entry.key === 'fast');
    const slow = snapshot.services.find((entry) => entry.key === 'slow');

    expect(fast?.state).toBe('healthy');
    expect(slow?.state).toBe('degraded');
    expect(snapshot.incidents.openCount).toBe(1);
    expect(snapshot.incidents.bySeverity.low).toBe(1);
  });

  test('reports deterministic unavailable for unwired probe', async () => {
    const service = new OperationsSummaryService([
      {
        key: 'unwired',
        name: 'Unwired',
        source: 'unwired_probe',
        staleAfterMs: 60_000,
      },
    ]);

    const snapshot = await service.getOperationsSummary();
    expect(snapshot.state).toBe('unavailable');
    expect(snapshot.services[0]?.state).toBe('unavailable');
    expect(snapshot.services[0]?.lastSuccessAt).toBeNull();
    expect(snapshot.services[0]?.freshnessMs).toBeNull();
  });

  test('transitions from degraded to stale when a failing probe exceeds stale threshold', async () => {
    let shouldFail = false;
    const timeline = [
      new Date('2026-03-12T00:00:00.000Z'),
      new Date('2026-03-12T00:00:10.000Z'),
      new Date('2026-03-12T00:02:40.000Z'),
    ];

    const service = new OperationsSummaryService(
      [
        {
          key: 'flaky',
          name: 'Flaky',
          source: 'flaky_probe',
          staleAfterMs: 60_000,
          check: async () => {
            if (shouldFail) {
              throw new Error('upstream unavailable');
            }
          },
        },
      ],
      () => {
        const value = timeline.shift();
        if (!value) {
          throw new Error('Timeline exhausted');
        }

        return value;
      },
    );

    await service.getOperationsSummary();
    shouldFail = true;

    const degradedSnapshot = await service.getOperationsSummary();
    const staleSnapshot = await service.getOperationsSummary();

    expect(degradedSnapshot.services[0]?.state).toBe('degraded');
    expect(staleSnapshot.services[0]?.state).toBe('stale');
    expect(staleSnapshot.incidents.bySeverity.medium).toBe(1);
  });
});
