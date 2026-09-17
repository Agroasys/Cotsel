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
