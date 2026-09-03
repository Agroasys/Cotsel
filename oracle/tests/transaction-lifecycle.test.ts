import { Transaction, Wallet, type TransactionResponse } from 'ethers';
import { broadcastPersistedOracleTransaction } from '../src/blockchain/transaction-lifecycle';
import type { OracleTransactionOutcomeStore } from '../src/database/transaction-outcome-store';

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const escrowAddress = `0x${'2'.repeat(40)}`;

async function signedTransaction(chainId = 84532): Promise<string> {
  return wallet.signTransaction({
    chainId,
    to: escrowAddress,
    data: '0x1234',
    value: 0n,
    nonce: 11,
    gasLimit: 210000n,
    type: 2,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
}

function createStore(): jest.Mocked<OracleTransactionOutcomeStore> {
  return {
    recordPrepared: jest.fn(async () => undefined),
    markBroadcastUnknown: jest.fn(async () => undefined),
    markConfirmationPending: jest.fn(async () => undefined),
    markReverted: jest.fn(async () => undefined),
    markRecoveryAttempted: jest.fn(async () => undefined),
    listRecoveryCandidates: jest.fn(async () => []),
  } as unknown as jest.Mocked<OracleTransactionOutcomeStore>;
}

describe('Oracle durable transaction lifecycle', () => {
  test('persists canonical identity before exactly one broadcast', async () => {
    const signed = await signedTransaction();
    const transaction = Transaction.from(signed);
    const store = createStore();
    const broadcast = jest.fn(async () => ({ hash: transaction.hash }) as TransactionResponse);

    const response = await broadcastPersistedOracleTransaction(
      signed,
      {
        triggerIdempotencyKey: 'RELEASE_STAGE_1:1:req-1',
        expectedChainId: 84532,
        expectedDestination: escrowAddress,
      },
      store,
      broadcast,
    );

    expect(response.hash).toBe(transaction.hash);
    expect(store.recordPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionHash: transaction.hash,
        triggerIdempotencyKey: 'RELEASE_STAGE_1:1:req-1',
        signerAddress: wallet.address,
        nonce: 11,
        chainId: 84532,
        destinationAddress: escrowAddress,
      }),
    );
    expect(store.recordPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      broadcast.mock.invocationCallOrder[0],
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(store.markConfirmationPending).toHaveBeenCalledWith(transaction.hash);
  });

  test('does not broadcast when durable identity persistence fails', async () => {
    const signed = await signedTransaction();
    const store = createStore();
    store.recordPrepared.mockRejectedValueOnce(new Error('database unavailable'));
    const broadcast = jest.fn();

    await expect(
      broadcastPersistedOracleTransaction(
        signed,
        {
          triggerIdempotencyKey: 'RELEASE_STAGE_1:1:req-2',
          expectedChainId: 84532,
          expectedDestination: escrowAddress,
        },
        store,
        broadcast,
      ),
    ).rejects.toThrow('database unavailable');
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('records an ambiguous provider failure and never retries broadcast', async () => {
    const signed = await signedTransaction();
    const transaction = Transaction.from(signed);
    const store = createStore();
    const broadcast = jest.fn(async () => {
      throw Object.assign(new Error('provider timeout'), { code: 'TIMEOUT' });
    });

    await expect(
      broadcastPersistedOracleTransaction(
        signed,
        {
          triggerIdempotencyKey: 'RELEASE_STAGE_1:1:req-3',
          expectedChainId: 84532,
          expectedDestination: escrowAddress,
        },
        store,
        broadcast,
      ),
    ).rejects.toMatchObject({
      transactionHash: transaction.hash,
      outcome: 'broadcast_unknown',
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(store.markBroadcastUnknown).toHaveBeenCalledWith(transaction.hash, 'TIMEOUT');
  });

  test('rejects a wrong-chain signed transaction before persistence and broadcast', async () => {
    const store = createStore();
    const broadcast = jest.fn();

    await expect(
      broadcastPersistedOracleTransaction(
        await signedTransaction(1),
        {
          triggerIdempotencyKey: 'RELEASE_STAGE_1:1:req-4',
          expectedChainId: 84532,
          expectedDestination: escrowAddress,
        },
        store,
        broadcast,
      ),
    ).rejects.toThrow('chain does not match');
    expect(store.recordPrepared).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
