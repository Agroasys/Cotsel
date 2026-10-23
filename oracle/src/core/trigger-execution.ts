import { StateValidator } from './state-validator';
import { triggerFinality } from './trigger-finality';
import type { SDKClient } from '../blockchain/sdk-client';
import type { ContainmentGuard } from './containment-guard';
import type { TriggerResponse } from './trigger-manager';
import { TriggerStatus, TriggerType, ErrorType, type Trigger } from '../types/trigger';
import {
  claimTriggerDispatch,
  getUnresolvedSignerDispatch,
  resolveSignerDispatch,
  getTriggerByIdempotencyKey,
  updateTrigger,
} from '../database/queries';
import { calculateBackoff } from '../utils/crypto';
import {
  classifyError,
  determineNextStatus,
  publicFailureMessage,
  ValidationError,
} from '../utils/errors';
import { incrementOracleExhaustedRetries } from '../metrics/counters';
import { Logger } from '../utils/logger';
import { submitTriggerAction } from './blockchain-actions';
import { requireFundedBinding } from './funded-settlement-instruction';

export type TriggerExecutionDependencies = {
  sdkClient: SDKClient;
  maxAttempts: number;
  baseDelayMs: number;
  containmentGuard: ContainmentGuard;
  handleExistingTrigger: (trigger: Trigger, actionKey: string) => TriggerResponse;
  notifyTerminalStatus: (
    trigger: Trigger,
    actionKey: string,
    status: TriggerStatus,
    message: string,
    attempt: number,
  ) => Promise<void>;
};
/** Read-only retries end at the durable dispatch claim. A claimed send is never repeated. */
export async function executeTriggerWithRetry(
  trigger: Trigger,
  actionKey: string,
  dependencies: TriggerExecutionDependencies,
): Promise<TriggerResponse> {
  const {
    sdkClient,
    maxAttempts,
    baseDelayMs,
    containmentGuard,
    handleExistingTrigger,
    notifyTerminalStatus,
  } = dependencies;
  let attempt = 1;
  let dispatchClaimed = false;
  let observedHash: string | undefined;

  while (attempt <= maxAttempts) {
    try {
      Logger.info('Executing trigger attempt', {
        idempotencyKey: trigger.idempotency_key.substring(0, 32),
        actionKey,
        attempt,
        maxAttempts,
      });

      const trade = await sdkClient.getTrade(trigger.trade_id);
      StateValidator.validateTradeState(trade, trigger.trigger_type);

      await updateTrigger(trigger.idempotency_key, {
        status: TriggerStatus.EXECUTING,
        attempt_count: attempt,
      });

      if (trigger.trigger_type === TriggerType.FINALIZE_AFTER_INSPECTION_ACCEPTANCE)
        throw new ValidationError(
          'Buyer authorization is required; submit inspection acceptance through the gateway user-action route',
        );
      // Complete all read-only checks before the durable broadcast exclusion claim.
      const binding = requireFundedBinding(
        trigger.funded_binding,
        trigger.trade_id,
        trigger.trigger_type,
      );
      await sdkClient.assertFundedBinding(binding);
      await containmentGuard.assertMayProgress(trigger.trade_id);
      const signerScope = await sdkClient.getDispatchSignerScope();
      const unresolved = await getUnresolvedSignerDispatch(signerScope);
      if (unresolved && unresolved.idempotency_key !== trigger.idempotency_key) {
        if (!unresolved.tx_hash || unresolved.dispatch_signer_scope !== signerScope)
          throw new ValidationError(
            'Oracle signer has an unresolved original dispatch; new sends are blocked',
          );
        await resolveSignerDispatch(
          unresolved.idempotency_key,
          await sdkClient.verifyDispatchFinality(signerScope, unresolved.tx_hash),
        );
      }
      if (!(await claimTriggerDispatch(trigger.idempotency_key, signerScope))) {
        const original = await getTriggerByIdempotencyKey(trigger.idempotency_key);
        if (!original?.dispatch_started_at)
          throw new ValidationError('Oracle signer dispatch is reserved; new sends are blocked');
        return handleExistingTrigger(original, actionKey);
      }
      dispatchClaimed = true;
      const result = await submitTriggerAction(
        sdkClient,
        trigger.trigger_type,
        trigger.trade_id,
        async (hash) => {
          if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
            throw new ValidationError('Oracle broadcast returned an invalid transaction identity');
          observedHash = hash.toLowerCase();
          await updateTrigger(trigger.idempotency_key, {
            status: TriggerStatus.SUBMITTED,
            tx_hash: observedHash,
            submitted_at: new Date(),
          });
        },
      );

      await updateTrigger(trigger.idempotency_key, {
        status: TriggerStatus.SUBMITTED,
        tx_hash: result.txHash,
        block_number: BigInt(result.blockNumber),
        submitted_at: new Date(),
      });

      Logger.info('Trigger submitted successfully', {
        idempotencyKey: trigger.idempotency_key.substring(0, 32),
        actionKey,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
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
        finality: triggerFinality({
          status: TriggerStatus.SUBMITTED,
          tx_hash: result.txHash,
          confirmation_stage: null,
        }),
      };
    } catch (error: unknown) {
      if (dispatchClaimed) {
        const status = observedHash ? TriggerStatus.SUBMITTED : TriggerStatus.EXECUTING;
        await updateTrigger(trigger.idempotency_key, {
          status,
          last_error:
            'Original dispatch outcome requires independent reconciliation. Resubmission is blocked.',
          error_type: ErrorType.NETWORK,
        });
        return {
          idempotencyKey: trigger.idempotency_key,
          actionKey,
          requestId: trigger.request_id,
          status,
          txHash: observedHash,
          idempotent: false,
          finality: triggerFinality({
            status,
            tx_hash: observedHash ?? null,
            confirmation_stage: null,
            dispatch_started_at: new Date(),
          }),
          message:
            'Original dispatch outcome is unresolved; observation continues without another submission.',
        };
      }
      const oracleError = classifyError(error);

      Logger.error('Trigger execution failed', {
        idempotencyKey: trigger.idempotency_key.substring(0, 32),
        actionKey,
        attempt,
        errorType: oracleError.errorType,
        isTerminal: oracleError.isTerminal,
        message: publicFailureMessage(oracleError),
      });

      const nextStatus = determineNextStatus(oracleError, attempt, maxAttempts);

      await updateTrigger(trigger.idempotency_key, {
        status: nextStatus,
        attempt_count: attempt,
        last_error: publicFailureMessage(oracleError),
        error_type: oracleError.errorType,
      });

      if (nextStatus === TriggerStatus.TERMINAL_FAILURE) {
        await notifyTerminalStatus(
          trigger,
          actionKey,
          nextStatus,
          publicFailureMessage(oracleError),
          attempt,
        );
        return {
          idempotencyKey: trigger.idempotency_key,
          actionKey,
          requestId: trigger.request_id,
          status: nextStatus,
          idempotent: false,
          message: publicFailureMessage(oracleError),
        };
      }

      if (nextStatus === TriggerStatus.EXHAUSTED_NEEDS_REDRIVE) {
        const exhaustedMessage = `Exhausted ${maxAttempts} attempts: ${publicFailureMessage(oracleError)}. Use re-drive endpoint to retry.`;
        incrementOracleExhaustedRetries(actionKey);
        await notifyTerminalStatus(trigger, actionKey, nextStatus, exhaustedMessage, attempt);
        return {
          idempotencyKey: trigger.idempotency_key,
          actionKey,
          requestId: trigger.request_id,
          status: nextStatus,
          idempotent: false,
          message: exhaustedMessage,
        };
      }

      if (attempt < maxAttempts && !oracleError.isTerminal) {
        const backoffMs = calculateBackoff(attempt, baseDelayMs, 30000);
        Logger.info('Retrying after backoff', {
          idempotencyKey: trigger.idempotency_key.substring(0, 32),
          actionKey,
          backoffMs,
          maxBackoffMs: 30000,
          nextAttempt: attempt + 1,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        attempt++;
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Retry loop exited without terminal status for action ${actionKey} after ${maxAttempts} attempts`,
  );
}
