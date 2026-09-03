import { SDKClient } from '../blockchain/sdk-client';
import { StateValidator } from './state-validator';
import { Trigger, TriggerStatus, CreateTriggerData } from '../types/trigger';
import {
  createTrigger,
  getTriggerByIdempotencyKey,
  getLatestTriggerByActionKey,
  updateTrigger,
} from '../database/queries';
import { generateActionKey, generateRequestId, generateIdempotencyKey } from '../utils/crypto';
import { getErrorMessage, ValidationError } from '../utils/errors';
import { Logger } from '../utils/logger';
import {
  incrementOracleRedriveAttempts,
  incrementOraclePendingApproval,
  incrementOracleApproved,
  incrementOracleRejected,
} from '../metrics/counters';
import { WebhookNotifier } from '@agroasys/notifications';
import { approveTrigger, rejectTrigger } from '../database/queries';
import { NOOP_ORACLE_ACTION_LOCK, type OracleActionLock } from './oracle-action-lock';
import type { TriggerRequest, TriggerResponse } from './trigger-contracts';
import { TriggerExecutor } from './trigger-executor';

export type { TriggerRequest, TriggerResponse } from './trigger-contracts';

export class TriggerManager {
  private readonly executor: TriggerExecutor;

  constructor(
    private sdkClient: SDKClient,
    maxAttempts: number = 5,
    baseDelayMs: number = 1000,
    notifier?: WebhookNotifier,
    private manualApprovalEnabled: boolean = false,
    private readonly actionLock: OracleActionLock = NOOP_ORACLE_ACTION_LOCK,
  ) {
    this.executor = new TriggerExecutor(sdkClient, maxAttempts, baseDelayMs, notifier);
  }

  async executeTrigger(request: TriggerRequest): Promise<TriggerResponse> {
    StateValidator.validateTradeId(request.tradeId);

    const actionKey = generateActionKey(request.triggerType, request.tradeId);
    return this.actionLock.withLock(actionKey, () =>
      this.executeTriggerWithActionLock(request, actionKey),
    );
  }

  private async executeTriggerWithActionLock(
    request: TriggerRequest,
    actionKey: string,
  ): Promise<TriggerResponse> {
    Logger.info('Processing trigger request', {
      tradeId: request.tradeId,
      requestId: request.requestId,
      triggerType: request.triggerType,
      isRedrive: request.isRedrive || false,
    });

    const latestTrigger = await getLatestTriggerByActionKey(actionKey);

    if (latestTrigger && this.isActionAlreadyCompleted(latestTrigger)) {
      Logger.info('Action already completed', {
        actionKey,
        status: latestTrigger.status,
        txHash: latestTrigger.tx_hash,
      });

      return {
        idempotencyKey: latestTrigger.idempotency_key,
        actionKey,
        requestId: latestTrigger.request_id,
        status: latestTrigger.status,
        txHash: latestTrigger.tx_hash || undefined,
        blockNumber: latestTrigger.block_number ? Number(latestTrigger.block_number) : undefined,
        idempotent: true,
        message: 'Action already completed (idempotent)',
      };
    }

    if (request.isRedrive && latestTrigger?.status === TriggerStatus.EXHAUSTED_NEEDS_REDRIVE) {
      return await this.handleRedrive(latestTrigger, request);
    }

    const existingRequestIdKey = `${actionKey}:${request.requestId}`;
    const existingRequest = await getTriggerByIdempotencyKey(existingRequestIdKey);

    if (existingRequest) {
      return this.handleExistingTrigger(existingRequest, actionKey);
    }

    try {
      const trade = await this.sdkClient.getTrade(request.tradeId);
      StateValidator.validateTradeState(trade, request.triggerType);

      await this.assertTradeNotPaused(request.tradeId);

      if (this.manualApprovalEnabled && !request.isRedrive) {
        const trigger = await this.createNewTrigger(request, actionKey);
        if (trigger.request_id !== request.requestId) {
          return this.handleExistingTrigger(trigger, actionKey);
        }

        await updateTrigger(trigger.idempotency_key, {
          status: TriggerStatus.PENDING_APPROVAL,
        });

        incrementOraclePendingApproval(actionKey);

        Logger.audit('TRIGGER_PENDING_APPROVAL', request.tradeId, {
          actionKey,
          idempotencyKey: trigger.idempotency_key,
          triggerType: request.triggerType,
        });

        return {
          idempotencyKey: trigger.idempotency_key,
          actionKey,
          requestId: request.requestId,
          status: TriggerStatus.PENDING_APPROVAL,
          idempotent: false,
          message: 'Trigger created and awaiting manual approval',
        };
      }

      Logger.info('Trade state validated, creating new trigger', {
        tradeId: request.tradeId,
        triggerType: request.triggerType,
        tradeStatus: trade.status,
        actionKey,
      });

      const trigger = await this.createNewTrigger(request, actionKey);
      if (trigger.request_id !== request.requestId) {
        return this.handleExistingTrigger(trigger, actionKey);
      }
      return await this.executor.execute(trigger, actionKey);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      if (
        (error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'CALL_EXCEPTION') ||
        errorMessage.includes('trade not found') ||
        errorMessage.includes('execution reverted')
      ) {
        throw new ValidationError(
          `Trade ${request.tradeId} does not exist on-chain: ${errorMessage}`,
        );
      }
      throw error;
    }
  }

  private isActionAlreadyCompleted(trigger: Trigger): boolean {
    return trigger.status === TriggerStatus.CONFIRMED || trigger.status === TriggerStatus.SUBMITTED;
  }

  private isTransactionOutcomePending(trigger: Trigger): boolean {
    return (
      trigger.status === TriggerStatus.BROADCAST_PENDING ||
      trigger.status === TriggerStatus.BROADCAST_UNKNOWN
    );
  }

  // Per-trade pause is an admin hold that the contract enforces by reverting
  // every lifecycle transition. Decline early with a clear reason instead of
  // submitting a transaction that would revert with "trade paused". Every path
  // that ends up calling executeWithRetry (fresh trigger, re-drive, and
  // post-approval resume) must gate on this.
  private async assertTradeNotPaused(tradeId: string): Promise<void> {
    if (await this.sdkClient.isTradePaused(tradeId)) {
      throw new ValidationError(
        `Trade ${tradeId} is paused; oracle actions are blocked until an admin resumes it`,
      );
    }
  }

  private async handleRedrive(
    exhaustedTrigger: Trigger,
    request: TriggerRequest,
  ): Promise<TriggerResponse> {
    Logger.info('Handling re-drive for exhausted trigger', {
      actionKey: exhaustedTrigger.action_key,
      previousAttempts: exhaustedTrigger.attempt_count,
    });

    // Guard before the retry machinery: a re-drive skips the executeTrigger
    // pause check, so re-assert it here and let the ValidationError propagate
    // out (the catch below would otherwise treat it as "already executed").
    await this.assertTradeNotPaused(exhaustedTrigger.trade_id);

    incrementOracleRedriveAttempts(exhaustedTrigger.action_key);

    try {
      const trade = await this.sdkClient.getTrade(exhaustedTrigger.trade_id);
      StateValidator.validateTradeState(trade, exhaustedTrigger.trigger_type);

      Logger.info('Re-drive check: action still pending, creating new attempt', {
        actionKey: exhaustedTrigger.action_key,
        tradeStatus: trade.status,
      });

      const newRequestId = generateRequestId();
      const newIdempotencyKey = generateIdempotencyKey(exhaustedTrigger.action_key);

      const newTrigger = await createTrigger({
        actionKey: exhaustedTrigger.action_key,
        requestId: newRequestId,
        idempotencyKey: newIdempotencyKey,
        tradeId: exhaustedTrigger.trade_id,
        triggerType: exhaustedTrigger.trigger_type,
        requestHash: request.requestHash || null,
        status: TriggerStatus.PENDING,
      });

      if (newTrigger.request_id !== newRequestId) {
        return this.handleExistingTrigger(newTrigger, exhaustedTrigger.action_key);
      }

      Logger.info('Re-drive trigger created', {
        actionKey: newTrigger.action_key,
        newRequestId: newRequestId.substring(0, 16),
        previousRequestId: exhaustedTrigger.request_id.substring(0, 16),
      });

      return await this.executor.execute(newTrigger, exhaustedTrigger.action_key);
    } catch (error: unknown) {
      if (error instanceof ValidationError) {
        Logger.info('Re-drive check: action already executed on-chain', {
          actionKey: exhaustedTrigger.action_key,
          validationError: error.message,
        });

        await updateTrigger(exhaustedTrigger.idempotency_key, {
          status: TriggerStatus.CONFIRMED,
          on_chain_verified: true,
          on_chain_verified_at: new Date(),
          confirmed_at: new Date(),
        });

        return {
          idempotencyKey: exhaustedTrigger.idempotency_key,
          actionKey: exhaustedTrigger.action_key,
          requestId: exhaustedTrigger.request_id,
          status: TriggerStatus.CONFIRMED,
          txHash: exhaustedTrigger.tx_hash || undefined,
          idempotent: true,
          message: 'Action already executed on-chain (verified during re-drive)',
        };
      }

      Logger.error('Re-drive verification failed', {
        actionKey: exhaustedTrigger.action_key,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  private handleExistingTrigger(trigger: Trigger, actionKey: string): TriggerResponse {
    Logger.info('Found existing trigger for this request_id', {
      idempotencyKey: trigger.idempotency_key.substring(0, 32),
      actionKey,
      status: trigger.status,
      txHash: trigger.tx_hash,
    });

    if (trigger.status === TriggerStatus.CONFIRMED || trigger.status === TriggerStatus.SUBMITTED) {
      return {
        idempotencyKey: trigger.idempotency_key,
        actionKey,
        requestId: trigger.request_id,
        status: trigger.status,
        txHash: trigger.tx_hash || undefined,
        blockNumber: trigger.block_number ? Number(trigger.block_number) : undefined,
        idempotent: true,
        message: 'Trigger already executed for this request (idempotent)',
      };
    }

    if (this.isTransactionOutcomePending(trigger)) {
      return {
        idempotencyKey: trigger.idempotency_key,
        actionKey,
        requestId: trigger.request_id,
        status: trigger.status,
        txHash: trigger.tx_hash || undefined,
        idempotent: true,
        message: 'Transaction outcome is under reconciliation; rebroadcast is blocked',
      };
    }

    if (trigger.status === TriggerStatus.TERMINAL_FAILURE) {
      return {
        idempotencyKey: trigger.idempotency_key,
        actionKey,
        requestId: trigger.request_id,
        status: trigger.status,
        idempotent: false,
        message: trigger.last_error || 'Trigger failed with terminal error',
      };
    }

    if (trigger.status === TriggerStatus.EXHAUSTED_NEEDS_REDRIVE) {
      return {
        idempotencyKey: trigger.idempotency_key,
        actionKey,
        requestId: trigger.request_id,
        status: trigger.status,
        idempotent: false,
        message:
          'Trigger exhausted retries. Use re-drive endpoint to retry with on-chain verification.',
      };
    }

    return {
      idempotencyKey: trigger.idempotency_key,
      actionKey,
      requestId: trigger.request_id,
      status: trigger.status,
      idempotent: false,
      message: 'Trigger in progress',
    };
  }

  async resumeAfterApproval(idempotencyKey: string, actor: string): Promise<TriggerResponse> {
    const updated = await approveTrigger(idempotencyKey, actor);

    if (!updated) {
      const existing = await getTriggerByIdempotencyKey(idempotencyKey);
      if (!existing) {
        throw new ValidationError(`Trigger not found: ${idempotencyKey}`);
      }
      return this.buildResponseFromTrigger(existing, 'Trigger already processed');
    }

    return this.actionLock.withLock(updated.action_key, async () => {
      const current = await getTriggerByIdempotencyKey(idempotencyKey);
      if (current && this.isActionAlreadyCompleted(current)) {
        return this.handleExistingTrigger(current, current.action_key);
      }

      // Approval resumes straight into executeWithRetry, bypassing the
      // executeTrigger pause check, so re-assert the pause here.
      await this.assertTradeNotPaused(updated.trade_id);

      incrementOracleApproved(updated.action_key);

      Logger.audit('TRIGGER_APPROVED', updated.trade_id, {
        actionKey: updated.action_key,
        idempotencyKey,
        actor,
        approvedAt: updated.approved_at,
      });

      return this.executor.execute(updated, updated.action_key);
    });
  }

  async rejectPendingTrigger(
    idempotencyKey: string,
    actor: string,
    reason?: string,
  ): Promise<TriggerResponse> {
    const updated = await rejectTrigger(idempotencyKey, actor, reason);

    if (!updated) {
      const existing = await getTriggerByIdempotencyKey(idempotencyKey);
      if (!existing) {
        throw new ValidationError(`Trigger not found: ${idempotencyKey}`);
      }
      return this.buildResponseFromTrigger(existing, 'Trigger already processed');
    }

    incrementOracleRejected(updated.action_key);

    Logger.audit('TRIGGER_REJECTED', updated.trade_id, {
      actionKey: updated.action_key,
      idempotencyKey,
      actor,
      reason: reason ?? null,
      rejectedAt: updated.rejected_at,
    });

    return this.buildResponseFromTrigger(updated, `Trigger rejected by ${actor}`);
  }

  private buildResponseFromTrigger(trigger: Trigger, message: string): TriggerResponse {
    return {
      idempotencyKey: trigger.idempotency_key,
      actionKey: trigger.action_key,
      requestId: trigger.request_id,
      status: trigger.status,
      txHash: trigger.tx_hash ?? undefined,
      blockNumber: trigger.block_number ? Number(trigger.block_number) : undefined,
      idempotent: this.isActionAlreadyCompleted(trigger),
      message,
    };
  }

  private async createNewTrigger(request: TriggerRequest, actionKey: string): Promise<Trigger> {
    // Derive the idempotency key deterministically as `action_key:request_id`
    // (matching the Trigger.idempotency_key contract) so the pre-insert lookup
    // in triggerAction() can match a previously stored trigger for the same
    // request instead of relying solely on the active action_key unique index.
    const idempotencyKey = `${actionKey}:${request.requestId}`;

    const data: CreateTriggerData = {
      actionKey,
      requestId: request.requestId,
      idempotencyKey,
      tradeId: request.tradeId,
      triggerType: request.triggerType,
      requestHash: request.requestHash || null,
      status: TriggerStatus.PENDING,
    };

    return await createTrigger(data);
  }
}
