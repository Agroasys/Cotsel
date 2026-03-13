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

  test('unavailable outranks stale when mixed in aggregate state', async () => {
    let staleShouldFail = false;
    const timeline = [
      new Date('2026-03-12T00:00:00.000Z'),
      new Date('2026-03-12T01:00:00.000Z'),
    ];

    const service = new OperationsSummaryService(
      [
        {
          key: 'staleable',
          name: 'Staleable',
          source: 'staleable_probe',
          staleAfterMs: 1_000,
          check: async () => {
            if (staleShouldFail) {
              throw new Error('upstream failed');
            }
          },
        },
        {
          key: 'unwired',
          name: 'Unwired',
          source: 'unwired_probe',
          staleAfterMs: 60_000,
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
    staleShouldFail = true;

    const snapshot = await service.getOperationsSummary();
    expect(snapshot.services.find((s) => s.key === 'staleable')?.state).toBe('stale');
    expect(snapshot.services.find((s) => s.key === 'unwired')?.state).toBe('unavailable');
    expect(snapshot.state).toBe('unavailable');
  });

  test('incident firstObservedAt reflects time of first failure not last success', async () => {
    let shouldFail = false;
    const timeline = [
      new Date('2026-03-12T00:00:00.000Z'),
      new Date('2026-03-12T00:01:00.000Z'),
      new Date('2026-03-12T00:02:00.000Z'),
    ];

    const service = new OperationsSummaryService(
      [
        {
          key: 'probe',
          name: 'Probe',
          source: 'probe_source',
          staleAfterMs: 60_000,
          check: async () => {
            if (shouldFail) {
              throw new Error('upstream failed');
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

    const firstFailureSnapshot = await service.getOperationsSummary();
    expect(firstFailureSnapshot.incidents.items[0]?.firstObservedAt).toBe('2026-03-12T00:01:00.000Z');

    const secondFailureSnapshot = await service.getOperationsSummary();
    expect(secondFailureSnapshot.incidents.items[0]?.firstObservedAt).toBe('2026-03-12T00:01:00.000Z');
  });
});
