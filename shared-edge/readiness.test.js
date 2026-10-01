'use strict';

const { cacheSuccessfulCheck, evaluateReadiness } = require('./readiness');

describe('evaluateReadiness', () => {
  test('is ready only when every required dependency is ok', async () => {
    const result = await evaluateReadiness([
      { name: 'postgres', check: async () => {} },
      { name: 'chain-rpc', check: async () => {} },
    ]);

    expect(result.ready).toBe(true);
    expect(result.dependencies.map((dependency) => dependency.status)).toEqual(['ok', 'ok']);
  });

  test('fails readiness on a required failure without exposing the error message', async () => {
    const result = await evaluateReadiness([
      { name: 'postgres', check: async () => {} },
      {
        name: 'chain-rpc',
        check: async () => {
          throw new Error('connect ECONNREFUSED https://user:secret@rpc.example/v1/key');
        },
      },
    ]);

    expect(result.ready).toBe(false);
    expect(result.dependencies[1]).toMatchObject({
      name: 'chain-rpc',
      required: true,
      status: 'unavailable',
      reason: 'failed',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|rpc\.example|ECONNREFUSED/);
  });

  test('reports optional failures without failing readiness', async () => {
    const result = await evaluateReadiness([
      { name: 'postgres', check: async () => {} },
      {
        name: 'notifications',
        required: false,
        check: async () => {
          throw new Error('down');
        },
      },
    ]);

    expect(result.ready).toBe(true);
    expect(result.dependencies[1]).toMatchObject({ required: false, status: 'unavailable' });
  });

  test('bounds a hung dependency by its timeout and runs checks in parallel', async () => {
    const started = Date.now();
    const result = await evaluateReadiness(
      [
        { name: 'hung', timeoutMs: 50, check: () => new Promise(() => {}) },
        { name: 'slow', timeoutMs: 1_000, check: () => new Promise((r) => setTimeout(r, 40)) },
      ],
      { defaultTimeoutMs: 1_000 },
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.ready).toBe(false);
    expect(result.dependencies[0]).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(result.dependencies[1]).toMatchObject({ status: 'ok' });
  });

  test('treats a synchronous throw as a failed dependency', async () => {
    const result = await evaluateReadiness([
      {
        name: 'signer',
        check: () => {
          throw new Error('boom');
        },
      },
    ]);

    expect(result.ready).toBe(false);
    expect(result.dependencies[0]).toMatchObject({ status: 'unavailable', reason: 'failed' });
  });
});

describe('cacheSuccessfulCheck', () => {
  test('reuses a success for the ttl and probes again afterwards', async () => {
    let clock = 0;
    const probe = jest.fn().mockResolvedValue(undefined);
    const cached = cacheSuccessfulCheck(probe, 1_000, () => clock);

    await cached();
    clock = 500;
    await cached();
    expect(probe).toHaveBeenCalledTimes(1);

    clock = 1_001;
    await cached();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('never caches a failure', async () => {
    const probe = jest
      .fn()
      .mockRejectedValueOnce(new Error('kms throttled'))
      .mockResolvedValueOnce(undefined);
    const cached = cacheSuccessfulCheck(probe, 60_000, () => 0);

    await expect(cached()).rejects.toThrow('kms throttled');
    await expect(cached()).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('shares one in-flight probe between concurrent callers', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const probe = jest.fn(() => gate);
    const cached = cacheSuccessfulCheck(probe, 60_000, () => 0);

    const first = cached();
    const second = cached();
    release();
    await Promise.all([first, second]);

    expect(probe).toHaveBeenCalledTimes(1);
  });
});
