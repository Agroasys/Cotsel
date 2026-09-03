/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import { createGaslessCommandIntentKey, type GaslessCommandRecord } from './gaslessCommandStore';
import type {
  GaslessExecutionReceipt,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
import { normalizeWalletUsdcTransferInput } from './gaslessRequestNormalization';
import { GaslessTransactionOutcomePendingError } from './gaslessTransactionLifecycle';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';

export async function executeWalletUsdcTransferWorkflow(
  context: GaslessWorkflowContext,
  input: GaslessWalletUsdcTransferExecutionInput,
  command?: GaslessCommandRecord,
): Promise<{
  platformTransferId: string;
  txHash: string;
  receipt: GaslessExecutionReceipt;
  requestId: string;
}> {
  const normalized = normalizeWalletUsdcTransferInput(
    input,
    context.chainId,
    context.usdcAddress,
    context.now(),
    context.requestMaxTtlSeconds,
  );
  context.assertBroadcastOpen(normalized.action);
  context.assertCapacityOpen(normalized.action);
  if (!command) {
    const { requestId: _requestId, sourceApiKeyId: _sourceApiKeyId, ...intentPayload } = normalized;
    const accepted = await context.commandStore.enqueueCommand({
      applicationRequestId: normalized.requestId,
      intentKey: createGaslessCommandIntentKey(intentPayload),
      resourceType: 'platform_transfer',
      resourceId: normalized.platformTransferId,
      operation: normalized.action,
      payload: normalized as unknown as Record<string, unknown>,
      maxAttempts: context.commandMaxAttempts,
      maxQueueDepth: context.commandMaxPending,
      nextAttemptAt: context.now().toISOString(),
    });
    return context.dispatchCommand(accepted);
  }
  if (
    command.applicationRequestId !== normalized.requestId ||
    command.resourceId !== normalized.platformTransferId ||
    command.operation !== normalized.action
  ) {
    throw new GatewayError(500, 'INTERNAL_ERROR', 'Gasless command request binding is invalid');
  }
  await context.executor.simulateWalletUsdcTransfer(normalized);
  const submission = await context.runBroadcast(normalized.requestId, () =>
    context.executor.executeWalletUsdcTransfer(normalized),
  );
  if (!submission.receipt) {
    throw new GaslessTransactionOutcomePendingError(
      submission.txHash,
      'confirmation_pending',
      'Sponsored USDC transfer confirmation requires reconciliation',
    );
  }
  context.recordExecutionReceipt(submission.receipt);
  return {
    platformTransferId: normalized.platformTransferId,
    txHash: submission.txHash,
    receipt: submission.receipt,
    requestId: normalized.requestId,
  };
}
