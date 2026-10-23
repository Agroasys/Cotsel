/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { canTransitionTransactionFinality } from '@agroasys/sdk';
import {
  GASLESS_OUTCOME_FINALITY,
  SETTLEMENT_EXECUTION_FINALITY,
} from '../src/core/settlementFinality';
import {
  EXECUTION_TRANSITIONS,
  validateExecutionTransition,
} from '../src/core/settlementStateMachine';
import { GASLESS_TRANSACTION_OUTCOME_STATUSES } from '../src/core/gaslessTransactionOutcomeStore';
import { SETTLEMENT_EXECUTION_STATUSES } from '../src/core/settlementStoreTypes';

describe('gateway settlement finality conformance', () => {
  test('maps every settlement execution and gasless outcome status', () => {
    expect(Object.keys(SETTLEMENT_EXECUTION_FINALITY).sort()).toEqual(
      [...SETTLEMENT_EXECUTION_STATUSES].sort(),
    );
    expect(Object.keys(GASLESS_OUTCOME_FINALITY).sort()).toEqual(
      [...GASLESS_TRANSACTION_OUTCOME_STATUSES].sort(),
    );
  });

  test('claims finalized success only for the finality-evidenced confirmed status', () => {
    const finalized = Object.entries(SETTLEMENT_EXECUTION_FINALITY)
      .filter(([, position]) => position?.state === 'finalized')
      .map(([status]) => status);
    expect(finalized).toEqual(['confirmed']);
  });

  test('every settlement state machine edge is legal in the shared finality model', () => {
    for (const [current, nextStatuses] of Object.entries(EXECUTION_TRANSITIONS)) {
      for (const next of nextStatuses) {
        const from = SETTLEMENT_EXECUTION_FINALITY[current as keyof typeof EXECUTION_TRANSITIONS];
        const to = SETTLEMENT_EXECUTION_FINALITY[next];
        if (from && to) {
          expect([current, next, canTransitionTransactionFinality(from, to)]).toEqual([
            current,
            next,
            true,
          ]);
        }
      }
    }
  });

  test.each([
    ['broadcast_unknown', 'failed'],
    ['submitted', 'failed'],
    ['submitted', 'rejected'],
    ['confirmation_pending', 'failed'],
  ] as const)('never lets %s be overwritten as never-broadcast %s', (current, next) => {
    expect(() => validateExecutionTransition(current, next, next)).toThrow(
      'Settlement execution event violates the handoff state machine',
    );
  });

  test('still records pre-broadcast failure before any transaction exists', () => {
    for (const current of ['pending', 'accepted', 'queued'] as const) {
      expect(() => validateExecutionTransition(current, 'failed', 'failed')).not.toThrow();
      expect(() => validateExecutionTransition(current, 'rejected', 'rejected')).not.toThrow();
    }
  });
});
