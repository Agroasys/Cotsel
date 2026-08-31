import type { TransactionReceipt, TransactionResponse } from 'ethers';
import type {
  OracleTransactionOutcomeRecord,
  OracleTransactionOutcomeStore,
} from '../src/database/transaction-outcome-store';
import { OracleTransactionOutcomeReconciler } from '../src/worker/transaction-outcome-worker';

const transactionHash = `0x${'a'.repeat(64)}`;

function record(): OracleTransactionOutcomeRecord {
  return {
    transactionHash,
    triggerIdempotencyKey: 'RELEASE_STAGE_1:1:req-1',
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
    outcomeStatus: 'broadcast_unknown',
    failureCode: 'TIMEOUT',
    blockNumber: null,
  };
}

function dependencies() {
  const store = {
    recordPrepared: jest.fn(),
    markBroadcastUnknown: jest.fn(async () => undefined),
    markConfirmationPending: jest.fn(async () => undefined),
    markReverted: jest.fn(async () => undefined),
    markRecoveryAttempted: jest.fn(async () => undefined),
    listRecoveryCandidates: jest.fn(async () => [record()]),
  } as unknown as jest.Mocked<OracleTransactionOutcomeStore>;
  const sdkClient = {
    getTransactionRecoveryState: jest.fn<
      Promise<{
        receipt: TransactionReceipt | null;
        transaction: TransactionResponse | null;
      }>,
      [string]
    >(),
    getSignerTransactionCount: jest.fn<Promise<number>, [string, 'latest' | 'pending']>(),
  };
  return { store, sdkClient };
}

describe('Oracle transaction outcome reconciliation', () => {
  test('recovers a mined transaction by hash without rebroadcast', async () => {
    const { store, sdkClient } = dependencies();
    sdkClient.getTransactionRecoveryState.mockResolvedValue({
      receipt: { status: 1, blockNumber: 1234 } as TransactionReceipt,
      transaction: null,
    });
    const reconciler = new OracleTransactionOutcomeReconciler(store, sdkClient as never);

    await reconciler.processUnresolved();

    expect(store.markConfirmationPending).toHaveBeenCalledWith(transactionHash, 1234);
    expect(store.markBroadcastUnknown).not.toHaveBeenCalled();
    expect(store.markRecoveryAttempted).toHaveBeenCalledWith(transactionHash);
  });

  test('records a reverted receipt as terminal without rebroadcast', async () => {
    const { store, sdkClient } = dependencies();
    sdkClient.getTransactionRecoveryState.mockResolvedValue({
      receipt: { status: 0, blockNumber: 1235 } as TransactionReceipt,
      transaction: null,
    });
    const reconciler = new OracleTransactionOutcomeReconciler(store, sdkClient as never);

    await reconciler.processUnresolved();

    expect(store.markReverted).toHaveBeenCalledWith(transactionHash, 1235);
    expect(store.markConfirmationPending).not.toHaveBeenCalled();
  });

  test('keeps a missing hash unknown and records nonce drift evidence', async () => {
    const { store, sdkClient } = dependencies();
    sdkClient.getTransactionRecoveryState.mockResolvedValue({ receipt: null, transaction: null });
    sdkClient.getSignerTransactionCount.mockImplementation(async (_address, tag) =>
      tag === 'latest' ? 18 : 19,
    );
    const reconciler = new OracleTransactionOutcomeReconciler(store, sdkClient as never);

    await reconciler.processUnresolved();

    expect(store.markBroadcastUnknown).toHaveBeenCalledWith(
      transactionHash,
      'RECOVERY_SIGNER_NONCE_PAST_TRANSACTION',
    );
    expect(store.markConfirmationPending).not.toHaveBeenCalled();
    expect(store.markReverted).not.toHaveBeenCalled();
  });
});
