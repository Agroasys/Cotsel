/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';
import type { SettlementReconciliationStatus } from './settlementStore';
import {
  isGaslessTransactionOutcomePendingError,
  isGaslessTransactionRevertedError,
} from './gaslessTransactionLifecycle';

interface GaslessFailureContext {
  handoffId: string;
  action: string;
  payloadHash: string;
  requestId: string;
  sourceApiKeyId?: string | null;
  reconciliationStatus: SettlementReconciliationStatus;
}

export async function recordGaslessExecutionFailure(
  context: GaslessWorkflowContext,
  input: GaslessFailureContext,
  error: unknown,
): Promise<never> {
  if (isGaslessTransactionOutcomePendingError(error)) {
    await context.settlementService.recordExecutionEvent({
      handoffId: input.handoffId,
      eventType: error.outcome,
      executionStatus: error.outcome,
      reconciliationStatus: input.reconciliationStatus,
      providerStatus: `gasless_${error.outcome}`,
      txHash: error.transactionHash,
      detail: error.message,
      metadata: {
        action: input.action,
        payloadHash: input.payloadHash,
        recoveryRequired: true,
        rebroadcastAllowed: false,
      },
      observedAt: context.now().toISOString(),
      requestId: input.requestId,
      sourceApiKeyId: input.sourceApiKeyId,
    });
    throw error;
  }

  if (isGaslessTransactionRevertedError(error)) {
    await context.settlementService.recordExecutionEvent({
      handoffId: input.handoffId,
      eventType: 'reverted',
      executionStatus: 'reverted',
      reconciliationStatus: input.reconciliationStatus,
      providerStatus: 'gasless_receipt_reverted',
      txHash: error.transactionHash,
      detail: error.message,
      metadata: {
        action: input.action,
        payloadHash: input.payloadHash,
        blockNumber: error.blockNumber,
      },
      observedAt: context.now().toISOString(),
      requestId: input.requestId,
      sourceApiKeyId: input.sourceApiKeyId,
    });
    throw error;
  }

  const message = error instanceof Error ? error.message : 'Unknown gasless execution failure';
  await context.settlementService.recordExecutionEvent({
    handoffId: input.handoffId,
    eventType: 'failed',
    executionStatus: 'failed',
    reconciliationStatus: input.reconciliationStatus,
    providerStatus: 'gasless_pre_broadcast_failed',
    detail: message,
    metadata: { action: input.action, payloadHash: input.payloadHash },
    observedAt: context.now().toISOString(),
    requestId: input.requestId,
    sourceApiKeyId: input.sourceApiKeyId,
  });
  throw new GatewayError(502, 'UPSTREAM_UNAVAILABLE', 'Gasless execution failed', {
    reason: message,
  });
}
