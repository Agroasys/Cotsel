/**
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SettlementService } from '../src/core/settlementService';
import type {
  SettlementExecutionStatus,
  SettlementHandoffRecord,
  SettlementStore,
} from '../src/core/settlementStore';
import { GaslessSettlementOutcomeObserver } from '../src/core/gaslessSettlementOutcomeObserver';
import type { GaslessCommandStore } from '../src/core/gaslessCommandStore';
import type { GaslessTransactionOutcomeRecord } from '../src/core/gaslessTransactionOutcomeStore';

const OUTCOME: GaslessTransactionOutcomeRecord = {
  transactionHash: `0x${'a'.repeat(64)}`,
  observedTransactionHash: null,
  applicationRequestId: 'request-crash-window',
  resourceType: 'settlement_handoff',
  resourceId: 'handoff-crash-window',
  operation: 'create_trade',
  chainId: 84532,
  signerAddress: `0x${'1'.repeat(40)}`,
  nonce: 7,
  transactionType: 2,
  destinationAddress: `0x${'2'.repeat(40)}`,
  valueWei: '0',
  gasLimit: '210000',
  maxFeePerGasWei: '2',
  maxPriorityFeePerGasWei: '1',
  gasPriceWei: null,
  calldataHash: `0x${'b'.repeat(64)}`,
  intentHash: `0x${'c'.repeat(64)}`,
  outcomeStatus: 'confirmed',
  projectedOutcomeStatus: null,
  failureCode: null,
  updatedAt: '2026-08-28T00:00:00.000Z',
};

function createObserver(initialStatus: SettlementExecutionStatus) {
  let executionStatus = initialStatus;
  const getHandoff = jest.fn(async () => {
    return {
      executionStatus,
      reconciliationStatus: 'pending',
    } as unknown as SettlementHandoffRecord;
  });
  const recordExecutionEvent = jest.fn(
    async (input: { executionStatus: SettlementExecutionStatus }) => {
      executionStatus = input.executionStatus;
      return {};
    },
  );
  const observer = new GaslessSettlementOutcomeObserver(
    { getHandoff } as unknown as SettlementStore,
    { recordExecutionEvent } as unknown as SettlementService,
    { resolveTransactionOutcome: jest.fn(async () => true) } as unknown as GaslessCommandStore,
    () => new Date('2026-08-28T00:00:01.000Z'),
  );
  return { observer, recordExecutionEvent };
}

describe('gasless settlement outcome projection', () => {
  test('bridges queued state through confirmation-pending after a pre-projection crash', async () => {
    const { observer, recordExecutionEvent } = createObserver('queued');

    await observer.onConfirmed(OUTCOME, {
      blockNumber: '100',
      blockHash: `0x${'d'.repeat(64)}`,
      gasUsed: '210000',
      effectiveGasPriceWei: '2',
    });

    expect(recordExecutionEvent.mock.calls.map(([input]) => input.executionStatus)).toEqual([
      'confirmation_pending',
      'confirmed',
    ]);
  });

  test('does not invent an intermediate event when terminal state is already projected', async () => {
    const { observer, recordExecutionEvent } = createObserver('confirmed');

    await observer.onConfirmed(OUTCOME, {
      blockNumber: '100',
      blockHash: `0x${'d'.repeat(64)}`,
      gasUsed: '210000',
      effectiveGasPriceWei: '2',
    });

    expect(recordExecutionEvent.mock.calls.map(([input]) => input.executionStatus)).toEqual([
      'confirmed',
    ]);
  });
});
