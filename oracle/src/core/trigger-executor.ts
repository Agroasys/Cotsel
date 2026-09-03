import { WebhookNotifier } from '@agroasys/notifications';
import type { SDKClient, BlockchainResult } from '../blockchain/sdk-client';
import { isOracleTransactionOutcomePendingError } from '../blockchain/transaction-lifecycle';
import { updateTrigger } from '../database/queries';
import { incrementOracleExhaustedRetries } from '../metrics/counters';
import { Trigger, TriggerStatus, TriggerType } from '../types/trigger';
import { calculateBackoff } from '../utils/crypto';
import { classifyError, determineNextStatus, ValidationError } from '../utils/errors';
import { Logger } from '../utils/logger';
import type { TriggerResponse } from './trigger-contracts';
import { StateValidator } from './state-validator';

export class TriggerExecutor {
  private readonly maxBackoffMs = 30_000;

  constructor(
    private readonly sdkClient: SDKClient,
    private readonly maxAttempts: number,
    private readonly baseDelayMs: number,
    private readonly notifier?: WebhookNotifier,
  ) {}

  async execute(trigger: Trigger, actionKey: string): Promise<TriggerResponse> {
    let attempt = 1;

    while (attempt <= this.maxAttempts) {
      try {
        Logger.info('Executing trigger attempt', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey,
          attempt,
          maxAttempts: this.maxAttempts,
        });
        const trade = await this.sdkClient.getTrade(trigger.trade_id);
        StateValidator.validateTradeState(trade, trigger.trigger_type);

        await updateTrigger(trigger.idempotency_key, {
          status: TriggerStatus.EXECUTING,
          attempt_count: attempt,
        });
        const result = await this.executeBlockchainAction(trigger);

        Logger.info('Trigger submitted successfully', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey,
          txHash: result.txHash,
          ...(result.blockNumber === undefined ? {} : { blockNumber: result.blockNumber }),
        });
        return {
          idempotencyKey: trigger.idempotency_key,
          actionKey,
          requestId: trigger.request_id,
          status: TriggerStatus.SUBMITTED,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
          idempotent: false,
          message: 'Transaction submitted, awaiting confirmation',
        };
      } catch (error: unknown) {
        if (isOracleTransactionOutcomePendingError(error)) {
          Logger.warn('Oracle transaction requires reconciliation; automatic retry is blocked', {
            idempotencyKey: trigger.idempotency_key.substring(0, 32),
            actionKey,
            transactionHash: error.transactionHash,
            outcome: error.outcome,
          });
          return {
            idempotencyKey: trigger.idempotency_key,
            actionKey,
            requestId: trigger.request_id,
            status: TriggerStatus.BROADCAST_UNKNOWN,
            txHash: error.transactionHash,
            idempotent: true,
            message: 'Transaction outcome is under reconciliation; rebroadcast is blocked',
          };
        }

        const oracleError = classifyError(error);
        const nextStatus = determineNextStatus(oracleError, attempt, this.maxAttempts);
        Logger.error('Trigger execution failed', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey,
          attempt,
          errorType: oracleError.errorType,
          isTerminal: oracleError.isTerminal,
          message: oracleError.message,
        });
        await updateTrigger(trigger.idempotency_key, {
          status: nextStatus,
          attempt_count: attempt,
          last_error: oracleError.message,
          error_type: oracleError.errorType,
        });

        if (nextStatus === TriggerStatus.TERMINAL_FAILURE) {
          await this.notifyTerminalStatus(
            trigger,
            actionKey,
            nextStatus,
            oracleError.message,
            attempt,
          );
          return this.failureResponse(trigger, actionKey, nextStatus, oracleError.message);
        }
        if (nextStatus === TriggerStatus.EXHAUSTED_NEEDS_REDRIVE) {
          const message = `Exhausted ${this.maxAttempts} attempts: ${oracleError.message}. Use re-drive endpoint to retry.`;
          incrementOracleExhaustedRetries(actionKey);
          await this.notifyTerminalStatus(trigger, actionKey, nextStatus, message, attempt);
          return this.failureResponse(trigger, actionKey, nextStatus, message);
        }
        if (attempt < this.maxAttempts && !oracleError.isTerminal) {
          const backoffMs = calculateBackoff(attempt, this.baseDelayMs, this.maxBackoffMs);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          attempt += 1;
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Retry loop exited without terminal status for ${actionKey}`);
  }

  private failureResponse(
    trigger: Trigger,
    actionKey: string,
    status: TriggerStatus,
    message: string,
  ): TriggerResponse {
    return {
      idempotencyKey: trigger.idempotency_key,
      actionKey,
      requestId: trigger.request_id,
      status,
      idempotent: false,
      message,
    };
  }

  private async notifyTerminalStatus(
    trigger: Trigger,
    actionKey: string,
    status: TriggerStatus,
    message: string,
    attempt: number,
  ): Promise<void> {
    if (!this.notifier) return;

    await this.notifier.notify({
      source: 'oracle',
      type:
        status === TriggerStatus.TERMINAL_FAILURE
          ? 'ORACLE_TRIGGER_TERMINAL_FAILURE'
          : 'ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE',
      severity: 'critical',
      dedupKey: `oracle:${status}:${actionKey}`,
      message,
      correlation: {
        tradeId: trigger.trade_id,
        actionKey,
        requestId: trigger.request_id,
        txHash: trigger.tx_hash || undefined,
      },
      metadata: {
        triggerType: trigger.trigger_type,
        status,
        attempt,
        maxAttempts: this.maxAttempts,
      },
    });
  }

  private async executeBlockchainAction(trigger: Trigger): Promise<BlockchainResult> {
    switch (trigger.trigger_type) {
      case TriggerType.RELEASE_STAGE_1:
        return this.sdkClient.releaseFundsStage1(trigger.trade_id, trigger.idempotency_key);
      case TriggerType.CONFIRM_ARRIVAL:
      case TriggerType.CONFIRM_INSPECTION_AVAILABLE_STANDARD:
        return this.sdkClient.confirmInspectionAvailable(
          trigger.trade_id,
          72 * 60 * 60,
          trigger.idempotency_key,
        );
      case TriggerType.CONFIRM_INSPECTION_AVAILABLE_PACKAGED_LOCAL:
        return this.sdkClient.confirmInspectionAvailable(
          trigger.trade_id,
          48 * 60 * 60,
          trigger.idempotency_key,
        );
      case TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE:
        throw new ValidationError(
          'Buyer authorization is required; submit inspection acceptance through the gateway user-action route',
        );
      case TriggerType.FINALIZE_TRADE:
        return this.sdkClient.finalizeTrade(trigger.trade_id, trigger.idempotency_key);
      default:
        throw new Error(`Unknown trigger type: ${trigger.trigger_type}`);
    }
  }
}
