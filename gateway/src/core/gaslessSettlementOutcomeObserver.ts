/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SettlementService } from './settlementService';
import type { SettlementExecutionStatus, SettlementStore } from './settlementStore';
import type {
  GaslessConfirmedOutcome,
  GaslessTransactionOutcomeRecord,
} from './gaslessTransactionOutcomeStore';
import type { GaslessOutcomeObserver } from './gaslessTransactionOutcomeReconciler';

export class GaslessSettlementOutcomeObserver implements GaslessOutcomeObserver {
  constructor(
    private readonly settlementStore: SettlementStore,
    private readonly settlementService: SettlementService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async onBroadcastUnknown(record: GaslessTransactionOutcomeRecord): Promise<void> {
    await this.recordHandoffOutcome(record, 'broadcast_unknown');
  }

  async onConfirmationPending(record: GaslessTransactionOutcomeRecord): Promise<void> {
    await this.recordHandoffOutcome(record, 'confirmation_pending');
  }

  async onConfirmed(
    record: GaslessTransactionOutcomeRecord,
    outcome: GaslessConfirmedOutcome,
  ): Promise<void> {
    await this.prepareTerminalProjection(record);
    await this.recordHandoffOutcome(record, 'confirmed', outcome);
  }

  async onReverted(
    record: GaslessTransactionOutcomeRecord,
    outcome: GaslessConfirmedOutcome,
  ): Promise<void> {
    await this.prepareTerminalProjection(record);
    await this.recordHandoffOutcome(record, 'reverted', outcome);
  }

  private async prepareTerminalProjection(record: GaslessTransactionOutcomeRecord): Promise<void> {
    if (record.resourceType !== 'settlement_handoff') return;
    const handoff = await this.requireHandoff(record);
    const requiresPendingProjection = new Set<SettlementExecutionStatus>([
      'pending',
      'accepted',
      'queued',
    ]);
    if (requiresPendingProjection.has(handoff.executionStatus)) {
      await this.recordHandoffOutcome(record, 'confirmation_pending');
    }
  }

  private async requireHandoff(record: GaslessTransactionOutcomeRecord) {
    const handoff = await this.settlementStore.getHandoff(record.resourceId);
    if (!handoff) {
      throw new Error(`Missing settlement handoff for gasless outcome ${record.transactionHash}`);
    }
    return handoff;
  }

  private async recordHandoffOutcome(
    record: GaslessTransactionOutcomeRecord,
    status: 'broadcast_unknown' | 'confirmation_pending' | 'confirmed' | 'reverted',
    outcome?: GaslessConfirmedOutcome,
  ): Promise<void> {
    if (record.resourceType !== 'settlement_handoff') return;
    const handoff = await this.requireHandoff(record);

    await this.settlementService.recordExecutionEvent({
      handoffId: record.resourceId,
      eventType: status,
      executionStatus: status,
      reconciliationStatus: handoff.reconciliationStatus,
      providerStatus: `gasless_recovery_${status}`,
      txHash: record.transactionHash,
      detail: `Gasless transaction recovery resolved ${status.replace('_', ' ')}.`,
      metadata: {
        action: record.operation,
        chainId: record.chainId,
        signerAddress: record.signerAddress,
        nonce: record.nonce,
        recoveredAfterRestart: true,
        rebroadcastPerformed: false,
        ...(outcome ?? {}),
      },
      observedAt: this.now().toISOString(),
      requestId: record.applicationRequestId,
      sourceApiKeyId: null,
    });
  }
}
