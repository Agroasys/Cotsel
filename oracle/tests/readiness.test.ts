import express from 'express';
import type { AddressInfo } from 'net';
import { Wallet } from 'ethers';
import type { KmsSigningClient } from '@agroasys/sdk';

jest.mock('../src/config', () => ({
  config: { apiKey: 'test-api-key', hmacSecret: 'test-hmac-secret', hmacNonceTtlSeconds: 600 },
}));

import { createRouter } from '../src/api/routes';
import { createAwsKmsOracleKeyProbe } from '../src/blockchain/aws-kms-signer';
import { ManagedSigner } from '../src/blockchain/managed-signer';
import { createOracleReadinessCheck } from '../src/readiness';

const ok = async () => {};
const SECP256K1_SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';

function spkiFor(wallet: { signingKey: { publicKey: string } }): Uint8Array {
  const uncompressed = wallet.signingKey.publicKey.slice(2);
  return Buffer.from(`${SECP256K1_SPKI_PREFIX}${uncompressed}`, 'hex');
}

function readiness(overrides: Partial<Parameters<typeof createOracleReadinessCheck>[0]> = {}) {
  return createOracleReadinessCheck({
    database: ok,
    rpc: ok,
    signer: ok,
    indexer: ok,
    containment: ok,
    ...overrides,
  });
}

describe('oracle readiness', () => {
  test('requires every settlement dependency', async () => {
    const result = await readiness()();

    expect(result.ready).toBe(true);
    expect(result.dependencies.map((dependency) => dependency.name)).toEqual([
      'postgres',
      'chain-rpc',
      'oracle-signer',
      'indexer-graphql',
      'reconciliation-containment',
    ]);
    expect(result.dependencies.every((dependency) => dependency.required)).toBe(true);
  });

  test.each(['database', 'rpc', 'signer', 'indexer', 'containment'] as const)(
    'is not ready when %s fails',
    async (dependency) => {
      const result = await readiness({
        [dependency]: async () => {
          throw new Error('unavailable');
        },
      })();

      expect(result.ready).toBe(false);
      expect(result.dependencies.filter((item) => item.status === 'unavailable')).toHaveLength(1);
    },
  );

  test('reuses a signer success within the ttl but re-probes after a failure', async () => {
    let clock = 0;
    const signer = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('kms throttled'))
      .mockResolvedValueOnce(undefined);
    const check = readiness({ signer, signerSuccessTtlMs: 1_000, now: () => clock });

    expect((await check()).ready).toBe(true);
    clock = 500;
    expect((await check()).ready).toBe(true);
    expect(signer).toHaveBeenCalledTimes(1);

    clock = 1_500;
    expect((await check()).ready).toBe(false);
    expect((await check()).ready).toBe(true);
    expect(signer).toHaveBeenCalledTimes(3);
  });
});

describe('oracle /ready route', () => {
  async function getReady(check: ReturnType<typeof readiness>) {
    const app = express();
    app.use('/api/oracle', createRouter({} as never, check));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/oracle/ready`);
      return { status: response.status, body: await response.json() };
    } finally {
      server.close();
    }
  }

  test('returns 503 with the failing dependency and no error text', async () => {
    const { status, body } = await getReady(
      readiness({
        rpc: async () => {
          throw new Error('https://base.example/v2/secret-api-key timed out');
        },
      }),
    );

    expect(status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'chain-rpc', status: 'unavailable', reason: 'failed' }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('secret-api-key');
  });

  test('keeps liveness independent of dependency failure', async () => {
    const app = express();
    app.use(
      '/api/oracle',
      createRouter(
        {} as never,
        readiness({
          database: async () => {
            throw new Error('down');
          },
        }),
      ),
    );
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const health = await fetch(`http://127.0.0.1:${port}/api/oracle/health`);
      expect(health.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('oracle signer readiness probes', () => {
  const wallet = Wallet.createRandom();

  function kmsClient(publicKey: () => Promise<Uint8Array>): KmsSigningClient {
    return { getPublicKey: jest.fn(publicKey), signDigest: jest.fn() };
  }

  test('KMS probe reads the key now and accepts the reviewed address', async () => {
    const client = kmsClient(async () => spkiFor(wallet));
    const probe = createAwsKmsOracleKeyProbe(
      { keyId: 'alias/oracle', expectedAddress: wallet.address },
      client,
    );

    await expect(probe()).resolves.toBeUndefined();
    await expect(probe()).resolves.toBeUndefined();
    expect(client.getPublicKey).toHaveBeenCalledTimes(2);
  });

  test('KMS probe refuses a replaced key and an unreachable key', async () => {
    const other = Wallet.createRandom();
    await expect(
      createAwsKmsOracleKeyProbe(
        { keyId: 'alias/oracle', expectedAddress: wallet.address },
        kmsClient(async () => spkiFor(other)),
      )(),
    ).rejects.toThrow('no longer matches');

    await expect(
      createAwsKmsOracleKeyProbe(
        { keyId: 'alias/oracle', expectedAddress: wallet.address },
        kmsClient(async () => {
          throw new Error('AccessDeniedException');
        }),
      )(),
    ).rejects.toThrow('AccessDeniedException');
  });

  describe('managed signer', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    function signer() {
      return new ManagedSigner(
        { url: 'https://signer.internal', custodyMode: 'kms', requestTimeoutMs: 1_000 },
        null as never,
      );
    }

    function addressResponse(address: string) {
      return { ok: true, status: 200, json: async () => ({ signerAddress: address }) };
    }

    test('probes the signer on every call instead of trusting the startup cache', async () => {
      global.fetch = jest.fn().mockResolvedValue(addressResponse(wallet.address)) as never;
      const managed = signer();

      await managed.getAddress();
      await managed.checkReadiness();
      await managed.checkReadiness();

      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('refuses a signer that now answers with a different address', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(addressResponse(wallet.address))
        .mockResolvedValueOnce(addressResponse(Wallet.createRandom().address)) as never;
      const managed = signer();

      await managed.getAddress();
      await expect(managed.checkReadiness()).rejects.toThrow('changed since startup');
    });

    test('fails when the signer is unreachable', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as never;

      await expect(signer().checkReadiness()).rejects.toThrow('status 503');
    });
  });
});
