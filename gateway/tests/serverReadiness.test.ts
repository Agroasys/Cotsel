/**
 * SPDX-License-Identifier: Apache-2.0
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { assertGaslessRelayerServing, createReadinessCheck } from '../src/serverReadiness';
import { createGaslessRelayerServiceProbe } from '../src/core/gaslessRelayerServiceProbe';
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

  test('requires a serving relayer policy only when gasless execution is enabled', async () => {
    const withoutGasless = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: ok,
    })();
    expect(byName(withoutGasless, 'gasless-relayer-policy')).toBeUndefined();
    expect(byName(withoutGasless, 'gasless-relayer')).toBeUndefined();

    const blocked = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: ok,
      gaslessRelayer: relayer('blocked'),
    })();
    expect(byName(blocked, 'gasless-relayer-policy')).toMatchObject({ status: 'unavailable' });
  });

  test('reports the standalone relayer separately from the local policy snapshot', async () => {
    const dependencies = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: ok,
      gaslessRelayer: relayer('ready'),
      gaslessRelayerService: async () => {
        throw new Error('Gasless relayer is not ready (status 503)');
      },
    })();

    expect(byName(dependencies, 'gasless-relayer-policy')).toMatchObject({ status: 'ok' });
    expect(byName(dependencies, 'gasless-relayer')).toMatchObject({
      required: true,
      status: 'unavailable',
      reason: 'failed',
    });
  });

  test.each(['ready', 'degraded', 'paused'] as const)('treats a %s relayer as serving', (state) => {
    expect(() =>
      assertGaslessRelayerServing({ state } as GaslessRelayerReadinessSnapshot),
    ).not.toThrow();
  });
});

describe('gasless relayer service probe', () => {
  let server: http.Server;
  let baseUrl: string;
  let respond: (res: http.ServerResponse) => void;
  const paths: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      paths.push(req.url ?? '');
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function json(status: number, body: unknown) {
    return (res: http.ServerResponse) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
  }

  test('contacts the relayer readiness endpoint and accepts a ready relayer', async () => {
    respond = json(200, { success: true, ready: true, dependencies: [] });

    await expect(createGaslessRelayerServiceProbe(`${baseUrl}/`, 1_000)()).resolves.toBeUndefined();
    expect(paths[paths.length - 1]).toBe('/api/relayer/ready');
  });

  test('fails when the relayer reports a KMS or replay-store outage', async () => {
    respond = json(503, {
      ready: false,
      dependencies: [{ name: 'kms-signer', required: true, status: 'unavailable' }],
    });

    await expect(createGaslessRelayerServiceProbe(baseUrl, 1_000)()).rejects.toThrow('status 503');
  });

  test('fails when the relayer answers 200 without confirming readiness', async () => {
    respond = json(200, { success: true });

    await expect(createGaslessRelayerServiceProbe(baseUrl, 1_000)()).rejects.toThrow('not ready');
  });

  test('fails when the relayer process is unreachable', async () => {
    await expect(createGaslessRelayerServiceProbe('http://127.0.0.1:1', 1_000)()).rejects.toThrow();
  });

  test('is bounded when the relayer hangs', async () => {
    respond = () => {};

    const dependencies = await createReadinessCheck({
      auth: ok,
      database: ok,
      governance: ok,
      indexer: ok,
      gaslessRelayerService: createGaslessRelayerServiceProbe(baseUrl, 5_000),
      timeoutMs: 50,
    })();

    expect(byName(dependencies, 'gasless-relayer')).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
    });
  });
});
