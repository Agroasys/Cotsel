import { assertValidTransition } from '../src/core/payout';

describe('Payout lifecycle transitions', () => {
  test('allows valid transitions', () => {
    expect(() => assertValidTransition('PENDING_REVIEW', 'READY_FOR_PAYOUT')).not.toThrow();
    expect(() => assertValidTransition('READY_FOR_PAYOUT', 'PROCESSING')).not.toThrow();
    expect(() => assertValidTransition('PROCESSING', 'PAID')).not.toThrow();
  });

  test('blocks invalid transitions', () => {
    expect(() => assertValidTransition('PENDING_REVIEW', 'PAID')).toThrow(
      'Invalid payout state transition: PENDING_REVIEW -> PAID',
    );
    expect(() => assertValidTransition('PAID', 'PROCESSING')).toThrow(
      'Invalid payout state transition: PAID -> PROCESSING',
    );
  });
});
