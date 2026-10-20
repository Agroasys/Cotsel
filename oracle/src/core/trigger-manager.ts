import { type SettlementFundedBinding } from '@agroasys/sdk';
import { SDKClient } from '../blockchain/sdk-client';
import { StateValidator } from './state-validator';
import { Trigger, TriggerType, TriggerStatus, CreateTriggerData } from '../types/trigger';
import {
  createTrigger,
  getTriggerByIdempotencyKey,
  getLatestTriggerByActionKey,
  updateTrigger,
} from '../database/queries';
import { generateActionKey, generateRequestId, generateIdempotencyKey } from '../utils/crypto';
import { getErrorMessage, storedFailureMessage, ValidationError } from '../utils/errors';
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
import { createContainmentGuard, type ContainmentGuard } from './containment-guard';
import { executeTriggerWithRetry } from './trigger-execution';
import { requireFundedBinding } from './funded-settlement-instruction';

export interface TriggerRequest {
  fundedBinding?: SettlementFundedBinding;
  tradeId: string;
  requestId: string;
  triggerType: TriggerType;
  requestHash?: string;
  isRedrive?: boolean;
}

export interface TriggerResponse {
  idempotencyKey: string;
  actionKey: string;
  requestId: string;
  status: TriggerStatus;
  txHash?: string;
  blockNumber?: number;
  idempotent: boolean;
  message: string;
}

export class TriggerManager {
  constructor(
    private sdkClient: SDKClient,
    private maxAttempts: number = 5,
    private baseDelayMs: number = 1000,
    private notifier?: WebhookNotifier,
    private manualApprovalEnabled: boolean = false,
    private readonly actionLock: OracleActionLock = NOOP_ORACLE_ACTION_LOCK,
    private readonly containmentGuard: ContainmentGuard = createContainmentGuard(),
  ) {}

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
    if (
      request.fundedBinding &&
      latestTrigger &&
      JSON.stringify(
        requireFundedBinding(request.fundedBinding, request.tradeId, request.triggerType),
      ) !==
        JSON.stringify(
          requireFundedBinding(
            latestTrigger.funded_binding,
            latestTrigger.trade_id,
            latestTrigger.trigger_type,
          ),
        )
    )
      throw new ValidationError('The original funded progression instruction cannot be replaced');

    if (latestTrigger?.dispatch_started_at && !this.isActionAlreadyCompleted(latestTrigger))
      return this.handleExistingTrigger(latestTrigger, actionKey);
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

    const fundedBinding = requireFundedBinding(
      request.fundedBinding,
      request.tradeId,
      request.triggerType,
    );
    await this.sdkClient.assertFundedBinding(fundedBinding);
    try {
      const trade = await this.sdkClient.getTrade(request.tradeId);
      StateValidator.validateTradeState(trade, request.triggerType);

      await this.assertTradeMayProgress(request.tradeId);

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
      return await this.executeWithRetry(trigger, actionKey);
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
        Logger.warn('Trade lookup refused on-chain', { tradeId: request.tradeId, errorMessage });
        throw new ValidationError(`Trade ${request.tradeId} does not exist on-chain`);
      }
      throw error;
    }
  }

  private isActionAlreadyCompleted(trigger: Trigger): boolean {
    return trigger.status === TriggerStatus.CONFIRMED || trigger.status === TriggerStatus.SUBMITTED;
  }

  // Per-trade pause is an admin hold that the contract enforces by reverting
  // every lifecycle transition. Decline early with a clear reason instead of
  // submitting a transaction that would revert with "trade paused". Every path
  // that ends up calling executeWithRetry (fresh trigger, re-drive, and
  // post-approval resume) must gate on this.
  /**
   * Both reasons a trade must not move: the escrow's own scoped pause, and a
   * reconciliation containment. The pause is the stronger control but the
   * slower one, since an admin has to apply it; the containment binds as soon
   * as reconciliation commits it, which is what closes the window between a
   * qualified discrepancy and the pause landing.
   */
  private async assertTradeMayProgress(tradeId: string): Promise<void> {
    if (await this.sdkClient.isTradePaused(tradeId)) {
      throw new ValidationError(
        `Trade ${tradeId} is paused; oracle actions are blocked until an admin resumes it`,
      );
    }

    await this.containmentGuard.assertMayProgress(tradeId);
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
    // pause check, so re-assert it here and let the error propagate out (the
    // catch below would otherwise treat it as "already executed").
    await this.sdkClient.assertFundedBinding(
      requireFundedBinding(
        exhaustedTrigger.funded_binding,
        exhaustedTrigger.trade_id,
        exhaustedTrigger.trigger_type,
      ),
    );
    await this.assertTradeMayProgress(exhaustedTrigger.trade_id);

    if (
      exhaustedTrigger.dispatch_started_at ||
      exhaustedTrigger.tx_hash ||
      exhaustedTrigger.submitted_at
    )
      throw new ValidationError(
        'Original execution requires independent reconciliation; re-drive cannot create another transaction',
      );

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
        fundedBinding: requireFundedBinding(
          exhaustedTrigger.funded_binding,
          exhaustedTrigger.trade_id,
          exhaustedTrigger.trigger_type,
        ),
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

      return await this.executeWithRetry(newTrigger, exhaustedTrigger.action_key);
    } catch (error: unknown) {
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

    if (trigger.status === TriggerStatus.TERMINAL_FAILURE) {
      return {
        idempotencyKey: trigger.idempotency_key,
        actionKey,
        requestId: trigger.request_id,
        status: trigger.status,
        idempotent: false,
        message: storedFailureMessage(trigger.error_type),
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
      // executeTrigger checks, so re-assert them here.
      await this.assertTradeMayProgress(updated.trade_id);

      incrementOracleApproved(updated.action_key);

      Logger.audit('TRIGGER_APPROVED', updated.trade_id, {
        actionKey: updated.action_key,
        idempotencyKey,
        actor,
        approvedAt: updated.approved_at,
      });

      return this.executeWithRetry(updated, updated.action_key);
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
      fundedBinding: requireFundedBinding(
        request.fundedBinding,
        request.tradeId,
        request.triggerType,
      ),
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

  private executeWithRetry(trigger: Trigger, actionKey: string): Promise<TriggerResponse> {
    return executeTriggerWithRetry(trigger, actionKey, {
      sdkClient: this.sdkClient,
      maxAttempts: this.maxAttempts,
      baseDelayMs: this.baseDelayMs,
      containmentGuard: this.containmentGuard,
      handleExistingTrigger: this.handleExistingTrigger.bind(this),
      notifyTerminalStatus: this.notifyTerminalStatus.bind(this),
    });
  }

  private async notifyTerminalStatus(
    trigger: Trigger,
    actionKey: string,
    status: TriggerStatus,
    message: string,
    attempt: number,
  ): Promise<void> {
    if (!this.notifier) {
      return;
    }

    const eventType =
      status === TriggerStatus.TERMINAL_FAILURE
        ? 'ORACLE_TRIGGER_TERMINAL_FAILURE'
        : 'ORACLE_TRIGGER_EXHAUSTED_NEEDS_REDRIVE';

    await this.notifier.notify({
      source: 'oracle',
      type: eventType,
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
}
