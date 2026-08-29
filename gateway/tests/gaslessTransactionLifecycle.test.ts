/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { Transaction, Wallet } from 'ethers';
import type { TransactionResponse } from 'ethers';
import {
  broadcastPersistedGaslessTransaction,
  projectPersistedGaslessTransaction,
} from '../src/core/gaslessTransactionLifecycle';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

async function signedTransaction(): Promise<string> {
  return wallet.signTransaction({
    chainId: 84532,
    to: `0x${'2'.repeat(40)}`,
    data: '0x1234',
    value: 0n,
    nonce: 9,
    gasLimit: 210000n,
    type: 2,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
}

function createRecorder() {
  return {
    recordPrepared: jest.fn(async () => undefined),
    markBroadcastUnknown: jest.fn(async () => undefined),
    markConfirmationPending: jest.fn(async () => undefined),
    markConfirmed: jest.fn(async () => undefined),
    markReverted: jest.fn(async () => undefined),
  };
}

const context = {
  applicationRequestId: 'request-raw-1',
  resourceType: 'settlement_handoff' as const,
  resourceId: 'handoff-raw-1',
  operation: 'create_trade',
};

describe('gasless signed transaction persistence boundary', () => {
  test('derives and persists canonical raw-signer identity before one broadcast', async () => {
    const signed = await signedTransaction();
    const parsed = Transaction.from(signed);
    const recorder = createRecorder();
    const broadcast = jest.fn(async () => ({ hash: parsed.hash }) as TransactionResponse);

    const response = await broadcastPersistedGaslessTransaction(
      signed,
      context,
      recorder,
      broadcast,
    );

    expect(response.hash).toBe(parsed.hash);
    expect(recorder.recordPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionHash: parsed.hash,
        applicationRequestId: context.applicationRequestId,
        signerAddress: wallet.address,
        chainId: 84532,
        nonce: 9,
        transactionType: 2,
        gasLimit: '210000',
        maxFeePerGasWei: '10',
      }),
    );
    expect(recorder.recordPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      broadcast.mock.invocationCallOrder[0],
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(recorder.markConfirmationPending).toHaveBeenCalledWith(parsed.hash);
  });

  test('fails closed without any broadcast when identity persistence fails', async () => {
    const signed = await signedTransaction();
    const recorder = createRecorder();
    recorder.recordPrepared.mockRejectedValueOnce(new Error('database unavailable'));
    const broadcast = jest.fn();

    await expect(
      broadcastPersistedGaslessTransaction(signed, context, recorder, broadcast),
    ).rejects.toThrow('database unavailable');
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('records an ambiguous failure and never retries the signed transaction', async () => {
    const signed = await signedTransaction();
    const parsed = Transaction.from(signed);
    const recorder = createRecorder();
    const broadcast = jest.fn(async () => {
      throw Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' });
    });

    await expect(
      broadcastPersistedGaslessTransaction(signed, context, recorder, broadcast),
    ).rejects.toMatchObject({
      outcome: 'broadcast_unknown',
      transactionHash: parsed.hash,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(recorder.markBroadcastUnknown).toHaveBeenCalledWith(parsed.hash, 'TIMEOUT');
  });

  test('keeps a confirmed transaction pending when handoff projection fails', async () => {
    const persistedTransactionHash = `0x${'d'.repeat(64)}`;
    const project = jest.fn(async () => {
      throw new Error('settlement event persistence failed');
    });

    await expect(
      projectPersistedGaslessTransaction(persistedTransactionHash, project),
    ).rejects.toMatchObject({
      outcome: 'confirmation_pending',
      transactionHash: persistedTransactionHash,
    });
    expect(project).toHaveBeenCalledTimes(1);
  });
});
