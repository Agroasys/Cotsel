/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TransactionReceipt, TransactionResponse } from 'ethers';
import { GaslessTransactionOutcomeReconciler } from '../src/core/gaslessTransactionOutcomeReconciler';
import type {
  GaslessTransactionOutcomeRecord,
  GaslessTransactionOutcomeStore,
} from '../src/core/gaslessTransactionOutcomeStore';

const transactionHash = `0x${'a'.repeat(64)}`;

function buildRecord(
  outcomeStatus: GaslessTransactionOutcomeRecord['outcomeStatus'],
): GaslessTransactionOutcomeRecord {
  return {
    transactionHash,
    applicationRequestId: 'request-1',
    resourceType: 'settlement_handoff',
    resourceId: 'handoff-1',
    operation: 'create_trade',
    chainId: 84532,
    signerAddress: `0x${'1'.repeat(40)}`,
    nonce: 17,
    transactionType: 2,
    destinationAddress: `0x${'2'.repeat(40)}`,
    valueWei: '0',
    gasLimit: '210000',
    maxFeePerGasWei: '10',
    maxPriorityFeePerGasWei: '1',
    gasPriceWei: null,
    calldataHash: `0x${'b'.repeat(64)}`,
    intentHash: `0x${'c'.repeat(64)}`,
    outcomeStatus,
    projectedOutcomeStatus: null,
    failureCode: null,
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

function createDependencies(record: GaslessTransactionOutcomeRecord) {
  const store = {
    listRecoveryCandidates: jest.fn(async () => [record]),
    recordPrepared: jest.fn(),
    markBroadcastUnknown: jest.fn(async () => undefined),
    markConfirmationPending: jest.fn(async () => undefined),
    markConfirmed: jest.fn(async () => undefined),
    markReverted: jest.fn(async () => undefined),
    markRecoveryAttempted: jest.fn(async () => undefined),
    markProjectionApplied: jest.fn(async () => undefined),
  } satisfies GaslessTransactionOutcomeStore;
  const provider = {
    getTransactionReceipt: jest.fn<Promise<TransactionReceipt | null>, [string]>(),
    getTransaction: jest.fn<Promise<TransactionResponse | null>, [string]>(),
    getTransactionCount: jest.fn<Promise<number>, [string, 'latest' | 'pending']>(
      async () => record.nonce,
    ),
  };
  const observer = {
    onBroadcastUnknown: jest.fn(async () => undefined),
    onConfirmationPending: jest.fn(async () => undefined),
    onConfirmed: jest.fn(async () => undefined),
    onReverted: jest.fn(async () => undefined),
  };
  return { store, provider, observer };
}

function confirmedReceipt(status = 1): TransactionReceipt {
  return {
    status,
    blockNumber: 1234,
    blockHash: `0x${'d'.repeat(64)}`,
    gasUsed: 210000n,
    gasPrice: 2n,
  } as unknown as TransactionReceipt;
}

describe('gasless transaction outcome restart recovery', () => {
  test('projects and records the original confirmed transaction without rebroadcast', async () => {
    const dependencies = createDependencies(buildRecord('confirmation_pending'));
    dependencies.provider.getTransactionReceipt.mockResolvedValue(confirmedReceipt());
    const reconciler = new GaslessTransactionOutcomeReconciler(
      dependencies.store,
      dependencies.provider,
      dependencies.observer,
      5000,
    );

    await reconciler.processUnresolved();

    expect(dependencies.observer.onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ transactionHash }),
      expect.objectContaining({ blockNumber: '1234' }),
    );
    expect(dependencies.store.markConfirmed).toHaveBeenCalledWith(
      transactionHash,
      expect.objectContaining({ blockNumber: '1234' }),
    );
    expect(dependencies.store.markProjectionApplied).toHaveBeenCalledWith(
      transactionHash,
      'confirmed',
    );
    expect(dependencies.provider.getTransaction).not.toHaveBeenCalled();
    expect(dependencies.store.markRecoveryAttempted).toHaveBeenCalledWith(transactionHash);
  });

  test('keeps a visible unknown state when a prepared hash is absent from the provider', async () => {
    const dependencies = createDependencies(buildRecord('broadcast_pending'));
    dependencies.provider.getTransactionReceipt.mockResolvedValue(null);
    dependencies.provider.getTransaction.mockResolvedValue(null);
    const reconciler = new GaslessTransactionOutcomeReconciler(
      dependencies.store,
      dependencies.provider,
      dependencies.observer,
      5000,
    );

    await reconciler.processUnresolved();

    expect(dependencies.store.markBroadcastUnknown).toHaveBeenCalledWith(
      transactionHash,
      'RECOVERY_TRANSACTION_NOT_FOUND',
    );
    expect(dependencies.observer.onBroadcastUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionHash,
        outcomeStatus: 'broadcast_unknown',
      }),
    );
    expect(dependencies.store.markProjectionApplied).toHaveBeenCalledWith(
      transactionHash,
      'broadcast_unknown',
    );
    expect(dependencies.store.markConfirmed).not.toHaveBeenCalled();
    expect(dependencies.store.markReverted).not.toHaveBeenCalled();
  });

  test('projects an existing unknown outcome without broadcasting it again', async () => {
    const dependencies = createDependencies({
      ...buildRecord('broadcast_unknown'),
      failureCode: 'RECOVERY_TRANSACTION_NOT_FOUND',
    });
    dependencies.provider.getTransactionReceipt.mockResolvedValue(null);
    dependencies.provider.getTransaction.mockResolvedValue(null);
    const reconciler = new GaslessTransactionOutcomeReconciler(
      dependencies.store,
      dependencies.provider,
      dependencies.observer,
      5000,
    );

    await reconciler.processUnresolved();

    expect(dependencies.store.markBroadcastUnknown).not.toHaveBeenCalled();
    expect(dependencies.observer.onBroadcastUnknown).toHaveBeenCalledWith(
      expect.objectContaining({ transactionHash, outcomeStatus: 'broadcast_unknown' }),
    );
    expect(dependencies.store.markProjectionApplied).toHaveBeenCalledWith(
      transactionHash,
      'broadcast_unknown',
    );
  });

  test('records an on-chain revert as terminal and projects the same hash', async () => {
    const dependencies = createDependencies(buildRecord('broadcast_unknown'));
    dependencies.provider.getTransactionReceipt.mockResolvedValue(confirmedReceipt(0));
    const reconciler = new GaslessTransactionOutcomeReconciler(
      dependencies.store,
      dependencies.provider,
      dependencies.observer,
      5000,
    );

    await reconciler.processUnresolved();

    expect(dependencies.observer.onReverted).toHaveBeenCalledTimes(1);
    expect(dependencies.store.markReverted).toHaveBeenCalledWith(
      transactionHash,
      expect.objectContaining({ blockNumber: '1234' }),
    );
    expect(dependencies.store.markProjectionApplied).toHaveBeenCalledWith(
      transactionHash,
      'reverted',
    );
  });

  test('keeps the original hash blocked when the signer confirmed a later nonce', async () => {
    const dependencies = createDependencies(buildRecord('confirmation_pending'));
    dependencies.provider.getTransactionReceipt.mockResolvedValue(null);
    dependencies.provider.getTransaction.mockResolvedValue(null);
    dependencies.provider.getTransactionCount.mockImplementation(async (_address, blockTag) =>
      blockTag === 'latest' ? 18 : 19,
    );
    const reconciler = new GaslessTransactionOutcomeReconciler(
      dependencies.store,
      dependencies.provider,
      dependencies.observer,
      5000,
    );

    await reconciler.processUnresolved();

    expect(dependencies.store.markBroadcastUnknown).toHaveBeenCalledWith(
      transactionHash,
      'RECOVERY_SIGNER_NONCE_CONFIRMED_PAST_TRANSACTION',
    );
    expect(dependencies.observer.onBroadcastUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionHash,
        outcomeStatus: 'broadcast_unknown',
        failureCode: 'RECOVERY_SIGNER_NONCE_CONFIRMED_PAST_TRANSACTION',
      }),
    );
    expect(dependencies.store.markConfirmed).not.toHaveBeenCalled();
    expect(dependencies.store.markReverted).not.toHaveBeenCalled();
  });

  test('does not append duplicate unknown evidence when hash and nonce truth are unchanged', async () => {
    const record = {
      ...buildRecord('broadcast_unknown'),
      projectedOutcomeStatus: 'broadcast_unknown' as const,
      failureCode: 'RECOVERY_TRANSACTION_NOT_FOUND',
    };
    const dependencies = createDependencies(record);
    dependencies.provider.getTransactionReceipt.mockResolvedValue(null);
    dependencies.provider.getTransaction.mockResolvedValue(null);
    const reconciler = new GaslessTransactionOutcomeReconciler(
      dependencies.store,
      dependencies.provider,
      dependencies.observer,
      5000,
    );

    await reconciler.processUnresolved();

    expect(dependencies.store.markBroadcastUnknown).not.toHaveBeenCalled();
    expect(dependencies.observer.onBroadcastUnknown).not.toHaveBeenCalled();
    expect(dependencies.store.markProjectionApplied).not.toHaveBeenCalled();
    expect(dependencies.store.markRecoveryAttempted).toHaveBeenCalledWith(transactionHash);
  });
});
