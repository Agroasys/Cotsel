/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { serializeGasEstimate } from './gaslessExecutionEvidence';
import { recordGaslessExecutionFailure } from './gaslessExecutionFailure';
import type {
  GaslessCreateTradeExecutionInput,
  GaslessCreateTradeExecutionResult,
} from './gaslessExecutionTypes';
import {
  assertAmountsMatchAuthorization,
  assertAuthorizationBindings,
  assertContractMatchesRuntime,
  assertCreateTradePayloadHash,
  assertHandoffMatchesExecution,
} from './gaslessExecutionValidation';
import {
  normalizeCreateTradeInput,
  parseGaslessExpiry,
  requireGaslessChainId,
} from './gaslessRequestNormalization';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';
import type { SettlementExecutionEventRecord } from './settlementStore';
import { projectPersistedGaslessTransaction } from './gaslessTransactionLifecycle';

export async function executeCreateTradeWorkflow(
  context: GaslessWorkflowContext,

  input: GaslessCreateTradeExecutionInput,
): Promise<GaslessCreateTradeExecutionResult> {
  const now = context.now();
  const normalized = normalizeCreateTradeInput({
    ...input,
    chainId: requireGaslessChainId(input.chainId, context.chainId),
    expiresAt: parseGaslessExpiry(input.expiresAt, context.requestMaxTtlSeconds, now),
  });
  assertAmountsMatchAuthorization(normalized);
  assertContractMatchesRuntime(normalized, context.escrowAddress);
  assertAuthorizationBindings(normalized, now);
  assertCreateTradePayloadHash(normalized);
  context.assertBroadcastOpen('create_trade');
  context.assertCapacityOpen('create_trade');

  const handoff = await context.store.getHandoff(normalized.handoffId);
  if (!handoff) {
    throw new GatewayError(404, 'NOT_FOUND', 'Settlement handoff not found', {
      handoffId: normalized.handoffId,
    });
  }
  assertHandoffMatchesExecution(handoff, normalized);

  const accepted = await context.settlementService.recordExecutionEvent({
    handoffId: normalized.handoffId,
    eventType: 'accepted',
    executionStatus: 'accepted',
    reconciliationStatus: handoff.reconciliationStatus,
    providerStatus: 'gasless_request_accepted',
    detail: 'Gasless create-trade request accepted by Cotsel execution service.',
    metadata: {
      action: 'create_trade',
      chainId: normalized.chainId,
      contractAddress: normalized.contractAddress,
      expiresAt: normalized.expiresAt,
      payloadHash: normalized.payloadHash,
      buyerAddress: normalized.buyerAddress,
      supplierAddress: normalized.supplierAddress,
      ricardianHash: normalized.ricardianHash,
    },
    observedAt: new Date().toISOString(),
    requestId: normalized.requestId,
    sourceApiKeyId: normalized.sourceApiKeyId,
  });

  try {
    const queued = await context.settlementService.recordExecutionEvent({
      handoffId: normalized.handoffId,
      eventType: 'queued',
      executionStatus: 'queued',
      reconciliationStatus: accepted.handoff.reconciliationStatus,
      providerStatus: 'gasless_request_queued',
      detail: 'Gasless create-trade request queued for simulation.',
      metadata: {
        action: 'create_trade',
        payloadHash: normalized.payloadHash,
      },
      observedAt: new Date().toISOString(),
      requestId: normalized.requestId,
      sourceApiKeyId: normalized.sourceApiKeyId,
    });

    const simulation = await context.executor.simulateCreateTrade(normalized);
    const simulationEvent = await context.settlementService.recordExecutionEvent({
      handoffId: normalized.handoffId,
      eventType: 'simulation_completed',
      executionStatus: 'queued',
      reconciliationStatus: queued.handoff.reconciliationStatus,
      providerStatus: 'gasless_simulation_completed',
      detail: 'Gasless create-trade transaction simulation completed.',
      metadata: {
        action: 'create_trade',
        gasEstimate: serializeGasEstimate(simulation.gasEstimate),
        payloadHash: normalized.payloadHash,
      },
      observedAt: new Date().toISOString(),
      requestId: normalized.requestId,
      sourceApiKeyId: normalized.sourceApiKeyId,
    });

    const execution = await context.enqueueBroadcast(() =>
      context.executor.executeCreateTrade(normalized),
    );
    return await projectPersistedGaslessTransaction(execution.txHash, async () => {
      const submitted = await context.settlementService.recordExecutionEvent({
        handoffId: normalized.handoffId,
        eventType: 'submitted',
        executionStatus: 'submitted',
        reconciliationStatus: simulationEvent.handoff.reconciliationStatus,
        providerStatus: 'gasless_broadcast_submitted',
        txHash: execution.txHash,
        detail: 'Gasless create-trade transaction submitted by Cotsel.',
        metadata: {
          action: 'create_trade',
          usdcAuthorizationNonce: normalized.usdcAuthorization.nonce,
          payloadHash: normalized.payloadHash,
          chainId: normalized.chainId,
          contractAddress: normalized.contractAddress,
          buyerAddress: normalized.buyerAddress,
          supplierAddress: normalized.supplierAddress,
          totalAmount: normalized.totalAmount,
          logisticsAmount: normalized.logisticsAmount,
          platformFeesAmount: normalized.platformFeesAmount,
          supplierFirstTranche: normalized.supplierFirstTranche,
          supplierSecondTranche: normalized.supplierSecondTranche,
          ricardianHash: normalized.ricardianHash,
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
          providerStatus: 'gasless_receipt_confirmed',
          txHash: execution.txHash,
          detail: 'Gasless create-trade transaction confirmed on-chain.',
          metadata: context.buildConfirmedExecutionMetadata(
            'create_trade',
            normalized.payloadHash,
            execution.receipt,
            {
              chainId: normalized.chainId,
              contractAddress: normalized.contractAddress,
              buyerAddress: normalized.buyerAddress,
              supplierAddress: normalized.supplierAddress,
              totalAmount: normalized.totalAmount,
              logisticsAmount: normalized.logisticsAmount,
              platformFeesAmount: normalized.platformFeesAmount,
              supplierFirstTranche: normalized.supplierFirstTranche,
              supplierSecondTranche: normalized.supplierSecondTranche,
              ricardianHash: normalized.ricardianHash,
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
    return recordGaslessExecutionFailure(
      context,
      {
        handoffId: normalized.handoffId,
        reconciliationStatus: accepted.handoff.reconciliationStatus,
        action: 'create_trade',
        payloadHash: normalized.payloadHash,
        requestId: normalized.requestId,
        sourceApiKeyId: normalized.sourceApiKeyId,
      },
      error,
    );
  }
}
