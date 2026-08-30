/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { createGaslessCommandIntentKey, type GaslessCommandRecord } from './gaslessCommandStore';
import { serializeGasEstimate } from './gaslessExecutionEvidence';
import { recordGaslessExecutionFailure } from './gaslessExecutionFailure';
import type {
  GaslessCreateTradeExecutionResult,
  GaslessOperatorActionExecutionInput,
} from './gaslessExecutionTypes';
import {
  assertContractMatchesRuntime,
  assertOperatorActionPayloadHash,
} from './gaslessExecutionValidation';
import {
  normalizeOperatorActionInput,
  parseGaslessExpiry,
  requireGaslessChainId,
} from './gaslessRequestNormalization';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';
import type { SettlementExecutionEventRecord } from './settlementStore';
import {
  isGaslessTransactionOutcomePendingError,
  isGaslessTransactionRevertedError,
  projectPersistedGaslessTransaction,
} from './gaslessTransactionLifecycle';

export async function executeOperatorActionWorkflow(
  context: GaslessWorkflowContext,
  input: GaslessOperatorActionExecutionInput,
  command?: GaslessCommandRecord,
): Promise<GaslessCreateTradeExecutionResult> {
  const now = context.now();
  const normalized = normalizeOperatorActionInput({
    ...input,
    chainId: requireGaslessChainId(input.chainId, context.chainId),
    expiresAt: parseGaslessExpiry(input.expiresAt, context.requestMaxTtlSeconds, now),
  });
  assertContractMatchesRuntime(normalized, context.escrowAddress);
  assertOperatorActionPayloadHash(normalized);
  context.assertBroadcastOpen(normalized.action);
  context.assertCapacityOpen(normalized.action);

  const handoff = await context.store.getHandoff(normalized.handoffId);
  if (!handoff) {
    throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', {
      handoffId: normalized.handoffId,
    });
  }

  if (!command) {
    const { requestId: _requestId, sourceApiKeyId: _sourceApiKeyId, ...intentPayload } = normalized;
    const recorded = await context.settlementService.recordExecutionEvent(
      {
        handoffId: normalized.handoffId,
        eventType: 'accepted',
        executionStatus: 'accepted',
        reconciliationStatus: handoff.reconciliationStatus,
        providerStatus: 'gasless_operator_request_accepted',
        detail: `Gasless operator ${normalized.action} request accepted by Cotsel execution service.`,
        metadata: {
          action: normalized.action,
          chainId: normalized.chainId,
          contractAddress: normalized.contractAddress,
          expiresAt: normalized.expiresAt,
          payloadHash: normalized.payloadHash,
          tradeId: normalized.tradeId,
          userAuthorizationRequired: false,
        },
        observedAt: context.now().toISOString(),
        requestId: normalized.requestId,
        sourceApiKeyId: normalized.sourceApiKeyId,
      },
      {
        applicationRequestId: normalized.requestId,
        intentKey: createGaslessCommandIntentKey(intentPayload),
        resourceType: 'settlement_handoff',
        resourceId: normalized.handoffId,
        operation: normalized.action,
        payload: normalized as unknown as Record<string, unknown>,
        maxAttempts: context.commandMaxAttempts,
        maxQueueDepth: context.commandMaxPending,
        nextAttemptAt: context.now().toISOString(),
      },
    );
    if (!recorded.command) {
      throw new GatewayError(500, 'INTERNAL_ERROR', 'Accepted gasless command was not persisted');
    }
    return context.dispatchCommand<GaslessCreateTradeExecutionResult>(recorded.command);
  }

  if (
    command.applicationRequestId !== normalized.requestId ||
    command.resourceId !== normalized.handoffId ||
    command.operation !== normalized.action
  ) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Gasless command request binding is invalid');
  }
  const acceptedEvent = (await context.store.listExecutionEvents(normalized.handoffId)).find(
    (event) => event.eventType === 'accepted' && event.requestId === normalized.requestId,
  );
  if (!acceptedEvent) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Gasless command acceptance event is missing');
  }
  const accepted = { handoff, event: acceptedEvent };

  try {
    const queued = await context.settlementService.recordExecutionEvent({
      handoffId: normalized.handoffId,
      eventType: 'queued',
      executionStatus: 'queued',
      reconciliationStatus: accepted.handoff.reconciliationStatus,
      providerStatus: 'gasless_operator_request_queued',
      detail: `Gasless operator ${normalized.action} request queued for simulation.`,
      metadata: {
        action: normalized.action,
        payloadHash: normalized.payloadHash,
        userAuthorizationRequired: false,
      },
      observedAt: new Date().toISOString(),
      requestId: normalized.requestId,
      sourceApiKeyId: normalized.sourceApiKeyId,
    });

    const simulation = await context.executor.simulateOperatorAction(normalized);
    const simulationEvent = await context.settlementService.recordExecutionEvent({
      handoffId: normalized.handoffId,
      eventType: 'simulation_completed',
      executionStatus: 'queued',
      reconciliationStatus: queued.handoff.reconciliationStatus,
      providerStatus: 'gasless_operator_simulation_completed',
      detail: `Gasless operator ${normalized.action} transaction simulation completed.`,
      metadata: {
        action: normalized.action,
        gasEstimate: serializeGasEstimate(simulation.gasEstimate),
        payloadHash: normalized.payloadHash,
        userAuthorizationRequired: false,
      },
      observedAt: new Date().toISOString(),
      requestId: normalized.requestId,
      sourceApiKeyId: normalized.sourceApiKeyId,
    });

    const execution = await context.runBroadcast(normalized.requestId, () =>
      context.executor.executeOperatorAction(normalized),
    );
    return await projectPersistedGaslessTransaction(execution.txHash, async () => {
      const submitted = await context.settlementService.recordExecutionEvent({
        handoffId: normalized.handoffId,
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: simulationEvent.handoff.reconciliationStatus,
        providerStatus: 'gasless_operator_broadcast_submitted',
        txHash: execution.txHash,
        detail: `Gasless operator ${normalized.action} transaction submitted by Cotsel.`,
        metadata: {
          action: normalized.action,
          payloadHash: normalized.payloadHash,
          chainId: normalized.chainId,
          contractAddress: normalized.contractAddress,
          tradeId: normalized.tradeId,
          userAuthorizationRequired: false,
        },
        observedAt: new Date().toISOString(),
        requestId: normalized.requestId,
        sourceApiKeyId: normalized.sourceApiKeyId,
      });
      let finalHandoff = submitted.handoff;
      let confirmedEvent: SettlementExecutionEventRecord | undefined;

      if (execution.receipt) {
        context.recordExecutionReceipt(execution.receipt);
        const confirmed = await context.settlementService.recordExecutionEvent({
          handoffId: normalized.handoffId,
          eventType: 'confirmed',
          executionStatus: 'confirmed',
          reconciliationStatus: submitted.handoff.reconciliationStatus,
          providerStatus: 'gasless_operator_receipt_confirmed',
          txHash: execution.txHash,
          detail: `Gasless operator ${normalized.action} transaction confirmed on-chain.`,
          metadata: context.buildConfirmedExecutionMetadata(
            normalized.action,
            normalized.payloadHash,
            execution.receipt,
            {
              chainId: normalized.chainId,
              contractAddress: normalized.contractAddress,
              tradeId: normalized.tradeId,
              userAuthorizationRequired: false,
            },
          ),
          observedAt: new Date().toISOString(),
          requestId: normalized.requestId,
          sourceApiKeyId: normalized.sourceApiKeyId,
        });
        finalHandoff = confirmed.handoff;
        confirmedEvent = confirmed.event;
      }

      return {
        handoff: finalHandoff,
        acceptedEvent: accepted.event,
        queuedEvent: queued.event,
        simulationEvent: simulationEvent.event,
        submittedEvent: submitted.event,
        confirmedEvent,
        txHash: execution.txHash,
      };
    });
  } catch (error) {
    if (
      isGaslessTransactionOutcomePendingError(error) ||
      isGaslessTransactionRevertedError(error)
    ) {
      return recordGaslessExecutionFailure(
        context,
        {
          handoffId: normalized.handoffId,
          reconciliationStatus: accepted.handoff.reconciliationStatus,
          action: normalized.action,
          payloadHash: normalized.payloadHash,
          requestId: normalized.requestId,
          sourceApiKeyId: normalized.sourceApiKeyId,
        },
        error,
      );
    }
    throw error;
  }
}
