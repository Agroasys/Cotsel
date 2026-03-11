/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { validateExecutionTransition } from '../src/core/settlementStateMachine';

describe('settlement state machine', () => {
  test('reconciliation events cannot mutate execution state', () => {
    expect(() => validateExecutionTransition('confirmed', 'failed', 'reconciled')).toThrow(
      'Reconciliation events cannot mutate settlement execution state',
    );
  });

  test('reconciliation events may preserve confirmed execution state', () => {
    expect(() => validateExecutionTransition('confirmed', 'confirmed', 'reconciled')).not.toThrow();
  });
});
