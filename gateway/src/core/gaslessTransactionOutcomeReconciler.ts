/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TransactionReceipt, TransactionResponse } from 'ethers';
import { Logger } from '../logging/logger';
import type {
  GaslessConfirmedOutcome,
  GaslessTransactionOutcomeRecord,
  GaslessTransactionOutcomeStore,
} from './gaslessTransactionOutcomeStore';

interface GaslessOutcomeProvider {
  getTransactionReceipt(transactionHash: string): Promise<TransactionReceipt | null>;
  getTransaction(transactionHash: string): Promise<TransactionResponse | null>;
  getTransactionCount(address: string, blockTag: 'latest' | 'pending'): Promise<number>;
}

export interface GaslessOutcomeObserver {
  onBroadcastUnknown(record: GaslessTransactionOutcomeRecord): Promise<void>;
  onConfirmationPending(record: GaslessTransactionOutcomeRecord): Promise<void>;
  onConfirmed(
    record: GaslessTransactionOutcomeRecord,
    outcome: GaslessConfirmedOutcome,
  ): Promise<void>;
  onReverted(
    record: GaslessTransactionOutcomeRecord,
    outcome: GaslessConfirmedOutcome,
  ): Promise<void>;
}

function receiptOutcome(receipt: TransactionReceipt): GaslessConfirmedOutcome {
  return {
    blockNumber: BigInt(receipt.blockNumber).toString(),
    blockHash: receipt.blockHash,
    gasUsed: BigInt(receipt.gasUsed ?? 0n).toString(),
    effectiveGasPriceWei: BigInt(receipt.gasPrice ?? 0n).toString(),
  };
}

export class GaslessTransactionOutcomeReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: GaslessTransactionOutcomeStore,
    private readonly provider: GaslessOutcomeProvider,
    private readonly observer: GaslessOutcomeObserver,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.processUnresolved(), this.intervalMs);
    void this.processUnresolved();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async processUnresolved(limit = 25): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const records = await this.store.listRecoveryCandidates(limit);
      for (const record of records) {
        try {
          await this.reconcile(record);
        } catch (error) {
          Logger.error('Gasless transaction outcome reconciliation failed', {
            transactionHash: record.transactionHash,
            applicationRequestId: record.applicationRequestId,
            outcomeStatus: record.outcomeStatus,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcile(record: GaslessTransactionOutcomeRecord): Promise<void> {
    const receipt = await this.provider.getTransactionReceipt(record.transactionHash);
    if (receipt) {
      const outcome = receiptOutcome(receipt);
      if (receipt.status === 1) {
        if (record.projectedOutcomeStatus !== 'confirmed') {
          await this.observer.onConfirmed(record, outcome);
        }
        if (record.outcomeStatus !== 'confirmed') {
          await this.store.markConfirmed(record.transactionHash, outcome);
        }
        await this.store.markProjectionApplied(record.transactionHash, 'confirmed');
      } else {
        if (record.projectedOutcomeStatus !== 'reverted') {
          await this.observer.onReverted(record, outcome);
        }
        if (record.outcomeStatus !== 'reverted') {
          await this.store.markReverted(record.transactionHash, outcome);
        }
        await this.store.markProjectionApplied(record.transactionHash, 'reverted');
      }
      return;
    }

    const transaction = await this.provider.getTransaction(record.transactionHash);
    if (transaction) {
      if (record.projectedOutcomeStatus !== 'confirmation_pending') {
        await this.observer.onConfirmationPending(record);
      }
      if (record.outcomeStatus !== 'confirmation_pending') {
        await this.store.markConfirmationPending(record.transactionHash);
      }
      if (record.projectedOutcomeStatus !== 'confirmation_pending') {
        await this.store.markProjectionApplied(record.transactionHash, 'confirmation_pending');
      }
      return;
    }

    const [confirmedSignerNonce, pendingSignerNonce] = await Promise.all([
      this.provider.getTransactionCount(record.signerAddress, 'latest'),
      this.provider.getTransactionCount(record.signerAddress, 'pending'),
    ]);
    const failureCode =
      confirmedSignerNonce > record.nonce
        ? 'RECOVERY_SIGNER_NONCE_CONFIRMED_PAST_TRANSACTION'
        : pendingSignerNonce > record.nonce
          ? 'RECOVERY_SIGNER_NONCE_PENDING_PAST_TRANSACTION'
          : 'RECOVERY_TRANSACTION_NOT_FOUND';

    if (record.outcomeStatus !== 'broadcast_unknown' || record.failureCode !== failureCode) {
      await this.store.markBroadcastUnknown(record.transactionHash, failureCode);
      const unknownRecord = {
        ...record,
        outcomeStatus: 'broadcast_unknown' as const,
        failureCode,
      };
      if (record.projectedOutcomeStatus !== 'broadcast_unknown') {
        await this.observer.onBroadcastUnknown(unknownRecord);
      }
    } else if (record.projectedOutcomeStatus !== 'broadcast_unknown') {
      await this.observer.onBroadcastUnknown(record);
    }
    if (record.projectedOutcomeStatus !== 'broadcast_unknown') {
      await this.store.markProjectionApplied(record.transactionHash, 'broadcast_unknown');
    }

    Logger.warn('Gasless transaction remains unresolved without rebroadcast', {
      transactionHash: record.transactionHash,
      applicationRequestId: record.applicationRequestId,
      previousOutcomeStatus: record.outcomeStatus,
      failureCode,
      confirmedSignerNonce,
      pendingSignerNonce,
      transactionNonce: record.nonce,
    });
  }
}
