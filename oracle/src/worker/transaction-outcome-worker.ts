import type { SDKClient } from '../blockchain/sdk-client';
import type {
  OracleTransactionOutcomeRecord,
  OracleTransactionOutcomeStore,
} from '../database/transaction-outcome-store';
import { Logger } from '../utils/logger';

const POLL_INTERVAL_MS = 10_000;
const BATCH_SIZE = 100;

export class OracleTransactionOutcomeReconciler {
  constructor(
    private readonly store: OracleTransactionOutcomeStore,
    private readonly sdkClient: Pick<
      SDKClient,
      'getTransactionRecoveryState' | 'getSignerTransactionCount'
    >,
  ) {}

  async processUnresolved(): Promise<void> {
    const records = await this.store.listRecoveryCandidates(BATCH_SIZE);
    for (const record of records) {
      try {
        await this.reconcile(record);
      } catch (error) {
        Logger.error('Oracle transaction outcome recovery failed for record', {
          transactionHash: record.transactionHash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async reconcile(record: OracleTransactionOutcomeRecord): Promise<void> {
    try {
      const { receipt, transaction } = await this.sdkClient.getTransactionRecoveryState(
        record.transactionHash,
      );

      if (receipt) {
        if (receipt.status === 0) {
          await this.store.markReverted(record.transactionHash, Number(receipt.blockNumber));
          Logger.audit('ORACLE_TRANSACTION_REVERTED', record.triggerIdempotencyKey, {
            transactionHash: record.transactionHash,
            blockNumber: Number(receipt.blockNumber),
          });
          return;
        }

        await this.store.markConfirmationPending(
          record.transactionHash,
          Number(receipt.blockNumber),
        );
        Logger.info('Recovered mined Oracle transaction without rebroadcast', {
          transactionHash: record.transactionHash,
          blockNumber: Number(receipt.blockNumber),
        });
        return;
      }

      if (transaction) {
        await this.store.markConfirmationPending(record.transactionHash);
        Logger.info('Recovered pending Oracle transaction without rebroadcast', {
          transactionHash: record.transactionHash,
        });
        return;
      }

      const [latestNonce, pendingNonce] = await Promise.all([
        this.sdkClient.getSignerTransactionCount(record.signerAddress, 'latest'),
        this.sdkClient.getSignerTransactionCount(record.signerAddress, 'pending'),
      ]);
      const failureCode =
        latestNonce > record.nonce || pendingNonce > record.nonce
          ? 'RECOVERY_SIGNER_NONCE_PAST_TRANSACTION'
          : 'RECOVERY_TRANSACTION_NOT_FOUND';
      await this.store.markBroadcastUnknown(record.transactionHash, failureCode);
      Logger.warn('Oracle transaction outcome remains unknown; rebroadcast is blocked', {
        transactionHash: record.transactionHash,
        failureCode,
      });
    } finally {
      await this.store.markRecoveryAttempted(record.transactionHash);
    }
  }
}

export class OracleTransactionOutcomeWorker {
  private intervalId?: NodeJS.Timeout;

  constructor(private readonly reconciler: OracleTransactionOutcomeReconciler) {}

  start(): void {
    if (this.intervalId) {
      return;
    }
    Logger.info('OracleTransactionOutcomeWorker started', {
      pollIntervalMs: POLL_INTERVAL_MS,
      batchSize: BATCH_SIZE,
    });
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.reconciler.processUnresolved();
    } catch (error) {
      Logger.error('Oracle transaction outcome reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
