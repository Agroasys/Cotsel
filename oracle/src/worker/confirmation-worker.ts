import type { Notifier } from '@agroasys/notifications';
import { IndexerClient } from '../blockchain/indexer-client';
import { SDKClient } from '../blockchain/sdk-client';
import { getTriggersByStatus, resolveSignerDispatch, updateTrigger } from '../database/queries';
import { requireFundedBinding } from '../core/funded-settlement-instruction';
import { Trigger, TriggerStatus } from '../types/trigger';
import { Logger } from '../utils/logger';
const POLL_INTERVAL_MS = 10000;
const CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;
const BATCH_SIZE = 100;
/** Retained observer: only original, independently finalized execution evidence can confirm. */
export class ConfirmationWorker {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private polling = false;
  constructor(
    private indexerClient: IndexerClient,
    private sdkClient: SDKClient,
    private notifier?: Notifier,
  ) {}
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      void this.pollConfirmations();
    }, POLL_INTERVAL_MS);
  }
  stop(): void {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = undefined;
  }
  private async pollConfirmations(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const trigger of await getTriggersByStatus(TriggerStatus.SUBMITTED, BATCH_SIZE))
        await this.checkConfirmation(trigger);
    } catch {
      Logger.error('Original Oracle confirmation polling is unavailable');
    } finally {
      this.polling = false;
    }
  }
  private async checkConfirmation(trigger: Trigger): Promise<void> {
    try {
      if (
        !trigger.tx_hash ||
        !trigger.submitted_at ||
        !trigger.dispatch_signer_scope ||
        !trigger.dispatch_started_at
      ) {
        Logger.warn('Oracle confirmation lacks attributable original dispatch evidence', {
          actionKey: trigger.action_key,
        });
        return;
      }
      const binding = requireFundedBinding(
        trigger.funded_binding,
        trigger.trade_id,
        trigger.trigger_type,
      );
      const evidence = await this.sdkClient.verifyProgressionReceipt(
        trigger.dispatch_signer_scope,
        trigger.tx_hash,
        binding,
      );
      const expectedEvent =
        binding.phase === 'initial_release_after_custody_and_documents'
          ? 'FundsReleasedStage1'
          : binding.phase.startsWith('inspection_available_')
            ? 'InspectionAvailable'
            : 'FinalTrancheReleased';
      const event = await this.indexerClient.findConfirmationEvent(
        trigger.tx_hash,
        trigger.trade_id,
        expectedEvent,
      );
      if (
        !event ||
        event.txHash.toLowerCase() !== trigger.tx_hash.toLowerCase() ||
        event.tradeId !== trigger.trade_id ||
        event.blockNumber !== evidence.blockNumber ||
        event.eventName !== expectedEvent
      )
        return;
      // Releasing nonce exclusion does not post money. Backend accounting re-verifies its original evidence.
      await resolveSignerDispatch(trigger.idempotency_key, evidence);
      await updateTrigger(trigger.idempotency_key, {
        status: TriggerStatus.CONFIRMED,
        block_number: BigInt(evidence.blockNumber),
        confirmation_stage: 'FINALIZED',
        confirmation_stage_at: new Date(),
        indexer_confirmed: true,
        indexer_confirmed_at: new Date(),
        indexer_event_id: event.id,
        on_chain_verified: true,
        on_chain_verified_at: new Date(),
        confirmed_at: new Date(),
      });
      Logger.audit('TRIGGER_CONFIRMED_FINALIZED', trigger.trade_id, {
        actionKey: trigger.action_key,
        txHash: trigger.tx_hash,
        blockHash: evidence.blockHash,
        eventId: event.id,
      });
    } catch {
      // Neither advanced trade state nor elapsed application time identifies the original transaction.
      Logger.warn('Original Oracle execution remains unresolved', {
        actionKey: trigger.action_key,
        txHash: trigger.tx_hash ?? undefined,
      });
      if (
        trigger.submitted_at &&
        Date.now() - new Date(trigger.submitted_at).getTime() > CONFIRMATION_TIMEOUT_MS &&
        this.notifier
      ) {
        try {
          await this.notifier.notify({
            source: 'oracle',
            type: 'ORACLE_CONFIRMATION_TIMEOUT',
            severity: 'critical',
            dedupKey: `oracle:confirmation-timeout:${trigger.action_key}`,
            message: 'Original Oracle transaction remains unresolved. New sends stay blocked.',
            correlation: {
              tradeId: trigger.trade_id,
              actionKey: trigger.action_key,
              requestId: trigger.request_id,
              txHash: trigger.tx_hash ?? undefined,
            },
          });
        } catch {
          Logger.warn('Oracle unresolved execution notification is unavailable', {
            actionKey: trigger.action_key,
          });
        }
      }
    }
  }
}
