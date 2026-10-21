/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TransactionReceipt, TransactionResponse } from 'ethers';
import type { GaslessFinalityVerifier } from './gaslessChainFinality';
import { Logger } from '../logging/logger';
import type {
  GaslessConfirmedOutcome,
  GaslessTransactionOutcomeRecord,
  GaslessTransactionOutcomeStore,
} from './gaslessTransactionOutcomeStore';

export interface GaslessOutcomeProvider {
  getTransactionReceipt(transactionHash: string): Promise<TransactionReceipt | null>;
  getTransaction(transactionHash: string): Promise<TransactionResponse | null>;
  getTransactionCount(address: string, blockTag: 'latest' | 'pending'): Promise<number>;
}

export interface GaslessOutcomeObserver {
  onOrphaned(record: GaslessTransactionOutcomeRecord): Promise<void>;
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
    private readonly provider:
      | GaslessOutcomeProvider
      | ((record: GaslessTransactionOutcomeRecord) => GaslessOutcomeProvider),
    private readonly observer: GaslessOutcomeObserver,
    private readonly intervalMs: number,
    private readonly finality: GaslessFinalityVerifier,
    private readonly beforeReconcile?: (limit: number) => Promise<void>,
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
      try {
        await this.beforeReconcile?.(limit);
      } catch {
        // Repair can never sign/submit. Its failure must not stop unrelated retained observations.
        Logger.error('Lifecycle signed-identity repair requires recovery', {
          reason: 'user_action_identity_repair_unavailable',
        });
      }
      const records = await this.store.listRecoveryCandidates(limit);
      for (const record of records) {
        try {
          await this.reconcile(record);
        } catch (error) {
          Logger.error('Gasless transaction outcome reconciliation failed', {
            transactionHash: record.transactionHash,
            applicationRequestId: record.applicationRequestId,
            outcomeStatus: record.outcomeStatus,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          });
        } finally {
          try {
            await this.store.markRecoveryAttempted(record.transactionHash);
          } catch (error) {
            Logger.error('Failed to rotate gasless transaction recovery candidate', {
              transactionHash: record.transactionHash,
              errorType: error instanceof Error ? error.name : 'UnknownError',
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcile(record: GaslessTransactionOutcomeRecord): Promise<void> {
    if (record.failureCode === 'FINALIZED_BLOCK_ORPHANED') {
      // Keep this operation reserved until governed reconciliation; never automatically rebroadcast.
      if (record.projectedOutcomeStatus !== 'confirmation_pending') {
        await this.observer.onOrphaned(record);
        await this.store.markProjectionApplied(record.transactionHash, 'confirmation_pending');
      }
      return;
    }
    if (
      record.blockNumber &&
      record.blockHash &&
      ['confirmed', 'reverted'].includes(record.outcomeStatus)
    ) {
      const canonicality = await this.finality.revalidateBlock(
        record.chainId,
        record.blockNumber,
        record.blockHash,
      );
      if (canonicality === 'orphaned') {
        await this.store.markOrphaned(record.transactionHash);
        await this.observer.onOrphaned({
          ...record,
          outcomeStatus: 'confirmation_pending',
          failureCode: 'FINALIZED_BLOCK_ORPHANED',
        });
        await this.store.markProjectionApplied(record.transactionHash, 'confirmation_pending');
        return;
      }
      if (canonicality !== 'canonical') return;
    }
    const provider = typeof this.provider === 'function' ? this.provider(record) : this.provider;
    const receipt = await provider.getTransactionReceipt(record.transactionHash);
    if (receipt) {
      const evidence = await this.finality.verifyReceipt(
        record.chainId,
        record.transactionHash,
        receipt,
      );
      if (!evidence) {
        if (!['confirmed', 'reverted'].includes(record.outcomeStatus)) {
          await this.store.markConfirmationPending(record.transactionHash);
          if (record.projectedOutcomeStatus !== 'confirmation_pending') {
            await this.observer.onConfirmationPending(record);
            await this.store.markProjectionApplied(record.transactionHash, 'confirmation_pending');
          }
        }
        return;
      }
      const outcome = { ...receiptOutcome(receipt), finalityEvidence: evidence };
      if (receipt.status === 1) {
        if (record.projectedOutcomeStatus !== 'confirmed') {
          await this.observer.onConfirmed(record, outcome);
        }
        if (record.outcomeStatus !== 'confirmed' || !record.finalityEvidence) {
          await this.store.markConfirmed(record.transactionHash, outcome);
        }
        await this.store.markProjectionApplied(record.transactionHash, 'confirmed');
      } else {
        if (record.projectedOutcomeStatus !== 'reverted') {
          await this.observer.onReverted(record, outcome);
        }
        if (record.outcomeStatus !== 'reverted' || !record.finalityEvidence) {
          await this.store.markReverted(record.transactionHash, outcome);
        }
        await this.store.markProjectionApplied(record.transactionHash, 'reverted');
      }
      return;
    }

    if (['confirmed', 'reverted'].includes(record.outcomeStatus)) return;
    const transaction = await provider.getTransaction(record.transactionHash);
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

    const observedTransactionHash = record.observedTransactionHash;
    if (
      observedTransactionHash &&
      observedTransactionHash.toLowerCase() !== record.transactionHash.toLowerCase()
    ) {
      const observedReceipt = await provider.getTransactionReceipt(observedTransactionHash);
      const observedTransaction = observedReceipt
        ? null
        : await provider.getTransaction(observedTransactionHash);
      if (observedReceipt || observedTransaction) {
        const failureCode = observedReceipt
          ? 'RECOVERY_OBSERVED_HASH_HAS_RECEIPT'
          : 'RECOVERY_OBSERVED_HASH_IS_PENDING';
        await this.projectBroadcastUnknown(record, failureCode);
        Logger.error('Provider-returned transaction hash requires independent investigation', {
          transactionHash: record.transactionHash,
          observedTransactionHash,
          applicationRequestId: record.applicationRequestId,
          failureCode,
        });
        return;
      }
    }

    const [confirmedSignerNonce, pendingSignerNonce] = await Promise.all([
      provider.getTransactionCount(record.signerAddress, 'latest'),
      provider.getTransactionCount(record.signerAddress, 'pending'),
    ]);
    const failureCode =
      confirmedSignerNonce > record.nonce
        ? 'RECOVERY_SIGNER_NONCE_CONFIRMED_PAST_TRANSACTION'
        : pendingSignerNonce > record.nonce
          ? 'RECOVERY_SIGNER_NONCE_PENDING_PAST_TRANSACTION'
          : 'RECOVERY_TRANSACTION_NOT_FOUND';

    await this.projectBroadcastUnknown(record, failureCode);

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

  private async projectBroadcastUnknown(
    record: GaslessTransactionOutcomeRecord,
    failureCode: string,
  ): Promise<void> {
    if (record.outcomeStatus !== 'broadcast_unknown' || record.failureCode !== failureCode) {
      if (record.observedTransactionHash) {
        await this.store.markBroadcastUnknown(
          record.transactionHash,
          failureCode,
          record.observedTransactionHash,
        );
      } else {
        await this.store.markBroadcastUnknown(record.transactionHash, failureCode);
      }
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
  }
}
