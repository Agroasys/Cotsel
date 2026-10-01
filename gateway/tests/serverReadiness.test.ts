/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { assertGaslessRelayerServing, createReadinessCheck } from '../src/serverReadiness';
import type { GaslessRelayerReadinessSnapshot } from '../src/core/gaslessExecutionTypes';

const ok = async () => {};

function relayer(state: GaslessRelayerReadinessSnapshot['state']) {
  return () => ({ state }) as GaslessRelayerReadinessSnapshot;
}

function byName(dependencies: Array<{ name: string }>, name: string) {
  return dependencies.find((dependency) => dependency.name === name);
}

describe('gateway readiness', () => {
  test('reports every required financial dependency as ok', async () => {
    const dependencies = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: ok,
    })();

    expect(dependencies.map((dependency) => dependency.name)).toEqual([
      'postgres',
      'auth-service',
      'chain-rpc',
      'indexer-graphql',
    ]);
    expect(dependencies.every((dependency) => dependency.status === 'ok')).toBe(true);
  });

  test('marks a failed RPC unavailable without echoing the provider error', async () => {
    const dependencies = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: async () => {
        throw new Error('getaddrinfo ENOTFOUND https://base-sepolia.example/v2/secret-key');
      },
      indexer: ok,
    })();

    expect(byName(dependencies, 'chain-rpc')).toMatchObject({
      status: 'unavailable',
      required: true,
      reason: 'failed',
    });
    expect(JSON.stringify(dependencies)).not.toMatch(/secret-key|base-sepolia\.example/);
  });

  test('bounds a hung indexer by the configured timeout', async () => {
    const dependencies = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: () => new Promise(() => {}),
      timeoutMs: 50,
    })();

    expect(byName(dependencies, 'indexer-graphql')).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
    });
  });

  test('requires a serving relayer only when gasless execution is enabled', async () => {
    const withoutGasless = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: ok,
    })();
    expect(byName(withoutGasless, 'gasless-relayer')).toBeUndefined();

    const blocked = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: ok,
      gaslessRelayer: relayer('blocked'),
    })();
    expect(byName(blocked, 'gasless-relayer')).toMatchObject({ status: 'unavailable' });
  });

  test.each(['ready', 'degraded', 'paused'] as const)('treats a %s relayer as serving', (state) => {
    expect(() =>
      assertGaslessRelayerServing({ state } as GaslessRelayerReadinessSnapshot),
    ).not.toThrow();
  });
});
