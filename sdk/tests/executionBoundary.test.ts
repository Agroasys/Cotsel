/** SPDX-License-Identifier: Apache-2.0 */
import { Transaction } from 'ethers';
import {
  createExecutionRouter,
  type ExecutionAdapter,
  type ExecutionAlert,
  type ExecutionCapability,
} from '../src/execution';
import {
  createFakeProvider,
  signedTransaction,
  signingIntent,
  signerWallet,
  validPayload,
} from './fixtures/fakeExecutionProvider';

function routerFor<C extends ExecutionCapability>(
  adapter: ExecutionAdapter<C>,
  alerts: ExecutionAlert[] = [],
) {
  return createExecutionRouter({
    config: {
      custodyMode: 'non_custodial',
      adapters: { [adapter.descriptor.capability]: adapter.descriptor.id },
    },
    adapters: [adapter] as Parameters<typeof createExecutionRouter>[0]['adapters'],
    onAlert: (alert) => alerts.push(alert),
  });
}

const requestContext = {
  idempotencyKey: 'boundary-test',
  settlementId: 'settlement-1',
  settlementCustodyMode: 'non_custodial' as const,
};

describe('chain submission boundary', () => {
  test.each(['unsigned', 'wrong-chain'] as const)('%s never reaches the provider', async (kind) => {
    const provider = createFakeProvider('chain');
    const router = routerFor(provider.adapter);
    const tx = Transaction.from(await signedTransaction());
    const serialized =
      kind === 'unsigned'
        ? tx.unsignedSerialized
        : await signerWallet.signTransaction({ ...tx.toJSON(), chainId: 1, signature: undefined });
    const request = {
      ...requestContext,
      payload: { chainId: 84532, signedTransaction: serialized },
    };
    await expect(router.preflight('chain', request)).rejects.toMatchObject({
      rejection: 'payload_invalid',
    });
    await expect(router.submit('chain', request)).rejects.toMatchObject({
      rejection: 'payload_invalid',
    });
    expect(provider.operations()).toBe(0);
  });
});

describe('request and replay isolation', () => {
  test('concurrent callers receive independent observations from one provider operation', async () => {
    const provider = createFakeProvider('wallet');
    const router = routerFor(provider.adapter);
    const request = { ...requestContext, payload: validPayload('wallet', '') };
    const [first, second] = await Promise.all([
      router.submit('wallet', request),
      router.submit('wallet', request),
    ]);
    expect(first.observation).toEqual(second.observation);
    first.observation!.address = 'mutated';
    expect(second.observation!.address).toBe(signerWallet.address);
    expect(provider.operations()).toBe(1);
  });

  test('caller mutation after submit cannot change the signed intent or its stored expectation', async () => {
    const provider = createFakeProvider('signing');
    const router = routerFor(provider.adapter);
    const original = { ...requestContext, payload: { intent: signingIntent(7) } };
    const request = structuredClone(original);
    const pending = router.submit('signing', request);
    request.payload.intent.nonce = 8;
    const first = await pending;
    expect(first.outcome).toBe('succeeded');
    expect(Transaction.from(first.observation!.signedTransaction!).nonce).toBe(7);
    expect(await router.status('signing', requestContext)).toMatchObject({ outcome: 'succeeded' });
    expect(await router.submit('signing', original)).toMatchObject({
      outcome: 'succeeded',
      observation: first.observation,
    });
    await expect(router.submit('signing', request)).rejects.toMatchObject({
      name: 'ExecutionIdempotencyConflictError',
    });
    expect(provider.operations()).toBe(1);
  });

  test('adapter mutation cannot rewrite the approved signing expectation', async () => {
    const provider = createFakeProvider('signing');
    const adapter: ExecutionAdapter<'signing'> = {
      ...provider.adapter,
      async submit(context, payload) {
        payload.intent.nonce = 8;
        return provider.adapter.submit(context, payload);
      },
    };
    const router = routerFor(adapter);
    const result = await router.submit('signing', {
      ...requestContext,
      payload: { intent: signingIntent(7) },
    });
    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'observation_mismatch:signature_nonce',
    });
  });

  test.each(['wallet', 'signing'] as const)(
    '%s replays retain the complete verified result',
    async (capability) => {
      const provider = createFakeProvider(capability);
      const router = routerFor(provider.adapter);
      const request = { ...requestContext, payload: validPayload(capability, '') };
      const first = await router.submit(capability, request);
      const expected = structuredClone(first.observation);
      expect(expected).toBeDefined();
      first.observation!.address = 'caller-mutated';
      first.observation!.signedTransaction = 'caller-mutated';
      const replay = await router.submit(capability, request);
      expect(replay).toMatchObject({ outcome: 'succeeded', replayed: true, observation: expected });
      replay.observation!.address = 'replay-mutated';
      expect((await router.submit(capability, request)).observation).toEqual(expected);
      expect(provider.operations()).toBe(1);
    },
  );
});

describe('malformed observations', () => {
  test.each([null, 42, {}, []])(
    'a non-string hash %p becomes unknown, is alerted and is never resubmitted',
    async (hash) => {
      const provider = createFakeProvider('chain');
      const malformed = {
        outcome: 'succeeded' as const,
        operationRef: 'op-1',
        observation: { transactionHash: hash },
      };
      let calls = 0;
      const adapter: ExecutionAdapter<'chain'> = {
        ...provider.adapter,
        async submit() {
          calls += 1;
          return malformed as never;
        },
        async status() {
          return malformed as never;
        },
      };
      const alerts: ExecutionAlert[] = [];
      const router = routerFor(adapter, alerts);
      const request = {
        ...requestContext,
        payload: validPayload('chain', await signedTransaction()),
      };
      const first = await router.submit('chain', request);
      expect(first).toMatchObject({
        outcome: 'unknown',
        reason: 'observation_mismatch:observation_invalid',
      });
      expect(await router.submit('chain', request)).toMatchObject({ ...first, replayed: true });
      expect(await router.status('chain', requestContext)).toMatchObject({
        outcome: 'unknown',
        reason: first.reason,
      });
      expect(alerts).toContainEqual(
        expect.objectContaining({ code: 'observation_mismatch', detail: 'observation_invalid' }),
      );
      expect(calls).toBe(1);
    },
  );

  test('a malformed status does not overwrite a previously verified success', async () => {
    const provider = createFakeProvider('chain');
    const adapter: ExecutionAdapter<'chain'> = {
      ...provider.adapter,
      async status() {
        return {
          outcome: 'succeeded',
          operationRef: 'op-1',
          observation: { transactionHash: null },
        } as never;
      },
    };
    const router = routerFor(adapter);
    const request = {
      ...requestContext,
      payload: validPayload('chain', await signedTransaction()),
    };
    const first = await router.submit('chain', request);
    expect(first.outcome).toBe('succeeded');
    expect(await router.status('chain', requestContext)).toMatchObject({ outcome: 'unknown' });
    expect(await router.submit('chain', request)).toMatchObject({
      outcome: 'succeeded',
      observation: first.observation,
    });
    expect(provider.operations()).toBe(1);
  });
});
