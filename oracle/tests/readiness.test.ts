import express from 'express';
import type { AddressInfo } from 'net';
import { getBytes, hexlify, Wallet } from 'ethers';
import type { KmsSigningClient } from '@agroasys/sdk';

jest.mock('../src/config', () => ({
  config: { apiKey: 'test-api-key', hmacSecret: 'test-hmac-secret', hmacNonceTtlSeconds: 600 },
}));

import { createRouter } from '../src/api/routes';
import {
  buildContainmentGuard,
  isContainmentConfigured,
  isContainmentRequired,
} from '../src/core/containment-guard';
import type { OracleConfig } from '../src/types';
import { createAwsKmsOracleKeyProbe } from '../src/blockchain/aws-kms-signer';
import { ManagedSigner } from '../src/blockchain/managed-signer';
import { createOracleReadinessCheck } from '../src/readiness';

const ok = async () => {};
const SECP256K1_SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';

function spkiFor(wallet: { signingKey: { publicKey: string } }): Uint8Array {
  const uncompressed = wallet.signingKey.publicKey.slice(2);
  return Buffer.from(`${SECP256K1_SPKI_PREFIX}${uncompressed}`, 'hex');
}

function derSignature(
  wallet: Wallet | ReturnType<typeof Wallet.createRandom>,
  digest: Uint8Array,
): Uint8Array {
  const signature = wallet.signingKey.sign(hexlify(digest));
  const integer = (value: string) => {
    let bytes = getBytes(value);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes[0] & 0x80) bytes = Uint8Array.from([0, ...bytes]);
    return Uint8Array.from([0x02, bytes.length, ...bytes]);
  };
  const r = integer(signature.r);
  const s = integer(signature.s);
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
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

describe('oracle reconciliation containment readiness', () => {
  const unconfigured = { cotselEnvironment: 'staging' } as OracleConfig;

  test('an unconfigured guard never reports a successful readiness check', async () => {
    const guard = buildContainmentGuard(unconfigured);

    expect(isContainmentConfigured(unconfigured)).toBe(false);
    await expect(guard.checkReadiness()).rejects.toThrow('not configured');
  });

  test.each(['staging', 'production'])(
    'fails readiness in %s when no reconciliation reader is configured',
    async (cotselEnvironment) => {
      const config = { cotselEnvironment } as OracleConfig;
      expect(isContainmentRequired(config)).toBe(true);

      const result = await readiness({
        containment: () => buildContainmentGuard(config).checkReadiness(),
        containmentMode: 'required',
      })();

      expect(result.ready).toBe(false);
      expect(
        result.dependencies.find((item) => item.name === 'reconciliation-containment'),
      ).toMatchObject({ required: true, status: 'unavailable', reason: 'failed' });
    },
  );

  test('reports containment as disabled, not ok, in a local profile without a reader', async () => {
    expect(isContainmentRequired({ cotselEnvironment: 'development' } as OracleConfig)).toBe(false);
    const containment = jest.fn();

    const result = await readiness({ containment, containmentMode: 'disabled' })();

    expect(result.ready).toBe(true);
    expect(containment).not.toHaveBeenCalled();
    expect(
      result.dependencies.find((item) => item.name === 'reconciliation-containment'),
    ).toMatchObject({ required: false, status: 'disabled' });
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
    return {
      getPublicKey: jest.fn(publicKey),
      signDigest: jest.fn(async (_keyId, digest) => derSignature(wallet, digest)),
    };
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
    expect(client.signDigest).toHaveBeenCalledTimes(2);
    const calls = (client.signDigest as jest.Mock).mock.calls;
    expect(hexlify(calls[0][1])).not.toBe(hexlify(calls[1][1]));
  });

  test('KMS readiness fails when GetPublicKey succeeds but Sign is denied', async () => {
    const client = kmsClient(async () => spkiFor(wallet));
    client.signDigest = jest.fn().mockRejectedValue(new Error('Sign AccessDeniedException'));
    const signer = createAwsKmsOracleKeyProbe(
      { keyId: 'alias/oracle', expectedAddress: wallet.address },
      client,
    );
    await expect(signer()).rejects.toThrow('Sign AccessDeniedException');
    const result = await readiness({ signer })();
    expect(result.ready).toBe(false);
    expect(result.dependencies.find((item) => item.name === 'oracle-signer')).toMatchObject({
      status: 'unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('AccessDenied');
  });

  test('KMS readiness rejects a signature made by another key', async () => {
    const client = kmsClient(async () => spkiFor(wallet));
    client.signDigest = async (_keyId, digest) => derSignature(Wallet.createRandom(), digest);
    await expect(
      createAwsKmsOracleKeyProbe(
        { keyId: 'alias/oracle', expectedAddress: wallet.address },
        client,
      )(),
    ).rejects.toThrow('expected signer address');
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
        { getNetwork: async () => ({ chainId: 84532n }) } as never,
      );
    }

    function addressResponse(address: string) {
      return { ok: true, status: 200, json: async () => ({ signerAddress: address }) };
    }

    test('probes the signer on every call instead of trusting the startup cache', async () => {
      global.fetch = jest.fn(async (_url, init: RequestInit) => {
        if (init.method === 'GET') return addressResponse(wallet.address);
        const body = JSON.parse(String(init.body));
        const tx = body.transaction;
        expect(tx.gasLimit).toBe('0');
        expect(tx.value).toBe('0');
        expect(tx.to).toBe(wallet.address);
        expect(tx.chainId).toBe(84532);
        const signedTransaction = await wallet.signTransaction({
          ...tx,
          maxFeePerGas: tx.maxFeePerGasWei,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGasWei,
        });
        return {
          ...addressResponse(wallet.address),
          json: async () => ({
            signerAddress: wallet.address,
            signedTransaction,
            requestId: body.requestId,
            intentHash: body.intentHash,
          }),
        };
      }) as never;
      const managed = signer();

      await managed.getAddress();
      await managed.checkReadiness();
      await managed.checkReadiness();

      expect(global.fetch).toHaveBeenCalledTimes(5);
    });

    test('fails when the address route succeeds but the signing POST fails', async () => {
      global.fetch = jest.fn(async (_url, init: RequestInit) =>
        init.method === 'GET' ? addressResponse(wallet.address) : { ok: false, status: 403 },
      ) as never;
      await expect(signer().checkReadiness()).rejects.toThrow('status 403');
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
