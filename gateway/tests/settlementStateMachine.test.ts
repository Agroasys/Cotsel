/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { validateExecutionTransition } from '../src/core/settlementStateMachine';

describe('settlement state machine', () => {
  test('only the canonicality event can withdraw terminal success into reconciliation', () => {
    expect(() =>
      validateExecutionTransition('confirmed', 'confirmation_pending', 'chain_evidence_orphaned'),
    ).not.toThrow();
    expect(() =>
      validateExecutionTransition('reverted', 'confirmation_pending', 'chain_evidence_orphaned'),
    ).not.toThrow();
    expect(() =>
      validateExecutionTransition('confirmed', 'confirmation_pending', 'confirmation_pending'),
    ).toThrow();
    expect(() =>
      validateExecutionTransition('confirmed', 'submitted', 'chain_evidence_orphaned'),
    ).toThrow();
  });
  test('reconciliation events cannot mutate execution state', () => {
    expect(() => validateExecutionTransition('confirmed', 'failed', 'reconciled')).toThrow(
      'Reconciliation events cannot mutate settlement execution state',
    );
  });

  test('reconciliation events may preserve confirmed execution state', () => {
    expect(() => validateExecutionTransition('confirmed', 'confirmed', 'reconciled')).not.toThrow();
  });
});
