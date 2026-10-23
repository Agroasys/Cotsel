/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AbstractProvider } from 'ethers';
import { RpcGovernanceTransactionVerifier } from '../src/core/governanceTransactionVerifier';

const transaction = {
  chainId: 84532,
  from: '0x00000000000000000000000000000000000000AA',
  to: '0x00000000000000000000000000000000000000ff',
  data: '0x8456cb59',
  value: '0',
  nonce: 7,
};

function provider(overrides: Record<string, unknown> = {}) {
  return {
    getNetwork: jest.fn(async () => ({ chainId: 84532n })),
    getBlock: jest.fn(async () => ({ number: 123, hash: `0x${'A'.repeat(64)}` })),
    call: jest.fn(async () => '0x'),
    ...overrides,
  } as unknown as AbstractProvider;
}

describe('RPC governance transaction simulation', () => {
  test('simulates the exact call at an identified block with CCIP read disabled', async () => {
    const rpc = provider();
    const verifier = new RpcGovernanceTransactionVerifier(rpc, `sha256:${'1'.repeat(64)}`);

    await expect(verifier.simulateTransaction(transaction)).resolves.toMatchObject({
      chainId: 84532,
      blockNumber: 123,
      blockHash: `0x${'a'.repeat(64)}`,
      providerIdentity: `sha256:${'1'.repeat(64)}`,
      result: 'success',
      pointInTimeOnly: true,
    });
    expect(rpc.call).toHaveBeenCalledWith({
      ...transaction,
      blockTag: 123,
      enableCcipRead: false,
    });
  });

  test('rejects a provider on the wrong chain before simulation', async () => {
    const rpc = provider({ getNetwork: jest.fn(async () => ({ chainId: 1n })) });
    const verifier = new RpcGovernanceTransactionVerifier(rpc, `sha256:${'1'.repeat(64)}`);

    await expect(verifier.simulateTransaction(transaction)).rejects.toThrow('chain');
    expect(rpc.call).not.toHaveBeenCalled();
  });

  test('propagates a reverting exact call to the preparation boundary', async () => {
    const rpc = provider({ call: jest.fn(async () => Promise.reject(new Error('reverted'))) });
    const verifier = new RpcGovernanceTransactionVerifier(rpc, `sha256:${'1'.repeat(64)}`);

    await expect(verifier.simulateTransaction(transaction)).rejects.toThrow('reverted');
  });
});

describe('RPC governance finality observation', () => {
  const blockHash = `0x${'a'.repeat(64)}`;
  const txHash = `0x${'c'.repeat(64)}`;

  function finalityProvider(overrides: Record<string, unknown> = {}) {
    return provider({
      getBlockNumber: jest.fn(async () => 130),
      getTransactionReceipt: jest.fn(async () => ({ blockNumber: 100, blockHash, status: 1 })),
      getBlock: jest.fn(async (tag: string | number) =>
        tag === 'safe'
          ? { number: 120, hash: blockHash }
          : tag === 'finalized'
            ? { number: 110, hash: blockHash }
            : { number: tag, hash: blockHash },
      ),
      ...overrides,
    });
  }

  test('reports tags, receipt and canonical block from one provider identity', async () => {
    const verifier = new RpcGovernanceTransactionVerifier(
      finalityProvider(),
      `sha256:${'1'.repeat(64)}`,
    );

    await expect(verifier.observeTransactionFinality(txHash)).resolves.toEqual({
      providerId: `sha256:${'1'.repeat(64)}`,
      chainId: 84532,
      latestBlockNumber: 130,
      safeBlockNumber: 120,
      finalizedBlockNumber: 110,
      receipt: { blockNumber: 100, blockHash, status: 1 },
      canonicalBlockHash: blockHash,
    });
  });

  test('records an explicitly rejected block tag as unsupported', async () => {
    const rpc = finalityProvider({
      getBlock: jest.fn(async (tag: string | number) => {
        if (tag === 'safe' || tag === 'finalized') throw new Error('invalid block tag safe');
        return { number: tag, hash: blockHash };
      }),
    });
    const verifier = new RpcGovernanceTransactionVerifier(rpc, `sha256:${'1'.repeat(64)}`);

    await expect(verifier.observeTransactionFinality(txHash)).resolves.toMatchObject({
      safeBlockNumber: 'unsupported',
      finalizedBlockNumber: 'unsupported',
    });
  });

  test('propagates other tag read failures instead of weakening silently', async () => {
    const rpc = finalityProvider({
      getBlock: jest.fn(async () => Promise.reject(new Error('socket hang up'))),
    });
    const verifier = new RpcGovernanceTransactionVerifier(rpc, `sha256:${'1'.repeat(64)}`);

    await expect(verifier.observeTransactionFinality(txHash)).rejects.toThrow('socket hang up');
  });

  test('omits the canonical block when there is no receipt', async () => {
    const rpc = finalityProvider({ getTransactionReceipt: jest.fn(async () => null) });
    const verifier = new RpcGovernanceTransactionVerifier(rpc, `sha256:${'1'.repeat(64)}`);

    await expect(verifier.observeTransactionFinality(txHash)).resolves.toMatchObject({
      receipt: null,
      canonicalBlockHash: null,
    });
  });
});
