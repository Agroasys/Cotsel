import { WebhookNotifier } from '@agroasys/notifications';
import { isWorkflowConfirmationStage, resolveSettlementConfirmationStage } from '@agroasys/sdk';
import { IndexerClient } from '../blockchain/indexer-client';
import { SDKClient } from '../blockchain/sdk-client';
import { getTriggersByStatus, updateTrigger } from '../database/queries';
import { ErrorType, Trigger, TriggerStatus, TriggerType } from '../types/trigger';
import { getErrorMessage } from '../utils/errors';
import { Logger } from '../utils/logger';

const POLL_INTERVAL_MS = 10000; // 10 secs
const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes: soft timeout (warning)
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes: hard timeout (moves to exhausted)
const ON_CHAIN_FALLBACK_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes before on-chain verification fallback
const ON_CHAIN_FALLBACK_MIN_INTERVAL_MS = 5 * 60 * 1000; // rate-limit fallback checks per tradeId
const BATCH_SIZE = 100;
const TRADE_STATUS_LOCKED = 0;
const TRADE_STATUS_IN_TRANSIT = 1;
const TRADE_STATUS_ARRIVAL_CONFIRMED = 2;

export class ConfirmationWorker {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private lastOnChainCheckByTradeId: Map<string, number> = new Map();

  constructor(
    private indexerClient: IndexerClient,
    private sdkClient: SDKClient,
    private notifier?: WebhookNotifier,
  ) {}

  start(): void {
    if (this.isRunning) {
      Logger.warn('ConfirmationWorker already running');
      return;
    }

    this.isRunning = true;
    Logger.info('ConfirmationWorker started', {
      pollIntervalMs: POLL_INTERVAL_MS,
      batchSize: BATCH_SIZE,
      softTimeoutMinutes: CONFIRMATION_TIMEOUT_MS / 60000,
      hardTimeoutMinutes: HARD_TIMEOUT_MS / 60000,
      onChainFallbackThresholdMinutes: ON_CHAIN_FALLBACK_THRESHOLD_MS / 60000,
      onChainFallbackMinIntervalMinutes: ON_CHAIN_FALLBACK_MIN_INTERVAL_MS / 60000,
    });

    this.intervalId = setInterval(() => this.pollConfirmations(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    Logger.info('ConfirmationWorker stopped');
  }

  private async pollConfirmations(): Promise<void> {
    try {
      const submittedTriggers = await getTriggersByStatus(TriggerStatus.SUBMITTED, BATCH_SIZE);

      if (submittedTriggers.length === 0) {
        return;
      }

      Logger.info('Polling confirmations', {
        count: submittedTriggers.length,
        batchSize: BATCH_SIZE,
      });

      for (const trigger of submittedTriggers) {
        await this.checkConfirmation(trigger);
      }
    } catch (error: unknown) {
      Logger.error('Confirmation polling failed', { error: getErrorMessage(error) });
    }
  }

  private async notifyTimeout(trigger: Trigger, ageMinutes: string): Promise<void> {
    if (!this.notifier) {
      return;
    }

    await this.notifier.notify({
      source: 'oracle',
      type: 'ORACLE_CONFIRMATION_TIMEOUT',
      severity: 'critical',
      dedupKey: 'oracle:confirmation-timeout:' + trigger.action_key,
      message:
        'Confirmation timeout exceeded hard limit and trigger moved to EXHAUSTED_NEEDS_REDRIVE.',
      correlation: {
        tradeId: trigger.trade_id,
        actionKey: trigger.action_key,
        requestId: trigger.request_id,
        txHash: trigger.tx_hash ?? undefined,
      },
      metadata: {
        ageMinutes,
        triggerType: trigger.trigger_type,
        idempotencyKey: trigger.idempotency_key,
      },
    });
  }

  private async checkConfirmation(trigger: Trigger): Promise<void> {
    try {
      if (!trigger.tx_hash) {
        Logger.warn('Trigger has no tx_hash', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey: trigger.action_key,
        });
        return;
      }
      if (!trigger.submitted_at) {
        Logger.warn('Trigger has no submitted_at timestamp', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey: trigger.action_key,
          txHash: trigger.tx_hash,
        });
        return;
      }

      const submittedAt = new Date(trigger.submitted_at).getTime();
      const now = Date.now();
      const ageMs = now - submittedAt;
      const ageMinutes = ageMs / 60000;

      if (ageMs > CONFIRMATION_TIMEOUT_MS && ageMs <= HARD_TIMEOUT_MS) {
        Logger.warn('Confirmation taking longer than expected', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey: trigger.action_key,
          txHash: trigger.tx_hash,
          ageMinutes: ageMinutes.toFixed(1),
          status: 'INDEXER_MAY_BE_LAGGING',
          action: 'CONTINUE_MONITORING',
        });
      }

      const onChainConfirmed = await this.tryOnChainFallback(trigger, now, ageMs, ageMinutes);
      if (onChainConfirmed) {
        return;
      }

      if (ageMs > HARD_TIMEOUT_MS) {
        Logger.error('Confirmation hard timeout exceeded', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey: trigger.action_key,
          txHash: trigger.tx_hash,
          tradeId: trigger.trade_id,
          ageMinutes: ageMinutes.toFixed(1),
          status: 'TIMEOUT',
          action: 'MOVING_TO_EXHAUSTED_NEEDS_REDRIVE',
        });

        await updateTrigger(trigger.idempotency_key, {
          status: TriggerStatus.EXHAUSTED_NEEDS_REDRIVE,
          last_error: `Confirmation timeout after ${ageMinutes.toFixed(1)} minutes. Transaction may have failed or indexer is lagging. Re-drive will verify on-chain status.`,
          error_type: ErrorType.INDEXER_LAG,
        });

        await this.notifyTimeout(trigger, ageMinutes.toFixed(1));

        Logger.audit('CONFIRMATION_TIMEOUT_NEEDS_REDRIVE', trigger.trade_id, {
          idempotencyKey: trigger.idempotency_key,
          actionKey: trigger.action_key,
          triggerType: trigger.trigger_type,
          txHash: trigger.tx_hash,
          ageMinutes: ageMinutes.toFixed(1),
          severity: 'HIGH',
          requiresRedrive: true,
        });

        return;
      }

      const event = await this.indexerClient.findConfirmationEvent(
        trigger.tx_hash,
        trigger.trade_id,
      );

      if (event) {
        const confirmationState = resolveSettlementConfirmationStage(
          event.blockNumber,
          await this.sdkClient.getSettlementConfirmationHeads(),
        );
        const stageReachedWorkflowGate = isWorkflowConfirmationStage(confirmationState.stage);

        Logger.info('Transaction confirmed in indexer', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey: trigger.action_key,
          txHash: trigger.tx_hash,
          eventId: event.id,
          eventName: event.eventName,
          blockNumber: event.blockNumber,
          confirmationStage: confirmationState.stage,
          safeBlockNumber: confirmationState.safeBlockNumber,
          finalizedBlockNumber: confirmationState.finalizedBlockNumber,
          confirmationTimeSeconds: (ageMs / 1000).toFixed(1),
        });

        await updateTrigger(trigger.idempotency_key, {
          indexer_confirmed: true,
          indexer_confirmed_at: new Date(),
          indexer_event_id: event.id,
          confirmation_stage: confirmationState.stage,
          confirmation_stage_at: new Date(),
          ...(stageReachedWorkflowGate
            ? {
                status: TriggerStatus.CONFIRMED,
                confirmed_at: new Date(),
              }
            : {}),
        });

        Logger.audit(
          stageReachedWorkflowGate ? 'TRIGGER_CONFIRMED' : 'TRIGGER_INDEXED_AWAITING_SAFE_HEAD',
          trigger.trade_id,
          {
            idempotencyKey: trigger.idempotency_key.substring(0, 32),
            actionKey: trigger.action_key,
            triggerType: trigger.trigger_type,
            txHash: trigger.tx_hash,
            eventName: event.eventName,
            blockNumber: event.blockNumber,
            confirmationStage: confirmationState.stage,
            confirmationTimeSeconds: (ageMs / 1000).toFixed(1),
          },
        );
      } else {
        Logger.info('Event not yet indexed, will retry', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey: trigger.action_key,
          txHash: trigger.tx_hash,
          ageSeconds: (ageMs / 1000).toFixed(0),
          ageMinutes: ageMinutes.toFixed(1),
        });
      }
    } catch (error: unknown) {
      Logger.error('Failed to check confirmation', {
        idempotencyKey: trigger.idempotency_key.substring(0, 32),
        actionKey: trigger.action_key,
        error: getErrorMessage(error),
      });
    }
  }

  private shouldRunOnChainCheck(tradeId: string, now: number, ageMs: number): boolean {
    if (ageMs < ON_CHAIN_FALLBACK_THRESHOLD_MS) {
      return false;
    }

    const lastCheckedAt = this.lastOnChainCheckByTradeId.get(tradeId);
    if (lastCheckedAt !== undefined && now - lastCheckedAt < ON_CHAIN_FALLBACK_MIN_INTERVAL_MS) {
      return false;
    }

    this.lastOnChainCheckByTradeId.set(tradeId, now);
    return true;
  }

  private isTradeStateAdvanced(triggerType: TriggerType, status: number): boolean {
    switch (triggerType) {
      case TriggerType.RELEASE_STAGE_1:
        return status !== TRADE_STATUS_LOCKED;
      case TriggerType.CONFIRM_ARRIVAL:
        return status !== TRADE_STATUS_IN_TRANSIT;
      case TriggerType.FINALIZE_TRADE:
        return status !== TRADE_STATUS_ARRIVAL_CONFIRMED;
      default:
        return false;
    }
  }

  private async tryOnChainFallback(
    trigger: Trigger,
    now: number,
    ageMs: number,
    ageMinutes: number,
  ): Promise<boolean> {
    if (!this.shouldRunOnChainCheck(trigger.trade_id, now, ageMs)) {
      return false;
    }

    try {
      if (!trigger.tx_hash) {
        return false;
      }

      const receiptBlockNumber = await this.sdkClient.getTransactionReceiptBlockNumber(
        trigger.tx_hash,
      );
      if (receiptBlockNumber !== null) {
        const confirmationState = resolveSettlementConfirmationStage(
          receiptBlockNumber,
          await this.sdkClient.getSettlementConfirmationHeads(),
        );

        await updateTrigger(trigger.idempotency_key, {
          confirmation_stage: confirmationState.stage,
          confirmation_stage_at: new Date(),
          ...(isWorkflowConfirmationStage(confirmationState.stage)
            ? {
                status: TriggerStatus.CONFIRMED,
                on_chain_verified: true,
                on_chain_verified_at: new Date(),
                confirmed_at: new Date(),
              }
            : {}),
        });

        if (isWorkflowConfirmationStage(confirmationState.stage)) {
          Logger.warn('On-chain receipt confirmed action while indexer lagged behind', {
            idempotencyKey: trigger.idempotency_key.substring(0, 32),
            actionKey: trigger.action_key,
            triggerType: trigger.trigger_type,
            txHash: trigger.tx_hash,
            receiptBlockNumber,
            confirmationStage: confirmationState.stage,
            ageMinutes: ageMinutes.toFixed(1),
          });

          Logger.audit('TRIGGER_CONFIRMED_ON_CHAIN_RECEIPT', trigger.trade_id, {
            idempotencyKey: trigger.idempotency_key.substring(0, 32),
            actionKey: trigger.action_key,
            triggerType: trigger.trigger_type,
            txHash: trigger.tx_hash,
            receiptBlockNumber,
            confirmationStage: confirmationState.stage,
            ageMinutes: ageMinutes.toFixed(1),
          });

          return true;
        }
      }

      const trade = await this.sdkClient.getTrade(trigger.trade_id);
      const advanced = this.isTradeStateAdvanced(trigger.trigger_type, trade.status);

      if (!advanced) {
        Logger.info('On-chain fallback check: action still pending', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey: trigger.action_key,
          triggerType: trigger.trigger_type,
          tradeStatus: trade.status,
          ageMinutes: ageMinutes.toFixed(1),
        });
        return false;
      }

      Logger.warn('On-chain fallback confirmed action despite missing indexer confirmation', {
        idempotencyKey: trigger.idempotency_key.substring(0, 32),
        actionKey: trigger.action_key,
        triggerType: trigger.trigger_type,
        txHash: trigger.tx_hash,
        tradeStatus: trade.status,
        ageMinutes: ageMinutes.toFixed(1),
      });

      await updateTrigger(trigger.idempotency_key, {
        status: TriggerStatus.CONFIRMED,
        on_chain_verified: true,
        on_chain_verified_at: new Date(),
        confirmed_at: new Date(),
      });

      Logger.audit('TRIGGER_CONFIRMED_ON_CHAIN_FALLBACK', trigger.trade_id, {
        idempotencyKey: trigger.idempotency_key.substring(0, 32),
        actionKey: trigger.action_key,
        triggerType: trigger.trigger_type,
        txHash: trigger.tx_hash,
        tradeStatus: trade.status,
        ageMinutes: ageMinutes.toFixed(1),
      });

      return true;
    } catch (error: unknown) {
      Logger.warn('On-chain fallback verification failed, keeping indexer polling active', {
        idempotencyKey: trigger.idempotency_key.substring(0, 32),
        actionKey: trigger.action_key,
        triggerType: trigger.trigger_type,
        error: getErrorMessage(error),
      });
      return false;
    }
  }
}
