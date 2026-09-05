/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { recordGaslessExecutionFailure } from '../src/core/gaslessExecutionFailure';
import type { GaslessWorkflowContext } from '../src/core/gaslessWorkflowContext';
import {
  GaslessTransactionOutcomePendingError,
  GaslessTransactionRevertedError,
} from '../src/core/gaslessTransactionLifecycle';

const transactionHash = `0x${'a'.repeat(64)}`;

function createContext() {
  const recordExecutionEvent = jest.fn(async () => undefined);
  return {
    context: {
      settlementService: { recordExecutionEvent },
      now: () => new Date('2026-08-28T12:00:00.000Z'),
    } as unknown as GaslessWorkflowContext,
    recordExecutionEvent,
  };
}

const failureContext = {
  handoffId: 'handoff-1',
  action: 'create_trade',
  payloadHash: `0x${'b'.repeat(64)}`,
  requestId: 'request-1',
  sourceApiKeyId: 'service-key-1',
  reconciliationStatus: 'pending' as const,
};

describe('gasless workflow financial outcome classification', () => {
  test.each(['broadcast_unknown', 'confirmation_pending'] as const)(
    'persists %s with the canonical hash and forbids rebroadcast',
    async (outcome) => {
      const { context, recordExecutionEvent } = createContext();
      const error = new GaslessTransactionOutcomePendingError(
        transactionHash,
        outcome,
        'requires reconciliation',
      );

      await expect(recordGaslessExecutionFailure(context, failureContext, error)).rejects.toBe(
        error,
      );
      expect(recordExecutionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: outcome,
          executionStatus: outcome,
          txHash: transactionHash,
          metadata: expect.objectContaining({
            recoveryRequired: true,
            rebroadcastAllowed: false,
          }),
        }),
      );
    },
  );

  test('persists a chain revert as terminal rather than a generic failed broadcast', async () => {
    const { context, recordExecutionEvent } = createContext();
    const error = new GaslessTransactionRevertedError(transactionHash, '1234');

    await expect(recordGaslessExecutionFailure(context, failureContext, error)).rejects.toBe(error);
    expect(recordExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'reverted',
        executionStatus: 'reverted',
        txHash: transactionHash,
        metadata: expect.objectContaining({ blockNumber: '1234' }),
      }),
    );
  });
});
