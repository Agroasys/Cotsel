import { assertValidTransition } from '../src/core/payout';

describe('Payout lifecycle transitions', () => {
  test('allows valid transitions', () => {
    expect(() =>
      assertValidTransition('PENDING_REVIEW', 'READY_FOR_EXTERNAL_HANDOFF'),
    ).not.toThrow();
    expect(() =>
      assertValidTransition('READY_FOR_EXTERNAL_HANDOFF', 'AWAITING_EXTERNAL_CONFIRMATION'),
    ).not.toThrow();
    expect(() =>
      assertValidTransition('AWAITING_EXTERNAL_CONFIRMATION', 'EXTERNAL_EXECUTION_CONFIRMED'),
    ).not.toThrow();
  });

  test('blocks invalid transitions', () => {
    expect(() => assertValidTransition('PENDING_REVIEW', 'EXTERNAL_EXECUTION_CONFIRMED')).toThrow(
      'Invalid payout state transition: PENDING_REVIEW -> EXTERNAL_EXECUTION_CONFIRMED',
    );
    expect(() =>
      assertValidTransition('EXTERNAL_EXECUTION_CONFIRMED', 'AWAITING_EXTERNAL_CONFIRMATION'),
    ).toThrow(
      'Invalid payout state transition: EXTERNAL_EXECUTION_CONFIRMED -> AWAITING_EXTERNAL_CONFIRMATION',
    );
  });
});
