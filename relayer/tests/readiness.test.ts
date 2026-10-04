import type { AddressInfo } from 'net';
import { GetPublicKeyCommand, KeySpec, KeyUsageType, SignCommand } from '@aws-sdk/client-kms';
import { createInMemoryNonceStore, type NonceStore } from '@agroasys/shared-auth';
import { getBytes, hexlify, SigningKey, Wallet } from 'ethers';
import { createRelayerApp } from '../src/app';
import { createKmsRelayerSigner } from '../src/kmsRelayerSigner';
import { createRelayerReadinessCheck } from '../src/readiness';
import { config, relayerWallet } from './helpers';

function spkiPublicKey(privateKey: string): Uint8Array {
  const prefix = getBytes('0x3056301006072a8648ce3d020106052b8104000a034200');
  return Uint8Array.from([...prefix, ...getBytes(SigningKey.computePublicKey(privateKey, false))]);
}

function kmsReturning(privateKey: string) {
  return {
    send: jest.fn(async (command: unknown) => {
      if (command instanceof SignCommand) {
        const signature = new SigningKey(privateKey).sign(hexlify(command.input.Message!));
        const integer = (value: string) => {
          let bytes = getBytes(value);
          while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
          if (bytes[0] & 0x80) bytes = Uint8Array.from([0, ...bytes]);
          return Uint8Array.from([0x02, bytes.length, ...bytes]);
        };
        const r = integer(signature.r);
        const s = integer(signature.s);
        return { Signature: Uint8Array.from([0x30, r.length + s.length, ...r, ...s]) };
      }
      if (!(command instanceof GetPublicKeyCommand)) {
        throw new Error('unexpected KMS command');
      }
      return {
        KeySpec: KeySpec.ECC_SECG_P256K1,
        KeyUsage: KeyUsageType.SIGN_VERIFY,
        PublicKey: spkiPublicKey(privateKey),
      };
    }),
  };
}

describe('relayer readiness', () => {
  test('KMS probe reads the key every time and accepts only the reviewed address', async () => {
    const kms = kmsReturning(relayerWallet.privateKey);
    const signer = createKmsRelayerSigner(config, kms as never);

    await signer.getAddress();
    await signer.checkReadiness();
    await signer.checkReadiness();
    expect(kms.send).toHaveBeenCalledTimes(5);

    const replaced = createKmsRelayerSigner(
      config,
      kmsReturning(Wallet.createRandom().privateKey) as never,
    );
    await expect(replaced.checkReadiness()).rejects.toThrow('no longer matches');
  });

  test('refuses readiness when GetPublicKey succeeds but Sign is denied', async () => {
    const kms = kmsReturning(relayerWallet.privateKey);
    const originalSend = kms.send.getMockImplementation()!;
    kms.send.mockImplementation(async (command) => {
      if (command instanceof SignCommand) throw new Error('Sign AccessDeniedException');
      return originalSend(command);
    });
    const signer = createKmsRelayerSigner(config, kms as never);
    const result = await createRelayerReadinessCheck({
      signerProbe: () => signer.checkReadiness(),
    })();
    expect(result.ready).toBe(false);
    expect(result.dependencies[0]).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('AccessDenied');
  });

  test('reuses a signer success within the ttl and re-probes after a failure', async () => {
    let clock = 0;
    const signerProbe = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValueOnce(undefined);
    const check = createRelayerReadinessCheck({
      signerProbe,
      signerSuccessTtlMs: 1_000,
      now: () => clock,
    });

    expect((await check()).ready).toBe(true);
    clock = 500;
    expect((await check()).ready).toBe(true);
    clock = 1_500;
    expect((await check()).ready).toBe(false);
    expect((await check()).ready).toBe(true);
    expect(signerProbe).toHaveBeenCalledTimes(3);
  });

  test('requires the shared replay store when one is configured', async () => {
    const failing: NonceStore = {
      consume: async () => {
        throw new Error('connect ECONNREFUSED redis://:secret@10.0.0.5:6379');
      },
      close: async () => {},
    };
    const result = await createRelayerReadinessCheck({
      signerProbe: async () => {},
      replayStore: failing,
    })();

    expect(result.ready).toBe(false);
    expect(result.dependencies).toEqual([
      { name: 'kms-signer', required: true, status: 'ok' },
      { name: 'replay-store', required: true, status: 'unavailable', reason: 'failed' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');

    const healthy = await createRelayerReadinessCheck({
      signerProbe: async () => {},
      replayStore: createInMemoryNonceStore(),
    })();
    expect(healthy.ready).toBe(true);
  });

  test('bounds a hung KMS call by the timeout', async () => {
    const result = await createRelayerReadinessCheck({
      signerProbe: () => new Promise(() => {}),
      timeoutMs: 50,
    })();

    expect(result.dependencies[0]).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });

  test('serves /ready separately from /health and fails closed without a check', async () => {
    const signer = { getAddress: async () => relayerWallet.address, signTransaction: jest.fn() };
    const apps = [
      createRelayerApp(config, {
        signer,
        authNonceStore: createInMemoryNonceStore(),
        requestStore: createInMemoryNonceStore(),
        readinessCheck: createRelayerReadinessCheck({
          signerProbe: async () => {
            throw new Error('AccessDeniedException');
          },
        }),
      }),
      createRelayerApp(config, {
        signer,
        authNonceStore: createInMemoryNonceStore(),
        requestStore: createInMemoryNonceStore(),
      }),
    ];

    for (const app of apps) {
      const server = app.listen(0);
      try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/relayer`;
        expect((await fetch(`${base}/health`)).status).toBe(200);
        const ready = await fetch(`${base}/ready`);
        expect(ready.status).toBe(503);
        expect(JSON.stringify(await ready.json())).not.toContain('AccessDenied');
      } finally {
        server.close();
      }
    }
  });
});
