/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { GatewayError } from '../errors';
import type {
  GaslessExecutionReceipt,
  GaslessWalletUsdcTransferExecutionInput,
} from './gaslessExecutionTypes';
import { normalizeWalletUsdcTransferInput } from './gaslessRequestNormalization';
import type { GaslessWorkflowContext } from './gaslessWorkflowContext';

export async function executeWalletUsdcTransferWorkflow(
  context: GaslessWorkflowContext,
  input: GaslessWalletUsdcTransferExecutionInput,
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
  await context.executor.simulateWalletUsdcTransfer(normalized);
  const submission = await context.enqueueBroadcast(() =>
    context.executor.executeWalletUsdcTransfer(normalized),
  );
  if (!submission.receipt) {
    throw new GatewayError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Sponsored USDC transfer receipt was not available',
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
